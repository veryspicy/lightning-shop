/**
 * 产品补图标准脚本（Lightning-shop）
 *
 * 标准 SOP：图片 → POST /api/upload（base64 上传 R2）→ 生成 {name, brand, image} →
 *          POST /api/admin/products/import（按 name+brand 幂等 upsert 回写 image 字段）
 *
 * 用法：
 *   node scripts/upload-product-images.mjs \
 *     --dir <图片目录> --mapping <映射json> \
 *     --base-url <url> [--token <x-admin-token> | 环境变量 ADMIN_TOKEN] \
 *     [--header "K:V"] [--access-id <id> --access-secret <secret>] \
 *     [--dry-run] [--force]
 *
 * --mapping JSON 结构（数组）：
 *   [{ "name": "产品名", "brand": "品牌", "file": "p29.jpg" }]
 *   file 为图片文件名，相对 --dir；image 字段由脚本自动生成 /img/<file>
 *
 * 安全行为：
 *   - 默认 dry-run：只做可用性预检（域名可达 / token 有效 / 映射产品存在 / 图片文件存在），不写数据
 *   - 确认无误后加 --force 才真正上传与回写；--dry-run 与 --force 同时给出时以 --force 为准
 */
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * HTTP 传输层（Windows PowerShell 子进程）
 * Cloudflare 拦截 Node fetch / curl 的 TLS 指纹与默认 UA（fetch failed / 403），
 * 实测仅 PowerShell Invoke-RestMethod 可直通生产域名，因此统一走 PS 传输。
 */
