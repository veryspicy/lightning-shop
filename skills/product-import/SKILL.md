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

## 常见坑

- `PUT /api/products/:id` 是全量覆盖语义（未传字段清空）；改价用 PATCH，批量用 `PATCH /api/products/batch`
- CSV 必须 UTF-8（xlsx 转 CSV 时注意编码）
- `--header "K:V"` 必须带冒号，非法值警告忽略
- token/密码一律环境变量注入，不落命令行参数、不落聊天明文

## 参考资源

- `references/api_reference.md`：字段映射表、脚本参数、管理 API、鉴权细节
- 项目操作手册：`D:\codeRepo\Lightning-shop\docs\OPERATIONS.md`
- 项目导入脚本：`D:\codeRepo\Lightning-shop\scripts\import-from-table.mjs`
*（内容由AI生成，仅供参考）*
