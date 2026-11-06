/**
 * sync-prod-to-seed.mjs
 * 将生产 KV 当前全量产品数据同步写回 data/products.json（seed 数据源）。
 * 用途：部署前置步骤，保证 CI seed 数据 = 生产最新状态，seed 覆盖不再丢失后台增量修改。
 *
 * 传输层：spawn PowerShell Invoke-WebRequest（CF 仅放行 PS 默认 UA），原始响应落临时文件，
 *         Node 负责解析/排序/写回（规避 PS5.1 ConvertTo-Json 中文转义问题）。
 *
 * 用法：
 *   node scripts/sync-prod-to-seed.mjs [--base-url <url>] [--token <x-admin-token>]
 *   token 优先取环境变量 ADMIN_TOKEN；默认 https://lightning-shop.gora.dpdns.org / Tandong@0917
 *
 * 输出（供 CI / 调用方判断）：
 *   SKIP=1   生产不可达或返回空（首次部署等场景）——本次不写文件，调用方应直接用仓库 seed 数据继续
 *   CHANGED=0 同步后与仓库一致，无需提交
 *   CHANGED=1 同步后检测到增量，已写入 data/products.json（后续 seed 将基于最新数据生成）
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const target = join(repoRoot, 'data', 'products.json');
const tempDir = join(repoRoot, 'temp');
const tmpResp = join(tempDir, 'prod-sync-response.json');

let baseUrl = 'https://lightning-shop.gora.dpdns.org';
let token = process.env.ADMIN_TOKEN || 'Tandong@0917';
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--base-url' && args[i + 1]) { baseUrl = args[i + 1]; i++; }
  if (args[i] === '--token' && args[i + 1]) { token = args[i + 1]; i++; }
}

mkdirSync(tempDir, { recursive: true });

// 1. 拉取生产全量：Windows 本地优先 PowerShell（CF 放行 PS 默认 UA）；
//    Linux CI（GitHub Actions ubuntu 无 PowerShell）兜底用 Node fetch + 浏览器 UA
const psScript = [
  `$ErrorActionPreference='Stop'`,
  `$r = Invoke-WebRequest -Uri '${baseUrl}/api/admin/products' -Headers @{ 'x-admin-token' = '${token.replace(/'/g, "''")}' } -UseBasicParsing -OutFile '${tmpResp.replace(/'/g, "''")}'`,
].join('; ');

let prod;
const psOk = spawnSync('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' }).status === 0;
if (psOk) {
  const ps = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
    encoding: 'utf8',
    timeout: 60000,
  });
  if (ps.status === 0) {
    try {
      prod = JSON.parse(readFileSync(tmpResp, 'utf8'));
    } catch (e) {
      console.warn('[sync-prod-to-seed] PS 响应解析失败:', e.message);
    }
  } else {
    console.warn('[sync-prod-to-seed] PowerShell 拉取失败:', ps.stderr || ps.stdout || `exit=${ps.status}`);
  }
}
if (!prod) {
  try {
    const resp = await fetch(`${baseUrl}/api/admin/products`, {
      headers: {
        'x-admin-token': token,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(60000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    prod = await resp.json();
  } catch (e) {
    console.warn(`[sync-prod-to-seed] 生产不可达（${baseUrl}），跳过同步，继续使用仓库 seed 数据`);
    console.warn('[sync-prod-to-seed] 详情:', e.message);
    rmSync(tmpResp, { force: true });
    console.log('SKIP=1');
    process.exit(0);
  }
}
if (!Array.isArray(prod) || prod.length === 0) {
  console.warn('[sync-prod-to-seed] 生产 API 返回 0 条（首次部署等场景），跳过同步，继续使用仓库 seed 数据');
  rmSync(tmpResp, { force: true });
  console.log('SKIP=1');
  process.exit(0);
}
const sorted = [...prod].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

// 3. 写回 data/products.json（UTF-8 无 BOM，2 空格缩进，末尾换行与原文件一致）
writeFileSync(target, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
rmSync(tmpResp, { force: true });

// 4. 差异摘要
const diff = spawnSync('git', ['-C', repoRoot, 'diff', '--stat', '--', 'data/products.json'], { encoding: 'utf8' });
const diffOut = (diff.stdout || '').trim();
console.log(`[sync-prod-to-seed] 同步完成：${sorted.length} 条 → data/products.json`);
if (!diffOut) {
  console.log('[sync-prod-to-seed] 与仓库当前版本一致，无需提交');
  console.log('CHANGED=0');
} else {
  console.log('[sync-prod-to-seed] 检测到差异：');
  console.log(diffOut);
  console.log('CHANGED=1');
}
