
# Lightning Shop

私域货盘展示站：Cloudflare Workers + KV + R2，无后端框架，纯静态前端 + Worker API。

## 功能

- 27 个 SKU 货盘展示（蒙降三高低GI杂粮、领柿黄柿子火锅底料、野生苦菜、鑫乐荣坚果玉米与羊杂碎）
- B2B 批发 + 零售双价格展示、阶梯批发提示、起订量标签
- 分类筛选 + 关键词搜索（品名/品牌/卖点）
- 产品图片存 R2，数据存 KV，均通过 Worker 路由

## 项目结构

```
Lightning-shop/
├── wrangler.toml        # Worker + KV + R2 + 静态资源配置
├── src/index.js         # Worker 入口（API + 图片代理 + 静态托管）
├── public/              # 前端（index.html / styles.css / app.js）
├── data/products.json   # 27 个 SKU 种子数据
├── assets/images/       # 产品图（上传到 R2）
├── scripts/             # KV 导入、R2 上传、商品批量导入脚本
└── docs/DESIGN.md       # 设计系统文档
└── docs/OPERATIONS.md   # 操作手册（后台接口/批量导入/生产鉴权）
```

> 完整操作指引（管理后台、批量导入、生产鉴权）见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

## 部署步骤

### 1. 安装依赖

```bash
cd D:\codeRepo\Lightning-shop
npm install
```

### 2. 创建 KV 与 R2

```bash
npx wrangler kv namespace create KV
npx wrangler r2 bucket create lightning-shop-images
```

将返回的 KV `id` / `preview_id` 填入 `wrangler.toml`。

### 3. 导入数据到 KV

```bash
npm run seed
npx wrangler kv:bulk put --binding=KV data/kv-bulk.json
```

### 4. 上传图片到 R2

```bash
npm run upload:images
```

### 5. 本地预览

```bash
npm run dev
```

打开 http://localhost:8787

### 6. 部署上线

```bash
npm run deploy
```

## 管理后台密码配置

后台密码通过**环境变量** `ADMIN_PASSWORD` 注入，不写入代码与配置文件：

- **本地开发**：在 `.dev.vars` 中设置（格式 `ADMIN_PASSWORD = "你的密码"`），该文件已被 `.gitignore` 忽略，不会入库。
- **线上部署**：用 secret 注入加密环境变量，无需出现在 `wrangler.toml`：

  ```bash
  npx wrangler secret put ADMIN_PASSWORD
  ```

  输入密码后回车即可。修改密码只需重新执行上述命令。推荐配合 Cloudflare Access 双保险。

## API

| 路由 | 说明 |
| --- | --- |
| `GET /api/products` | 全部产品，支持 `?category=`、`?q=` 过滤 |
| `GET /api/products/:id` | 单个产品 |
| `GET /api/categories` | 分类及数量 |
| `GET /img/:key` | R2 图片代理 |

## 数据更新

产品数据源为 `data/products.json`（与本地私域货盘表对齐）。更新后重新执行第 3 步即可。

## 商品批量导入技能（product-import）

仓库自带「商品批量导入」Marvis 技能，把表格/CSV/JSON/xlsx/图片/PDF 等任意来源的商品数据稳定导入商品库（幂等 upsert，可重跑）。

技能源码位置：`skills/product-import/`（SKILL.md + references/api_reference.md）；可分发包：`skills/dist/product-import.skill`（zip 格式）。

### 部署到 Marvis

1. **目录方式（推荐）**：把 `skills/product-import/` 整个文件夹复制到 Marvis 技能目录：
   ```
   C:\Users\tank\AppData\Roaming\Tencent\Marvis\User\<user_id>\skills\custom\product-import\
   ```
2. **包方式**：`skills/dist/product-import.skill` 是打包好的分发包（zip），在 Marvis 技能市场中导入/安装该包。
3. 安装后重启 Marvis（或新开会话），让技能索引扫描到新技能。

### 如何喊技能工作

技能按触发词自动启用，直接对 Marvis 说：

- 「把这份表格的商品导入上架」
- 「批量上货，文件在 xxx」
- 「把这张货盘表/图片里的商品录进去」

也可以显式指定：`use_skill(skill_name="product-import", task="导入 D:\xxx.csv 的商品")`。

技能会自动完成：确认来源 → 字段映射 → 校验 → 调脚本导入 → 核对，无需人工口述参数。详细用法见 `skills/product-import/SKILL.md`。
*（内容由AI生成，仅供参考）*
*（内容由AI生成，仅供参考）*
