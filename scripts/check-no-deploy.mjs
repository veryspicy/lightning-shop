#!/usr/bin/env node
/**
 * check-no-deploy.mjs — 发布入口守卫（只读检查，不联网）
 *
 * 背景：发布链路已移交 Cloudflare Workers Builds（Worker → 设置 → 构建，
 *      生产分支构建 + 预览构建），GitHub Actions 只承担校验、审核、检查职责。
 *      一旦有人在 workflow 里重新塞回部署/写生产命令，就会出现两套 CI/CD 双写，
 *      生产版本来源不可追溯。本脚本把这条约束变成 CI 里可失败的硬门槛。
 *
 * 用法：
 *   node scripts/check-no-deploy.mjs
 *
 * 命中即 exit 1，并打印文件:行号。
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const WORKFLOWS_DIR = path.resolve(".github/workflows");

// 禁止项分两类：
// A. 发布动作：任何 workflow 都不许出现（发布统一由 Workers Builds 执行）
// B. 写生产业务数据：不许出现；只读查询（d1 export 之外的 list/get）与备份归档放行
const FORBIDDEN = [
  { name: "wrangler deploy", re: /\bwrangler\s+deploy\b/ },
  { name: "wrangler versions upload", re: /\bwrangler\s+versions\s+upload\b/ },
  { name: "wrangler versions deploy", re: /\bwrangler\s+versions\s+deploy\b/ },
  { name: "wrangler secret put/delete", re: /\bwrangler\s+secret\s+(put|delete)\b/ },
  { name: "wrangler preview 部署", re: /\bwrangler\s+preview\b(?!\s+(?:--help|delete\s+--help))/ },
  { name: "npm run deploy", re: /\bnpm\s+run\s+deploy\b/ },
  { name: "d1-migrate 连生产", re: /\bd1-migrate\.mjs\s+[^\n]*--remote\b/ },
  { name: "d1 写生产", re: /\bwrangler\s+d1\s+(execute|import|migrations\s+apply)\b[^\n]*--remote\b/ },
  { name: "kv 写生产", re: /\bwrangler\s+kv\s+(bulk\s+put|key\s+(put|delete))\b[^\n]*--remote\b/ },
  { name: "r2 写入", re: /\bwrangler\s+r2\s+object\s+put\b/ },
  { name: "upload-r2 脚本", re: /\bupload-r2\.mjs\b/ },
  { name: "sync-prod-to-seed 脚本", re: /\bsync-prod-to-seed\.mjs\b/ },
];

// 备份归档例外：backup-d1.yml 允许把导出结果写到 d1-backup/ 前缀（数据安全，非发布）
const BACKUP_EXEMPT = /d1-backup\//;

if (!existsSync(WORKFLOWS_DIR)) {
  console.log("未发现 .github/workflows 目录，跳过");
  process.exit(0);
}

const files = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
const hits = [];

for (const file of files) {
  const full = path.join(WORKFLOWS_DIR, file);
  const lines = readFileSync(full, "utf8").split(/\r?\n/);
  lines.forEach((line, idx) => {
    // 注释行、echo 说明行不算违规证据
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) return;
    for (const rule of FORBIDDEN) {
      // 备份归档路径（d1-backup/）属于数据安全动作，不算发布
      if (rule.name === "r2 写入" && BACKUP_EXEMPT.test(line)) continue;
      if (rule.re.test(line)) {
        hits.push(`${full}:${idx + 1}  [${rule.name}]  ${trimmed}`);
      }
    }
  });
}

if (hits.length > 0) {
  console.error("::error::GitHub Actions 中检测到发布/写生产命令，发布应由 Cloudflare Workers Builds 负责");
  for (const h of hits) console.error(`  ${h}`);
  console.error(`共 ${hits.length} 处违规`);
  process.exit(1);
}

console.log(`发布入口守卫通过：${files.length} 个 workflow 中未出现部署或写生产命令`);
