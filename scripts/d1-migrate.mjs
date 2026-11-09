#!/usr/bin/env node
/**
 * d1-migrate.mjs — D1 迁移执行器（幂等 + 存量库基线登记）
 *
 * 背景：deploy.yml 过去只 build+deploy，不打 migrations/*.sql，发版含迁移时只能手工
 *      `wrangler d1 execute --remote --file ...`，容易漏执行导致新代码读不到新表/新列。
 *
 * 机制：
 *   1. 账本表 _d1_migrations(name PK, checksum, applied_at, baseline) 记录已应用迁移。
 *   2. 已登记且文件未变 → 跳过；已登记但文件被改 → 报错中止（防止已上线迁移被偷偷改）。
 *   3. 未登记时先看文件头 `-- d1-baseline-when: <SQL>`：该 SQL 能查到行说明生产结构
 *      已存在（历史手工执行过），登记为 baseline 而不重放 SQL（避免 ALTER 重复报错）。
 *   4. 其余按文件名升序逐个 `wrangler d1 execute --file`，成功后写账本。
 *
 * 用法：
 *   node scripts/d1-migrate.mjs --remote            # 生产库（CI 用）
 *   node scripts/d1-migrate.mjs --remote --dry-run  # 只打印计划，不执行不写账本
 *   node scripts/d1-migrate.mjs --local             # 本地 D1
 *
 * 环境变量：D1_DATABASE（默认 lightning-shop-db）、CLOUDFLARE_API_TOKEN / ACCOUNT_ID（--remote 必需）、
 *          D1_WRANGLER_EXTRA_ARGS（透传给 wrangler d1，如 CI 的 "--persist-to .wrangler/ci-state"）
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DB = process.env.D1_DATABASE || "lightning-shop-db";
const MIGRATIONS_DIR = path.resolve("migrations");
const LEDGER = "_d1_migrations";
const EXTRA_ARGS = (process.env.D1_WRANGLER_EXTRA_ARGS || "")
  .trim()
  .split(/\s+/)
  .filter(Boolean)
  .map((a) => a.replace(/^["']|["']$/g, ""));

const argv = new Set(process.argv.slice(2));
const target = argv.has("--local") ? "--local" : "--remote";
const dryRun = argv.has("--dry-run");

function wrangler(d1Args) {
  const full = [...d1Args, ...EXTRA_ARGS];
  const runner = process.platform === "win32" ? "cmd.exe" : "npx";
  const args = process.platform === "win32"
    ? ["/c", "npx", "wrangler", "d1", ...full]
    : ["wrangler", "d1", ...full];
  return execFileSync(runner, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function query(sql) {
  const out = wrangler(["execute", DB, target, "--json", "--command", sql]);
  const start = out.indexOf("[");
  if (start < 0) throw new Error(`无法解析 wrangler 输出：${out.slice(0, 300)}`);
  const parsed = JSON.parse(out.slice(start));
  return parsed[0]?.results ?? [];
}

const esc = (v) => String(v).replace(/'/g, "''");
const checksumOf = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

function ensureLedger() {
  query(
    `CREATE TABLE IF NOT EXISTS ${LEDGER} (` +
      `name TEXT PRIMARY KEY, ` +
      `checksum TEXT NOT NULL, ` +
      `applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), ` +
      `baseline INTEGER NOT NULL DEFAULT 0)`
  );
}

function record(name, checksum, isBaseline) {
  query(
    `INSERT INTO ${LEDGER} (name, checksum, baseline) VALUES ('${esc(name)}', '${esc(checksum)}', ${isBaseline ? 1 : 0}) ` +
      `ON CONFLICT(name) DO UPDATE SET checksum=excluded.checksum, baseline=excluded.baseline, ` +
      `applied_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  );
}

function main() {
  if (!readdirSync(MIGRATIONS_DIR).length) throw new Error(`迁移目录为空：${MIGRATIONS_DIR}`);
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  if (!files.length) throw new Error(`迁移目录下没有 .sql：${MIGRATIONS_DIR}`);

  const ledgerExists = query(
    `SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='${LEDGER}'`
  ).length > 0;
  const applied = new Map(
    (ledgerExists ? query(`SELECT name, checksum, baseline FROM ${LEDGER}`) : []).map((r) => [
      r.name,
      r,
    ])
  );

  if (!dryRun) ensureLedger();

  const summary = { skipped: 0, baselined: 0, executed: 0, failed: 0 };
  const conflicts = [];

  for (const name of files) {
    const full = path.join(MIGRATIONS_DIR, name);
    const sql = readFileSync(full, "utf8");
    const checksum = checksumOf(sql);
    const rec = applied.get(name);

    if (rec) {
      if (rec.checksum !== checksum) {
        conflicts.push(`${name}：已登记 checksum=${rec.checksum}，当前文件=${checksum}`);
        continue;
      }
      summary.skipped++;
      console.log(`[skip]     ${name}（账本已记录）`);
      continue;
    }

    const baselineWhen = sql.match(/^\s*--\s*d1-baseline-when:\s*(.+)$/m)?.[1]?.trim();
    if (baselineWhen) {
      let hit = false;
      try {
        hit = query(baselineWhen).length > 0;
      } catch (err) {
        console.log(`[warn]     ${name} 基线探测失败（按未应用处理）：${err.message.split("\n")[0]}`);
      }
      if (hit) {
        summary.baselined++;
        console.log(`[baseline] ${name}（生产结构已存在，登记为基线不重放）`);
        if (!dryRun) record(name, checksum, true);
        continue;
      }
    }

    if (dryRun) {
      summary.executed++;
      console.log(`[plan]     ${name}（将执行 ${target}）`);
      continue;
    }

    try {
      wrangler(["execute", DB, target, "--file", full]);
      record(name, checksum, false);
      summary.executed++;
      console.log(`[applied]  ${name}`);
    } catch (err) {
      summary.failed++;
      console.error(`[failed]   ${name}\n${err.stderr || err.message}`);
    }
  }

  console.log(
    `\n迁移汇总（${DB} ${target}${dryRun ? " dry-run" : ""}）：` +
      `执行 ${summary.executed} / 基线 ${summary.baselined} / 跳过 ${summary.skipped} / 失败 ${summary.failed}`
  );

  if (conflicts.length) {
    conflicts.forEach((c) => console.error(`::error::已应用迁移文件被修改：${c}`));
  }
  if (summary.failed || conflicts.length) process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(`::error::D1 迁移失败：${err.message}`);
  process.exit(1);
}