function psQuote(s) {
  return String(s).replace(/'/g, "''");
}

function psRequest(url, { method = 'GET', token, extraHeaders = {}, bodyJson } = {}) {
  const ps = [];
  ps.push(`$ErrorActionPreference='Stop'`);
  let tmpFile = null;
  if (bodyJson !== undefined) {
    // base64 图片 JSON 可能远超 Windows 命令行长度上限（~32KB），一律写临时文件再读
    tmpFile = join(__dirname, '..', 'temp', `upload-body-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(tmpFile, bodyJson, 'utf8');
    ps.push(`$bodyRaw = [IO.File]::ReadAllText('${psQuote(tmpFile)}', [Text.Encoding]::UTF8); $body = [Text.Encoding]::UTF8.GetBytes($bodyRaw); Remove-Item '${psQuote(tmpFile)}' -ErrorAction SilentlyContinue`);
  }
  const hdr = {};
  if (token) hdr['x-admin-token'] = token;
  Object.assign(hdr, extraHeaders);
  if (Object.keys(hdr).length) {
    const pairs = Object.entries(hdr).map(([k, v]) => `'${psQuote(k)}'='${psQuote(v)}'`).join(';');
    ps.push(`$h = @{ ${pairs} }`);
  } else {
    ps.push(`$h = @{}`);
  }
  const bodyArg = bodyJson !== undefined
    ? " -Body $body -ContentType 'application/json; charset=utf-8'"
    : '';
  ps.push(`$r = Invoke-RestMethod -Uri '${psQuote(url)}' -Method ${method} -Headers $h${bodyArg} -TimeoutSec 90`);
  ps.push(`if ($null -eq $r) { '' } else { $r | ConvertTo-Json -Depth 12 -Compress }`);
  const script = ps.join('; ');
  const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  const out = (res.stdout || '').trim();
  if (res.status !== 0 || !out) {
    const errText = ((res.stderr || '').trim() || `powershell exit ${res.status}`);
    const is401 = /401|Unauthorized/i.test(errText);
    const isNet = /Unable to connect|connect|DNS|name resolution/i.test(errText);
    throw new Error(is401 ? 'HTTP 401（x-admin-token 无效，生产密码独立于本地 .dev.vars）' : isNet ? `连接失败：${errText}` : errText);
  }
  let data = null;
  try {
    data = JSON.parse(out);
  } catch {
    data = out;
  }
  return { ok: true, status: 200, data };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        args[k] = true;
      } else {
        args[k] = v;
        i++;
      }
    }
  }
  return args;
}

function loadMapping(file) {
  const raw = readFileSync(file, 'utf8');
  const data = JSON.parse(raw.replace(/^\uFEFF/, ''));
  const arr = Array.isArray(data) ? data : data.products;
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('映射 JSON 必须是非空数组');
  for (const row of arr) {
    if (!row.name || !row.brand || !row.file) {
      throw new Error(`映射行缺少 name/brand/file：${JSON.stringify(row)}`);
    }
  }
  return arr;
}

async function httpJson(url, { method = 'GET', token, extraHeaders = {}, body } = {}) {
  return psRequest(url, {
    method,
    token,
    extraHeaders,
    bodyJson: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const imgDir = args.dir;
  const mappingFile = args.mapping;
  const baseUrl = (args['base-url'] || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const token = args.token || process.env.ADMIN_TOKEN;
  const force = !!args.force;
  const extraHeaders = {};
  if (args['access-id'] && args['access-secret']) {
    extraHeaders['CF-Access-Client-Id'] = args['access-id'];
    extraHeaders['CF-Access-Client-Secret'] = args['access-secret'];
  }

  if (!imgDir || !mappingFile) {
    console.error('缺少 --dir 或 --mapping');
    console.error('用法见脚本头部注释');
    process.exit(2);
  }
  if (!token) {
    console.error('缺少 x-admin-token：请用 --token 或环境变量 ADMIN_TOKEN');
    process.exit(2);
  }

  const mapping = loadMapping(mappingFile);
  console.log(`映射 ${mapping.length} 条，图片目录 ${imgDir}，目标 ${baseUrl}`);

  // ============ 事前可用性预检 ============
  console.log('\n[预检]');
  const issues = [];

  // 1. 域名可达
  try {
    const r = await httpJson(`${baseUrl}/api/products`);
    if (!r.ok) issues.push(`GET /api/products 不可达：HTTP ${r.status}`);
    else console.log(`  域名可达（/api/products HTTP ${r.status}）`);
  } catch (e) {
    issues.push(`域名可达性检查失败：${e.message}`);
  }

  // 2. token 有效性（GET /api/admin/products）
  try {
    const r = await httpJson(`${baseUrl}/api/admin/products`, { token, extraHeaders });
    if (!r.ok) issues.push(`x-admin-token 无效：HTTP ${r.status}（生产密码独立于本地 .dev.vars）`);
    else console.log(`  x-admin-token 有效（管理接口 HTTP ${r.status}）`);
  } catch (e) {
    issues.push(`管理接口检查失败：${e.message}`);
  }

  // 3. 图片文件存在
  const missingFiles = mapping.filter((m) => !existsSync(join(imgDir, m.file)));
  if (missingFiles.length) {
    issues.push(`图片文件缺失 ${missingFiles.length} 个：${missingFiles.map((m) => m.file).join(', ')}`);
  } else {
    console.log(`  图片文件齐全（${mapping.length} 个）`);
  }

  // 4. 目标产品存在（对 token 检查通过时执行）
  let adminProducts = null;
  if (!issues.some((x) => x.startsWith('x-admin-token') || x.startsWith('管理接口'))) {
    const r = await httpJson(`${baseUrl}/api/admin/products`, { token, extraHeaders });
    if (r.ok && Array.isArray(r.data)) {
      adminProducts = r.data;
      const missing = mapping.filter(
        (m) => !adminProducts.some((p) => p.name === m.name && p.brand === m.brand),
      );
      if (missing.length) {
        issues.push(
          `以下映射在产品库中不存在（将新建而非回写）：${missing.map((m) => m.name).join('; ')}`,
        );
      } else {
        console.log(`  全部 ${mapping.length} 条 name+brand 在产品库存在，将按 upsert 回写`);
      }
    }
  }

  // 5. /api/upload 接口可用性（OPTIONS 或空 filename 探测太冒险，仅确认域名可用即可）

  if (issues.length) {
    console.log('\n[预检未通过，终止]');
    for (const x of issues) console.log(`  - ${x}`);
    process.exit(1);
  }
  console.log('[预检通过]\n');

  if (!force) {
    console.log('当前为 dry-run 模式，未执行任何上传/回写。');
    console.log('确认无误后加 --force 执行：node scripts/upload-product-images.mjs --dir ... --mapping ... --force');
    process.exit(0);
  }

  // ============ 执行：1. 逐张上传 /api/upload ============
  console.log('[1/2] 上传图片到 R2（POST /api/upload）...');
  const upsertRows = [];
  for (const m of mapping) {
    const filePath = join(imgDir, m.file);
    const b64 = readFileSync(filePath).toString('base64');
    const r = await httpJson(`${baseUrl}/api/upload`, {
      method: 'POST',
      token,
      extraHeaders,
      body: { filename: m.file, base64: b64 },
    });
    if (!r.ok) {
      console.error(`  ${m.file} 上传失败：HTTP ${r.status} ${JSON.stringify(r.data)}`);
      process.exit(1);
    }
    const image = r.data && (r.data.url || r.data.path || r.data.image || r.data.key);
    if (!image) {
      console.error(`  ${m.file} 上传返回缺少 url/path/image/key：${JSON.stringify(r.data)}`);
      process.exit(1);
    }
    upsertRows.push({ name: m.name, brand: m.brand, image: image.startsWith('/') ? image : `/${image}` });
    console.log(`  ${m.file} -> ${image}`);
  }

  // ============ 执行：2. import upsert 回写 image ============
  console.log('[2/2] 回写 image 字段（POST /api/admin/products/import）...');
  const r = await httpJson(`${baseUrl}/api/admin/products/import`, {
    method: 'POST',
    token,
    extraHeaders,
    body: { products: upsertRows },
  });
  console.log(`  回执：${JSON.stringify(r.data)}`);
  if (!r.ok) {
    console.error(`import 失败：HTTP ${r.status}`);
    process.exit(1);
  }
  if (r.data.errors && r.data.errors.length) {
    console.warn(`  存在 ${r.data.errors.length} 条错误：`, JSON.stringify(r.data.errors));
  }
  console.log('完成。请按 skill 验收步骤用 GET /api/admin/products 与 GET /api/products 双重核验。');
}

main().catch((e) => {
  console.error('执行失败：', e);
  process.exit(1);
});
