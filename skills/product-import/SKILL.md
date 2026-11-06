---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 14f48488fead00d28e11c31f9845685c_6205049fd07c11f1acb8525400638852
    ReservedCode1: 7lusrFHUtXM9P5ewg9kAHGBO1b1wHmTgc+YQwDd0rdbCJAiy7erOwgJPLvUQeCmgomlNFMrla6FDmI1eobmK0PKtONUPQjMevGK/nkvkNQv2Tt4VaiLkG7Zlebhwk/r9q+wDj1icDCweBu9ps1qZniBlC8GosFgbqZQNzAz0LjumRRhcOTTkydqI4Gk=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 14f48488fead00d28e11c31f9845685c_6205049fd07c11f1acb8525400638852
    ReservedCode2: 7lusrFHUtXM9P5ewg9kAHGBO1b1wHmTgc+YQwDd0rdbCJAiy7erOwgJPLvUQeCmgomlNFMrla6FDmI1eobmK0PKtONUPQjMevGK/nkvkNQv2Tt4VaiLkG7Zlebhwk/r9q+wDj1icDCweBu9ps1qZniBlC8GosFgbqZQNzAz0LjumRRhcOTTkydqI4Gk=
---



# 商品批量导入（Lightning-shop）

把多源商品数据稳定写入 Lightning-shop 商品库。直接复用现成脚本与接口，禁止临场造轮子。执行五步：确认来源 → 映射 → 校验 → 导入 → 核对。

## 快速开始

```bash
# 本地验证（默认 http://127.0.0.1:8787）
node D:\codeRepo\Lightning-shop\scripts\import-from-table.mjs --file <csv>

# 生产（token 走环境变量；Cloudflare Access 按需）
ADMIN_TOKEN=<密码> node D:\codeRepo\Lightning-shop\scripts\import-from-table.mjs \
  --file <csv> --base-url https://<域名> \
  --access-id <CF-Access-Client-Id> --access-secret <CF-Access-Client-Secret>
```

## 工作流

### 1. 确认数据来源

| 来源 | 处理 |
| --- | --- |
| CSV（UTF-8） | 脚本 `--file` 直读（自动去 BOM） |
| JSON 数组（字段名规范） | 脚本 `--json` 直读 |
| xlsx | 先转 CSV(UTF-8) 或转 JSON 数组 |
| 图片/PDF/图文 | 派发 file-agent 用视觉模型提取为 JSON 数组，再走 `--json` |

### 2. 字段映射

默认中文表头映射见 `references/api_reference.md` 的映射表。非标准表头用 `--mapping "列名:字段名,..."` 追加/覆盖；JSON 白名单字段直接透传。

### 3. 校验

- 品名（name）必填，缺品名行进 errors 不中断整批
- 价格数值与单位需与货盘一致（脚本按文本透传，不做换算）
- 大批量先抽 3-5 行小样本试跑，看回执无误再全量

### 4. 执行导入

脚本分批（50 条/批）调用 `POST /api/admin/products/import`，打印每批新增/更新/错误与最终汇总。导入按 `name+brand` 幂等 upsert：已存在商品只合并传入字段，重跑安全。

### 5. 导入后核对（必做）

- `GET /api/admin/products`（带 token）核对条数与关键字段
- 检查 errors 明细并补录失败行
- `GET /api/products` 确认前端上架展示正常

## 补图 SOP（标准接口链路，图片上传与字段回写）

补图/回写 product 的 `image` 字段必须走标准接口链路，禁止 wrangler 直写 KV/R2：

`图片 → POST /api/upload（base64 上传 R2）→ 生成 {name, brand, image} → POST /api/admin/products/import（按 name+brand 幂等 upsert 回写）`

### 0. 事前可用性检查清单（必做，缺信息先向用户索取再动手）

1. **目标域名与可达性**：生产域名（如 `https://lightning-shop.headache.workers.dev`）可访问，`GET /api/products` 返回 200
2. **x-admin-token 有效性**：调 `GET /api/admin/products` 返回 200；401 说明密码无效
   - 注意：生产 `ADMIN_PASSWORD` 独立于本地 `.dev.vars` 占位 `ls-admin-2026`，两者不通用，需向用户索取生产密码
