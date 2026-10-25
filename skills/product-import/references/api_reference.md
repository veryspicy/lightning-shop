---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 14f48488fead00d28e11c31f9845685c_630b3eb3d07c11f1acb8525400638852
    ReservedCode1: wFihlLTpCmfJmgqVPOMrYr8TyWIqgeH/6YvGFVKKsoACXdent0T9iLOnFxbvGMLbp3rdhrHdWq8DD5TW93T2TNF01ApR4Y7xp7HzThXPu91uFzSoJEVATzt4yptdp/DbxlzeTrjxRzrXKht4RejqVGWhNtBAE/Y/oDdtZQovz1AkELWit0vKoZgG3rU=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 14f48488fead00d28e11c31f9845685c_630b3eb3d07c11f1acb8525400638852
    ReservedCode2: wFihlLTpCmfJmgqVPOMrYr8TyWIqgeH/6YvGFVKKsoACXdent0T9iLOnFxbvGMLbp3rdhrHdWq8DD5TW93T2TNF01ApR4Y7xp7HzThXPu91uFzSoJEVATzt4yptdp/DbxlzeTrjxRzrXKht4RejqVGWhNtBAE/Y/oDdtZQovz1AkELWit0vKoZgG3rU=
---

# 商品导入参考（Lightning-shop）

项目根目录 `D:\codeRepo\Lightning-shop`，Worker 入口 `src/index.js`，前端 `public/`。

## 字段映射表（脚本内置 DEFAULT_MAPPING）

| 表头中文（列名） | 字段名 |
| --- | --- |
| 品名 / 名称 / 商品名称 / 货品名称 | name |
| 品牌 | brand |
| 分类 / 类目 / 品类 | category |
| 规格 / 规格型号 | spec |
| 批发价 / 出厂价 / 供货价 | wholesale_price |
| 零售价 / 建议零售价 / 售价 | retail_price |
| 价格备注 / 价格说明 | price_note |
| 起订量 / 最小起订量 / MOQ / moq | moq |
| 核心卖点 / 卖点 / 亮点 / 描述 | highlights |
| 储存方式 / 储存 / 保存方式 | storage |
| 保质期 / 有效期 | shelf_life |
| 认证 / 背书 / 资质 / 认证资质 | cert |
| 角标 / 标签 | badge |
| 图片 / 图片地址 / 主图 | image |
| 状态 / 上下架 | status |

JSON 输入若已用字段名（上表"字段名"列），白名单字段直接透传。

## 脚本参数（scripts/import-from-table.mjs）

| 参数 | 说明 |
| --- | --- |
| `--file <path>` | CSV 文件（UTF-8，自动去 BOM） |
| `--json <path>` | JSON 数组文件 |
| `--mapping "列:字段,..."` | 覆盖/追加表头映射 |
| `--base-url <url>` | 默认 `http://127.0.0.1:8787` |
| `--token <token>` | `x-admin-token`；推荐用环境变量 `ADMIN_TOKEN` |
| `--header "K:V"` | 追加任意请求头，可重复（如 Cloudflare Access） |
| `--access-id` / `--access-secret` | Cloudflare Access 服务 token，自动转 `CF-Access-Client-Id` / `CF-Access-Client-Secret` |

导入接口：`POST /api/admin/products/import`，body `{products:[...]}`，按 `name+brand` 幂等 upsert，分批 50 条/批，返回 `{imported, updated, errors, total}`。

## 管理 API

| 方法 | 路径 | 说明 | 鉴权 |
| --- | --- | --- | --- |
| GET | `/api/products` | 上架商品（`?category=`、`?q=`） | 无 |
| GET | `/api/categories` | 分类及数量 | 无 |
| GET | `/api/products/:id` | 单个商品 | 无 |
| GET | `/api/site/hero` / `/api/site/price` | Hero / 价格策略 | 无 |
| PUT | `/api/site/hero` / `/api/site/price` | 保存配置 | `x-admin-token` |
| GET | `/api/admin/products` | 全量商品（含下架） | `x-admin-token` |
| POST | `/api/admin/products` | 新增商品 | `x-admin-token` |
| PUT | `/api/products/:id` | 全量覆盖（未传字段清空） | `x-admin-token` |
| PATCH | `/api/products/:id` | 局部更新 | `x-admin-token` |
| PATCH | `/api/products/batch` | 批量修改 `{ids, patch}` | `x-admin-token` |
| POST | `/api/admin/products/import` | 批量导入（幂等 upsert） | `x-admin-token` |
| GET/POST/PUT/DELETE | `/api/admin/categories` | 分类增删改（重命名/删除同步产品） | `x-admin-token` |

## 鉴权

- 管理接口统一 `x-admin-token: <ADMIN_PASSWORD>`，密码来自环境变量 `ADMIN_PASSWORD`
- 本地：`.dev.vars`（已被 .gitignore 忽略）；线上：`npx wrangler secret put ADMIN_PASSWORD`
- 生产建议 Cloudflare Access 双保险：脚本传 `--access-id` / `--access-secret` 或 `--header "CF-Access-Client-Id:..."` 等
*（内容由AI生成，仅供参考）*
