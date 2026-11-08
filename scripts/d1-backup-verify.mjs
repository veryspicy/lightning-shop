#!/usr/bin/env node
/**
 * d1-backup-verify.mjs — D1 备份快照完整性校验
 *
 * 背景：backup-d1.yml 原来把「必须存在的表」硬编码为 kv_doc/products/orders/order_items/
 *      migration_state，新增表（如 verify_code）不会被纳入校验，备份缺表也发现不了。
 *
 * 机制：断言集合改为「按当前远程库真实表清单动态生成」——远程有哪些表，备份就必须有，
 *      且线上有数据的表，备份里必须有对应 INSERT。新增表无需再改 workflow。
 *
 * 用法：node scripts/d1-backup-verify.mjs <解压后的.sql文件>
 * 环境变量：D1_DATABASE（默认 lightning-shop-db）、CLOUDFLARE_API_TOKEN/ACCOUNT_ID、
 *          VERIFY_API_URL（可选，默认线上 products 接口，用于行数比对）
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const DB = process.env.D1_DATABASE || "lightning-shop-db";
const API_URL = process.env.VERIFY_API_URL || "https://lightning-shop.gora.dpdns.org/api/products";
const sqlFile = process.argv[2];

if (!sqlFile) {
  console.error("::error::用法：node scripts/d1-backup-verify.mjs <备份.sql>");
  process.exit(1);
}

function wrangler(d1Args) {
  const runner = process.platform === "win32" ? "cmd.exe" : "npx";
  const args = process.platform === "win32"
    ? ["/c", "npx", "wrangler", "d1", ...d1Args]
    : ["wrangler", "d1", ...d1Args];
  return execFileSync(runner, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function query(sql) {
  const out = wrangler(["execute", DB, "--remote", "--json", "--command", sql]);
  const start = out.indexOf("[");
  if (start < 0) throw new Error(`无法解析 wrangler 输出：${out.slice(0, 300)}`);
  return JSON.parse(out.slice(start))[0]?.results ?? [];
}

const countInserts = (text, table) => {
  const quoted = (text.match(new RegExp(`INSERT INTO "${table}"`, "g")) || []).length;
  const bare = (text.match(new RegExp(`INSERT INTO ${table}[\\s(]`, "gi")) || []).length;
  return Math.max(quoted, bare);
};

const hasCreateTable = (text, table) =>
  new RegExp(`CREATE TABLE[^;]*\\b${table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);

async function main() {
  const dump = readFileSync(sqlFile, "utf8");
  console.log(`备份文件：${sqlFile}（${statSync(sqlFile).size} 字节）`);

  // 断言集合来自远程真实结构：远程有 = 备份必须有
  const tables = query(
    `SELECT name FROM sqlite_master WHERE type='table' ` +
      `AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`
  ).map((r) => r.name);
  if (!tables.length) throw new Error("远程库表清单为空，无法校验");
  console.log(`远程表清单（${tables.length}）：${tables.join(", ")}`);

  const errors = [];
  const rows = [];

  for (const t of tables) {
    const online = query(`SELECT COUNT(*) AS c FROM "${t}"`)[0]?.c ?? 0;
    const backedUp = countInserts(dump, t);
    const created = hasCreateTable(dump, t);

    if (!created) errors.push(`备份缺少表结构 ${t}`);
    if (online > 0 && backedUp <= 0) errors.push(`备份内 ${t} 无数据行（线上 ${online} 行）`);
    if (online > 0 && backedUp > 0 && backedUp !== online) {
      console.log(`::warning::${t} 备份行数(${backedUp}) 与线上(${online}) 不一致，请核对是否导出截断`);
    }
    rows.push({ 表: t, 线上行数: online, 备份行数: backedUp, 结构: created ? "OK" : "缺失" });
  }

  console.table(rows);

  // 保留原先的 products 与线上 API 对账
  const products = rows.find((r) => r.表 === "products");
  if (products) {
    try {
      const res = await fetch(API_URL, { headers: { "user-agent": "d1-backup-verify" } });
      const body = await res.text();
      const onlineApi = (body.match(/"id"/g) || []).length;
      console.log(`线上 API products 条数：${onlineApi}`);
      if (onlineApi > 0 && products.备份行数 !== onlineApi) {
        console.log(
          `::warning::备份 products 行数(${products.备份行数}) 与线上接口条数(${onlineApi}) 不一致，请人工核对`
        );
      } else if (onlineApi > 0) {
        console.log(`::notice::备份 products 行数与线上接口一致（${products.备份行数}）`);
      }
    } catch (err) {
      console.log(`::warning::线上接口比对跳过：${err.message.split("\n")[0]}`);
    }
  }

  if (errors.length) {
    errors.forEach((e) => console.error(`::error::${e}`));
    process.exit(1);
  }
  console.log(`::notice::备份完整性校验通过（${tables.length} 张表全部命中）`);
}

main().catch((err) => {
  console.error(`::error::备份校验失败：${err.message}`);
  process.exit(1);
});
