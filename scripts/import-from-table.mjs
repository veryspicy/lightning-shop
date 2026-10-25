#!/usr/bin/env node
/**
 * Lightning-shop 商品批量导入脚本
 * 读取表格（CSV UTF-8 / JSON）→ 字段映射校验 → 分批调用 POST /api/admin/products/import
 *
 * 用法：
 *   node scripts/import-from-table.mjs --file path/to/table.csv [--token x-admin-token]
 *   node scripts/import-from-table.mjs --json path/to/products.json [--token x-admin-token]
 *   node scripts/import-from-table.mjs --file table.csv --mapping "品名:name,品牌:brand" --base-url http://127.0.0.1:8787
 *   node scripts/import-from-table.mjs --file table.csv --header "CF-Access-Client-Id:xxx" --header "CF-Access-Client-Secret:yyy"
 *   node scripts/import-from-table.mjs --file table.csv --access-id xxx --access-secret yyy
 *
 * 说明：
 *   - CSV 第一行为表头；JSON 为数组，元素为对象。
 *   - 默认内置常见中文表头映射（见 DEFAULT_MAPPING），可用 --mapping 覆盖/追加（, 分隔，冒号分隔列名与字段名）。
 *   - 按 name+brand 幂等 upsert：同一份表可安全重跑，已存在的商品只更新传入列。
 *   - 逐行校验：品名缺失或无效的行会进入 errors 明细，不中断整批导入。
 *   - 分批（默认 50 条/批）调用，汇总 imported / updated / errors 回执。
 *   - 鉴权：x-admin-token 用 --token 或环境变量 ADMIN_TOKEN；Cloudflare Access 服务 token 用 --access-id/--access-secret 或 --header "k:v"（可重复）。
 *   - xlsx 请先转 CSV（UTF-8）后导入；本脚本不引入第三方依赖。
 */

import { readFile } from 'node:fs/promises';

const DEFAULT_MAPPING = {
  品名: 'name', 名称: 'name', 商品名称: 'name', 货品名称: 'name',
  品牌: 'brand',
  分类: 'category', 类目: 'category', 品类: 'category',
  规格: 'spec', 规格型号: 'spec',
  批发价: 'wholesale_price', 出厂价: 'wholesale_price', 供货价: 'wholesale_price',
  零售价: 'retail_price', 建议零售价: 'retail_price', 售价: 'retail_price',
  价格备注: 'price_note', 价格说明: 'price_note',
  起订量: 'moq', 最小起订量: 'moq', MOQ: 'moq', moq: 'moq',
  核心卖点: 'highlights', 卖点: 'highlights', 亮点: 'highlights', 描述: 'highlights',
  储存方式: 'storage', 储存: 'storage', 保存方式: 'storage',
  保质期: 'shelf_life', 有效期: 'shelf_life',
  认证: 'cert', 背书: 'cert', 资质: 'cert', 认证资质: 'cert',
  角标: 'badge', 标签: 'badge',
  图片: 'image', 图片地址: 'image', 主图: 'image',
  状态: 'status', 上下架: 'status',
};

const FIELD_NAMES = new Set([
  'name', 'brand', 'category', 'spec', 'wholesale_price', 'retail_price',
  'price_note', 'moq', 'highlights', 'storage', 'shelf_life', 'cert', 'badge',
  'image', 'status',
]);

const BATCH_SIZE = 50;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (key === 'header') {
        args.header = args.header || [];
        if (val !== undefined && !val.startsWith('--')) {
          args.header.push(val);
          i++;
        }
      } else {
        args[key] = val !== undefined && !val.startsWith('--') ? val : true;
        if (val !== undefined && !val.startsWith('--')) i++;
      }
    }
  }
  return args;
}

function parseCsv(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => {
      const v = (cells[i] ?? '').trim();
      if (v !== '') row[h] = v;
    });
    return row;
  });
}

function splitCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

function buildMapping(extra) {
  const map = { ...DEFAULT_MAPPING };
  if (extra) {
    for (const pair of String(extra).split(',')) {
      const [k, v] = pair.split(':').map((s) => s.trim());
      if (k && v) map[k] = v;
    }
  }
  return map;
}

function toRow(record, mapping) {
  const row = {};
  for (const [col, field] of Object.entries(mapping)) {
    if (record[col] !== undefined && record[col] !== null) {
      const v = String(record[col]).trim();
      if (v !== '') row[field] = v;
    }
  }
  // 兼容 JSON 已用字段名的输入：白名单字段直接透传
  for (const k of Object.keys(record)) {
    if (FIELD_NAMES.has(k) && record[k] !== undefined && record[k] !== null) {
      const v = String(record[k]).trim();
      if (v !== '') row[k] = v;
    }
  }
  return row;
}

function buildExtraHeaders(args) {
  const headers = {};
  if (args['access-id'] && args['access-secret']) {
    headers['CF-Access-Client-Id'] = args['access-id'];
    headers['CF-Access-Client-Secret'] = args['access-secret'];
  }
  for (const h of args.header || []) {
    const idx = h.indexOf(':');
    if (idx > 0) {
      const k = h.slice(0, idx).trim();
      const v = h.slice(idx + 1).trim();
      if (k && v) headers[k] = v;
    } else {
      console.warn(`忽略非法 header: ${h}（格式应为 "K:V"）`);
    }
  }
  return headers;
}

async function callImport(rows, baseUrl, token, extraHeaders = {}) {
  const res = await fetch(`${baseUrl}/api/admin/products/import`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-admin-token': token } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify({ products: rows }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args['base-url'] || 'http://127.0.0.1:8787';
  const token = args.token || process.env.ADMIN_TOKEN || '';
  const file = args.file || args.json || args.f;
  if (!file) {
    console.error('用法: node scripts/import-from-table.mjs --file <csv> | --json <json> [--token <x-admin-token>] [--base-url <url>] [--mapping "列:字段,..."]');
    process.exit(2);
  }

  const text = (await readFile(file, 'utf-8')).replace(/^\uFEFF/, '');
  let records;
  if (file.toLowerCase().endsWith('.json')) {
    records = JSON.parse(text);
    if (!Array.isArray(records)) {
      console.error('JSON 必须是数组（商品对象列表）');
      process.exit(2);
    }
  } else {
    records = parseCsv(text);
  }

  const mapping = buildMapping(args.mapping);
  const rows = records.map((r) => toRow(r, mapping));
  const total = rows.length;
  if (!total) {
    console.log('无有效数据行，跳过');
    return;
  }

  const imported = [];
  const updated = [];
  const errors = [];
  const extraHeaders = buildExtraHeaders(args);
  for (let i = 0; i < total; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const res = await callImport(chunk, baseUrl, token, extraHeaders);
    imported.push(...res.imported ? new Array(res.imported).fill(0) : []);
    updated.push(...res.updated ? new Array(res.updated).fill(0) : []);
    if (res.errors) {
      for (const e of res.errors) errors.push({ batch: Math.floor(i / BATCH_SIZE) + 1, ...e });
    }
    console.log(`批 ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(total / BATCH_SIZE)}: 新增 ${res.imported}, 更新 ${res.updated}, 错误 ${res.errors?.length ?? 0}`);
  }

  console.log(`\n导入完成: 共 ${total} 行 → 新增 ${imported.length} / 更新 ${updated.length} / 错误 ${errors.length}`);
  if (errors.length) {
    console.log('错误明细:');
    for (const e of errors) console.log(`  [批${e.batch} 行${e.index}] ${e.message}`);
  }
}

main().catch((err) => {
  console.error('导入失败:', err.message || err);
  process.exit(1);
});