3. **图片文件就绪**：待传图片已压缩为 JPG（最长边 ≤ 800 建议，PNG 需先转 JPG），文件名与映射一致，路径可读
4. **目标产品存在**：映射的 `name+brand` 应在 `GET /api/admin/products` 中存在；不存在则该条将新建而非回写，需提示
5. **脚本自检**：`node scripts/upload-product-images.mjs --dir ... --mapping ...`（默认 dry-run）会一次性输出以上 1-4 项预检报告，全部通过才允许 `--force`

### 1. 标准脚本用法（推荐）

```bash
# dry-run 预检（不写数据）
node D:\codeRepo\Lightning-shop\scripts\upload-product-images.mjs \
  --dir D:\...\images --mapping D:\...\mapping.json \
  --base-url https://<域名> [--token <密码> | 环境变量 ADMIN_TOKEN] \
  [--access-id <CF-Access-Client-Id> --access-secret <CF-Access-Client-Secret>]

# 预检通过后真正执行
# 同样命令 + --force
```

- `--mapping` JSON：`[{ "name": "产品名", "brand": "品牌", "file": "p29.jpg" }]`，`file` 相对 `--dir`，`image` 自动生成 `/img/<file>`
- 脚本自带浏览器 UA，绕过 Cloudflare 对 Node/Python 默认 UA 的拦截；token 不落命令行参数（环境变量 `ADMIN_TOKEN` 优先）

### 2. 手动等价链路（脚本不可用时）

1. 逐张 `POST /api/upload`，body `{filename, base64}`，响应取 `/img/<key>`，头 `x-admin-token`
2. 生成仅含 `{name, brand, image}` 的 JSON（只带这三字段，upsert 不破坏其它字段）
3. `POST /api/admin/products/import`，body `{products:[...]}`
4. 参考：`temp/cyhx-image-backfill.json` 即为合法回写 JSON 样例

### 3. 验收（必做）

- `GET /api/admin/products`（带 token）核对 image 字段已更新（updated=N）
- `GET /api/products` 确认前端上架展示正常（图片 URL 可直接访问）

## 常见坑

- `PUT /api/products/:id` 是全量覆盖语义（未传字段清空）；改价用 PATCH，批量用 `PATCH /api/products/batch`
- CSV 必须 UTF-8（xlsx 转 CSV 时注意编码）
- `--header "K:V"` 必须带冒号，非法值警告忽略
- token/密码一律环境变量注入，不落命令行参数、不落聊天明文
- **Cloudflare 拦截默认 UA**：Python `urllib`、Node `fetch` 默认 UA 会被 CF 拦（403/SSL EOF / fetch failed）。必须携带浏览器 UA（标准脚本已内置）；临时手动调用可用 PowerShell `Invoke-WebRequest`（默认 UA 可过）
- **PowerShell 5.1 发中文 JSON**：含中文的 body 必须显式 `[Text.Encoding]::UTF8.GetBytes(...)` 写字节流，否则接口 400
- **生产密码独立**：`.dev.vars` 本地占位 `ls-admin-2026` 调生产 API 返回 401；生产密码由用户单独提供，勿沿用本地值
- **image 字段留空原因**：WPS xls 的 `=DISPIMG("ID_...",1)` 公式无法程序提取 URL，需从 OLE 流提取内嵌图后按此 SOP 补齐

## 参考资源

- `references/api_reference.md`：字段映射表、脚本参数、管理 API、鉴权细节（含 `/api/upload`）
- 项目操作手册：`D:\codeRepo\Lightning-shop\docs\OPERATIONS.md`
- 项目导入脚本：`D:\codeRepo\Lightning-shop\scripts\import-from-table.mjs`
- 补图标准脚本：`D:\codeRepo\Lightning-shop\scripts\upload-product-images.mjs`
*（内容由AI生成，仅供参考）*
