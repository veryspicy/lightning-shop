/**
 * KV 批量导入脚本
 * 用法：npm run seed
 * 前置：先部署 KV namespace 并把 ID 填入 wrangler.toml
 * 生成 data/kv-bulk.json，然后执行：
 *   npx wrangler kv:bulk put --binding=KV data/kv-bulk.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const products = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'products.json'), 'utf-8'));

const CATEGORY_ORDER = ['低GI杂粮', '营养粮油', '黄柿子火锅底料', '野生苦菜', '坚果玉米', '羊杂碎'];

const bulk = [
  { key: 'products', value: JSON.stringify(products) },
  { key: 'config:categories', value: JSON.stringify(CATEGORY_ORDER) },
  ...products.map((p) => ({ key: `products:${p.id}`, value: JSON.stringify(p) })),
];

const out = join(__dirname, '..', 'data', 'kv-bulk.json');
writeFileSync(out, JSON.stringify(bulk, null, 2));
console.log(`已生成 ${out}（${products.length} 个 SKU，共 ${bulk.length} 条 KV 记录）`);
console.log('下一步：npx wrangler kv:bulk put --binding=KV data/kv-bulk.json');
