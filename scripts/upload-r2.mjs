/**
 * R2 图片上传脚本
 * 用法：npm run upload:images
 * 前置：创建 R2 bucket（lightning-shop-images）并把 bucket 名填入 wrangler.toml
 * 将 assets/images/ 下所有文件上传到 R2，产品图 key 与产品 JSON 中 image 字段一致（/img/p01.jpg -> key p01.jpg）
 */
import { execSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imgDir = join(__dirname, '..', 'assets', 'images');

if (!existsSync(imgDir)) {
  console.log('assets/images 不存在，跳过图片上传（图片已由 R2/KV 服务）');
  process.exit(0);
}

const files = readdirSync(imgDir).filter((f) => !f.startsWith('.') && statSync(join(imgDir, f)).isFile());

if (files.length === 0) {
  console.log('assets/images 为空，先放入产品图再上传');
  process.exit(0);
}

for (const f of files) {
  const key = f;
  const cmd = `npx wrangler r2 object put lightning-shop-images/${key} --file="${join(imgDir, f)}"`;
  console.log(`上传 ${f} ...`);
  execSync(cmd, { stdio: 'inherit' });
}
console.log(`完成：共上传 ${files.length} 张图片到 R2 bucket lightning-shop-images`);
