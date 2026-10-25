---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 14f48488fead00d28e11c31f9845685c_1377057bd07b11f19f8752540064ee0f
    ReservedCode1: YouJdNFK2WrYk5n/yZ9YjqgHDS6+MEb81EPwMceiIBEn15m30/5nyQFoFuGrvCiDNM0vOjD1UGYykhe2W9gEY1p/AV2mEK/M7oBu+uZl73TcKSZgTH2HwiSlHOtqIWx8lGa2ty43Ard6udFPTgag2t/zH69LjOouZJjQ3ZT0PT7xEGDdaXKS65tJqds=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 14f48488fead00d28e11c31f9845685c_1377057bd07b11f19f8752540064ee0f
    ReservedCode2: YouJdNFK2WrYk5n/yZ9YjqgHDS6+MEb81EPwMceiIBEn15m30/5nyQFoFuGrvCiDNM0vOjD1UGYykhe2W9gEY1p/AV2mEK/M7oBu+uZl73TcKSZgTH2HwiSlHOtqIWx8lGa2ty43Ard6udFPTgag2t/zH69LjOouZJjQ3ZT0PT7xEGDdaXKS65tJqds=
---

# Lightning-shop 操作手册（Ops Guide）

本手册面向执行运维/数据操作的 Agent 与人工维护者，覆盖管理后台入口、商品批量导入、生产鉴权。所有接口以实际代码为准。

## 1. 管理后台

- 入口：站点根路径下输入管理密码（隐蔽入口，输入 `admin` 后出现登录链接）
- 登录后功能：商品列表、新增/编辑/删除、批量修改、分类增删改、Hero 配置、价格策略（利润率加成）、导入
- 鉴权：请求头 `x-admin-token: <ADMIN_PASSWORD>`，密码来自环境变量 `ADMIN_PASSWORD`
  - 本地：`.dev.vars` 中 `ADMIN_PASSWORD = "..."`（已被 .gitignore 忽略）
  - 线上：`npx wrangler secret put ADMIN_PASSWORD`（强密码，勿用本地占位 `ls-admin-2026`）

## 2. 管理 API 一览

| 方法 | 路径 | 说明 | 鉴权 |
| --- | --- | --- | --- |
| GET | `/api/products` | 上架商品列表（`?category=`、`?q=`） | 无 |
| GET | `/api/categories` | 分类及数量（KV 配置 + 产品聚合） | 无 |
| GET | `/api/products/:id` | 单个商品 | 无 |
| GET | `/api/site/hero` | Hero 配置 | 无 |
| GET | `/api/site/price` | 价格策略 | 无 |
| PUT | `/api/site/hero` | 保存 Hero | `x-admin-token` |
| PUT | `/api/site/price` | 保存价格策略 | `x-admin-token` |
| GET | `/api/admin/products` | 全量商品（含下架） | `x-admin-token` |
| POST | `/api/admin/products` | 新增商品 | `x-admin-token` |
| PUT | `/api/products/:id` | **全量覆盖**商品（未传字段清空！改价后须传全量字段） | `x-admin-token` |
| PATCH | `/api/products/:id` | 局部更新（仅合并传入字段） | `x-admin-token` |
| PATCH | `/api/products/batch` | 批量修改：`{ids:[], patch:{字段:新值}}` | `x-admin-token` |
| POST | `/api/admin/products/import` | 批量导入（幂等 upsert） | `x-admin-token` |
| GET | `/api/admin/categories` | 分类列表 | `x-admin-token` |
| POST | `/api/admin/categories` | 新增分类 | `x-admin-token` |
| PUT | `/api/admin/categories` | 重命名分类（同步产品） | `x-admin-token` |
| DELETE | `/api/admin/categories` | 删除分类（同步产品） | `x-admin-token` |

> 注意：`PUT /api/products/:id` 是全量语义，未传字段会被清空。局部改价请用 `PATCH`，批量用 `PATCH /api/products/batch`。

## 3. 商品批量导入（生产上货主路径）

### 3.1 数据来源转换

| 来源 | 处理方式 |
| --- | --- |
| CSV（UTF-8 含 BOM） | 直接给脚本 `--file` |
| JSON 数组（字段名） | 直接给脚本 `--json` |
| xlsx | 先转 CSV（UTF-8），或转 JSON 后导入 |
| 表格/PDF/图片 | 用视觉模型（file-agent + 读图）提取为 JSON 数组，再走 `--json` 导入 |

### 3.2 脚本用法

```bash
node scripts/import-from-table.mjs --file <csv> [--token <x-admin-token>]
node scripts/import-from-table.mjs --json <json> [--token <x-admin-token>]
```

完整参数：

| 参数 | 说明 |
| --- | --- |
| `--file <path>` | CSV 文件（UTF-8，自动去 BOM） |
| `--json <path>` | JSON 数组文件 |
| `--mapping "列:字段,..."` | 覆盖/追加表头映射（默认见脚本 DEFAULT_MAPPING：品名/品牌/分类/规格/批发价/零售价/起订量/核心卖点/保质期/角标/状态等） |
| `--base-url <url>` | 默认 `http://127.0.0.1:8787` |
| `--token <token>` | `x-admin-token`；也可用环境变量 `ADMIN_TOKEN`（推荐，避免进 shell 历史） |
| `--header "K:V"` | 追加任意请求头，可重复传（如 Cloudflare Access） |
| `--access-id` / `--access-secret` | Cloudflare Access 服务 token 快捷参数，自动转 `CF-Access-Client-Id` / `CF-Access-Client-Secret` |

### 3.3 幂等与回执

- 按 `name + brand` 幂等 upsert：已存在的商品只合并传入字段，重跑安全
- 逐行校验：缺品名/非对象进 `errors`，不中断整批
- 分批 50 条/批，返回 `{imported, updated, errors, total}`

### 3.4 生产环境调用示例

```bash
ADMIN_TOKEN=<强密码> node scripts/import-from-table.mjs \
  --file 商品表.csv \
  --base-url https://<你的域名> \
  --access-id <CF-Access-Client-Id> \
  --access-secret <CF-Access-Client-Secret>
```

### 3.5 导入后核对

- 调 `GET /api/admin/products` 核对条数与关键字段
- 检查 `errors` 明细并单独补录
- 前端 `GET /api/products` 确认上架商品正常展示

## 4. 生产鉴权配置（上线必做）

1. `npx wrangler secret put ADMIN_PASSWORD` 注入强密码（不落代码/配置）
2. 推荐 Cloudflare Access 保护管理路径，并创建服务 token（`CF-Access-Client-Id` / `CF-Access-Client-Secret`）供脚本调用
3. 本地 `.dev.vars` 的占位密码 `ls-admin-2026` 禁止用于线上

## 5. 常见坑

- `PUT /api/products/:id` 是全量语义，改价必须带全量字段或用 PATCH
- CSV 首行必须 UTF-8 无 BOM 残留（脚本已自动处理 `\uFEFF`）
- 导入脚本带 `--header` 时格式必须 `"K:V"`，非法值会警告忽略
- 同文件多处编辑需串行执行，避免并发覆盖丢声明
*（内容由AI生成，仅供参考）*
