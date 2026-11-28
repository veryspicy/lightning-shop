#!/usr/bin/env node
/**
 * 静态资源版本参数守卫（app.js / styles.css）
 *
 * 背景：index.html 以 ?v=<内容指纹> 引用 /app.js 与 /styles.css。Cloudflare 对这些 URL
 * 下发 `cache-control: public, max-age=31536000, immutable`，URL 不变就一年不改缓存。
 * 一旦源码更新但 v 没同步，老访客与边缘节点会长期继续跑旧脚本，线上表现是「改了但没生效」。
 *
 * 规则：v 值必须等于对应文件 sha256 的前 8 位十六进制。
 * 用法：
 *   node scripts/check-asset-version.mjs          # 校验，不一致则退出码 1
 *   node scripts/check-asset-version.mjs --fix    # 直接把 index.html 的 v 改成当前指纹
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const INDEX = path.join(ROOT, 'public', 'index.html');
const ASSETS = [
  { url: '/app.js', file: 'public/app.js' },
  { url: '/styles.css', file: 'public/styles.css' },
];
const FIX = process.argv.includes('--fix');

const sha8 = (p) => createHash('sha256').update(readFileSync(path.join(ROOT, p))).digest('hex').slice(0, 8);

let html = readFileSync(INDEX, 'utf8');
let bad = 0;

for (const a of ASSETS) {
  const expected = sha8(a.file);
  const re = new RegExp(`${a.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?v=([A-Za-z0-9]+)`);
  const m = html.match(re);
  if (!m) {
    console.error(`✗ index.html 中找不到 ${a.url}?v=... 引用`);
    bad += 1;
    continue;
  }
  if (m[1] === expected) {
    console.log(`✓ ${a.url}?v=${m[1]} 与 ${a.file} 内容一致`);
    continue;
  }
  if (FIX) {
    html = html.replace(re, `${a.url}?v=${expected}`);
    console.log(`↻ ${a.url} 版本参数 ${m[1]} → ${expected}`);
  } else {
    console.error(`✗ ${a.url} 版本参数 ${m[1]} 已过期，${a.file} 当前指纹为 ${expected}`);
    bad += 1;
  }
}

if (FIX && bad === 0) {
  writeFileSync(INDEX, html);
  console.log('index.html 已更新');
  process.exit(0);
}

if (bad > 0) {
  console.error('\n静态资源内容已变更但版本参数没跟上：老访客会被 immutable 缓存钉在旧脚本上。');
  console.error('执行 `node scripts/check-asset-version.mjs --fix` 修正后随同本次改动一起提交。');
  process.exit(1);
}
console.log('静态资源版本参数校验通过');
