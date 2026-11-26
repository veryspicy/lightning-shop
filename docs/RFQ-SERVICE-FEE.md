# 询价单语义改造 · 设计说明书（P0-1）

> 经营模式：**B —— 纯居间 / 撮合**（货款直付工厂、工厂开票、服务费独立收；我方不碰货、不碰款、不碰票）
> 分支：`feature/rfq-service-fee`（自 `dev` @ 3938170 切出）
> 参考基线核对日期：2026-11-26，**本文所有枚举、上限、字段名、接口路径均以 `src/index.js` 实际代码为准**

## 0. 完成度清单

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| 迁移 `migrations/0006_rfq_service_fee.sql` | 已完成 | 7 列 ALTER + 2 索引 + 2 条状态键幂等 UPDATE；本地与远程 D1 均已 apply（远程 2026-11-26 执行，7 列 / 2 索引已核对，远程 `orders` 当前 0 行） |
| 后端 `src/index.js` / `src/d1.js` | 已完成 | 服务费写入、状态流转、品牌档案白名单、`site:seller`、公开投影均已就绪 |
| 后台品牌端（`public/admin.js` + `admin.html`） | 已完成 | 品牌弹窗新增资质 5 字段 + 对公账户 3 字段（账号 `^[0-9A-Za-z-]+$` 前端同步校验）；列表改 8 列并新增「工厂/对公账户」列（证号全量、有效期过期标红、账号仅尾四位）；「证书图」列表头改为图片张数口径；新增「服务方主体」面板对接 `GET/PUT /api/site/seller`（7 字段含 `credit_code`） |
| 前台网页（`public/app.js` + `index.html`） | 已完成 | 品牌页新增「生产资质」区块（主体 / 证号 / 许可范围 / 有效期 / 生产地址 + 居间说明，过期标红）；首屏新增居间公示条；付款卡标签由「统一社会信用代码」纠正为「食品生产许可证号」并带有效期校验 |
| 端到端验证 | 已完成 | 接口 8 组用例 + 界面 6 张截图全部通过；远程迁移已应用并核对（见 §9） |

## 1. 模式B 的四个硬约束（所有改动的判据）

| # | 约束 | 落到系统上的要求 |
| --- | --- | --- |
| B1 | 货款由客户**直付工厂对公账户**，我方不过手 | 订单确认后展示工厂收款账户；全站不得出现「平台收款 / 代收 / 代付」 |
| B2 | 发票由**工厂直接开给客户** | 凭证开票方=工厂；我方仅就服务费开票 |
| B3 | **服务费是独立一笔收款**，不从货款里扣 | `service_fee` + `service_fee_status` 独立于货款进度 |
| B4 | 我方不收货款 → 无二清、无食品经营资质义务 | 订单状态机不得出现「已支付」语义；公示区只放工厂资质 + 我方（销售主体）声明 |

## 2. 数据模型

### 2.1 `orders` 新增列（迁移 0006，均为 `ADD COLUMN`，全部带 DEFAULT）

| 列名 | 类型 | 语义 | 写入方 | 默认 |
| --- | --- | --- | --- | --- |
| `factory_id` | TEXT | 供货工厂 = 品牌档案 key（`brand:profile:{key}`），与 `products.brand` 对齐 | 仅 `POST /api/admin/orders/:id/fee` | `''` |
| `service_fee` | REAL | 本单向客户收取的居间服务费（我方唯一收入） | 同上 | `0` |
| `service_fee_note` | TEXT | 服务费构成备注，**内部信息，不下发客户端** | 同上 | `''` |
| `service_fee_status` | TEXT | 服务费收款状态（见 §3.2） | 同上 | `unbilled` |
| `service_fee_paid_at` | TEXT | 服务费到账时间（`YYYY-MM-DD` 或带时间，≤32 字符） | 同上 | `''` |
| `goods_paid_at` | TEXT | 客户告知「货款已直付工厂」的时间（**仅进度留痕**，不代表我方收款） | 同上 | `''` |
| `pay_note` | TEXT | 付款凭证备注（转账流水 / 工厂确认），对客户可见 | 同上 | `''` |

索引：

- `idx_orders_factory (factory_id, created_at DESC)` —— 按工厂看单量与货款，供资质页/台账核对
- `idx_orders_fee_status (service_fee_status, created_at DESC)` —— 服务费台账与「待收款」工作台

P0 不新建工厂主表：`factory_id` 复用品牌档案 key，避免主数据与权限面扩大。

### 2.2 金额口径与收款路径

| 项 | 字段 | 收款方 | 开票方 | 记录方式 |
| --- | --- | --- | --- | --- |
| 商品货款 | `total_amount` | **工厂对公账户**（客户直付） | 工厂 → 客户 | 只记金额与 `goods_paid_at` 进度，不记我方收款 |
| 居间服务费 | `service_fee` | **我方**（单独一笔） | 我方 → 客户 | `service_fee_status` 独立状态 |
| 客户应付合计 | `total_amount + service_fee` | 分别付给两方 | — | **接口计算返回（`total_payable`），不落库** |

硬规则：**严禁**「从货款中扣除服务费」的任何实现（等于我方经手货款 → 二清）。服务费必须由客户另行支付。原「毛利」口径作废，后台改展示「服务费收入」。

### 2.3 品牌档案（工厂）字段白名单

存储：`kv_doc` 键 `brand:profile:{encodeURIComponent(key)}`；白名单实现 `sanitizeBrandProfile()` + 常量 `FACTORY_TEXT_FIELDS`。

**基础展示字段**

| 键 | 上限 | 说明 |
| --- | --- | --- |
| `key` | 40 | 由路径决定，创建后不可改 |
| `name` | 60 | 品牌/工厂简称 |
| `intro` | 3000 | 公司介绍 |
| `services` | 3000 | 服务说明 |
| `contact` | 3000 | 联系方式（可含地址/电话/微信） |
| `certs` | 每项 300 | 证照图数组，仅接受 `/img/` 或 `http` 前缀 |

**资质公示（5 字段，公开）**

| 键 | 上限 | 说明 |
| --- | --- | --- |
| `entity_name` | 80 | 供货主体全称（营业执照名称） |
| `license_no` | 40 | 食品生产许可证编号（SC…） |
| `license_scope` | 200 | 许可品类 / 范围 |
| `license_valid_to` | 10 | 有效期至，**只存 `YYYY-MM-DD`**，不合法即存空串（供「即将到期」比较） |
| `factory_address` | 200 | 生产地址 |

**货款收款账户（3 字段，绝不对公网公开）**

| 键 | 上限 | 说明 |
| --- | --- | --- |
| `bank_account_name` | 80 | 收款户名（应与 `entity_name` 一致） |
| `bank_name` | 80 | 开户行（含支行） |
| `bank_account` | 40 | 对公账号，`sanitizeBankAccount()` 只允许数字/字母/短横 |

公开投影规则（`publicBrandProfile()`）：`GET /api/brands/profile/:key` 返回 `{ ...publicBrandProfile(profile), products }`，**仅剥离 `bank_account` / `bank_account_name` / `bank_name`**；资质字段照常公开。账户只在「手机号 + 订单号」双因子校验通过的查单响应中下发（`factoryInfoForOrder()`），且 `has_account=false` 时前台必须显式提示「账户待登记，请勿自行转账」。

> 账户为空**不得编造**：展示兜底文案，不渲染空表格、不出现占位账号。

### 2.4 销售主体 `site:seller`

存储：`kv_doc` 键 `site:seller`，白名单常量 `SELLER_FIELDS`。

| 键 | 上限 | 语义 |
| --- | --- | --- |
| `entity_name` | 80 | 我方主体名称；**为空时前台整块不渲染** |
| `credit_code` | 40 | 统一社会信用代码（后台「统一社会信用代码 / 注册号」） |
| `license_no` | 40 | 营业执照号（与信用代码不同时填） |
| `license_scope` | 200 | 经营范围摘要（含商务信息咨询 / 经纪代理） |
| `address` | 200 | 注册地址 |
| `contact` | 100 | 联系方式 |
| `fee_note` | 300 | 服务费收款说明（付款指引兜底文案） |

接口：`GET /api/site/seller`（公开、禁缓存）、`PUT /api/site/seller`（需 `x-admin-token` 且权限键 `seller`）。

**字段映射（后台「服务方主体」面板 → `site:seller`）**：`s-entity → entity_name`、`s-credit → credit_code`、`s-address → address`、`s-license → license_no`、`s-scope → license_scope`、`s-contact → contact`、`s-fee-note → fee_note`。前台 `sellerPayHtml()` 读 `credit_code` 与后端白名单一致，无需改动。

## 3. 状态机

### 3.1 订单状态（7 键，`ORDER_STATUS`）

| key | 客户可见标签 | 含义 | 可流转至 |
| --- | --- | --- | --- |
| `inquiry` | 待报价 | 客户已提交询价，我方未出价 | `quoted` / `cancelled` |
| `quoted` | 已报价待确认 | 已发报价（货款 + 服务费） | `confirmed` / `cancelled` |
| `confirmed` | 已确认待转厂 | 客户确认报价，货款将直付工厂 | `forwarded` / `cancelled` |
| `forwarded` | 已转厂待发货 | 已通知工厂接单 | `shipped` / `cancelled` |
| `shipped` | 工厂已发货 | 工厂直发，需回填物流单号 | `done` |
| `done` | 已完成 | 客户签收 | — |
| `cancelled` | 已取消 | 终止 | — |

新单一律落 `inquiry`：`POST /api/orders` 强制覆盖 `status='inquiry'`、`factory_id=''`、`service_fee=0`、`service_fee_status='unbilled'`、各时间戳清空、`version=1`，前台请求体无权设置。

存量键位重命名（迁移内幂等 UPDATE）：`pending → inquiry`、`paid → confirmed`；`shipped/done/cancelled` 保留，`shipped` 语义改为「工厂已发货」。KV 订单副本不追改，读路径以 D1 为准。

### 3.2 服务费状态（5 态，`FEE_STATUS`）

`unbilled`（待开账）/ `quoted`（已报价）/ `invoiced`（已开账）/ `paid`（已结清）/ `waived`（已减免）

时间戳一致性规则（服务端强制）：

- 置为 `paid` 且未给时间 → 自动补当前时间 `YYYY-MM-DD HH:MM:SS`
- 状态非 `paid` → `service_fee_paid_at` 强制清空（避免「未到账 + 到账时间」两个互斥事实同屏）

## 4. 接口契约（均为 `x-admin-token` + 权限键 `orders`）

### 4.1 `POST /api/admin/orders/:id/fee` —— 服务费 / 工厂 / 回款登记（合并写，PATCH 语义）

| 参数 | 类型 | 校验 |
| --- | --- | --- |
| `factory_id` | string | 截断 60；非空时必须已存在品牌档案，否则 `400 工厂档案不存在：{id}` |
| `service_fee` | number | 非负、有限、`≤ 999999`、四舍五入两位小数；字符串/负数/超限均 `400` |
| `service_fee_status` | string | 必须 ∈ `FEE_STATUS`，否则 `400 服务费状态非法` |
| `service_fee_paid_at` | string | `YYYY-MM-DD` 或带时间（≤32），格式不符 `400` |
| `goods_paid_at` | string | 同上 |
| `service_fee_note` | string | 截断 300（内部，不下发） |
| `pay_note` | string | 截断 300（对客户可见） |
| `version` | number | 传入则做乐观锁，不匹配返回 `409` 并回带当前订单 |

行为：**未出现的键保留原值**（避免前端只提交一个字段就清空服务费/备注）；写成功 `version + 1`；D1 走 `d1OrderUpdateFee` CAS，D1 未绑定时降级 KV 读改写并二次校验 `status/version`；KV 副本回写失败不影响返回。响应 `{ ok, order: withOrderTotals(merged) }`。

> 设计要点：服务费状态与订单状态**解耦**——报价、收款、对账各走各的，不必为登记一个到账日期去改订单状态。

### 4.2 `POST /api/admin/orders/:id/status` —— 订单状态流转

参数：`status`（必须是 `ORDER_STATUS[next]` 允许的下一态）、`tracking_no`（`shipped` 必填，空则拒绝）、`status_note`、`version`（乐观锁，冲突 `409`）。成功返回 `withOrderTotals(order)`。

### 4.3 客户端可见字段（公开投影）

`withOrderTotals()` 下发：`service_fee`（两位小数）、`total_payable`（货款+服务费，接口计算）、`service_fee_status`、`service_fee_paid_at`、`goods_paid_at`、`pay_note`。
**不下发**：`service_fee_note`（内部经营信息）、`base_price`（成本价）。

## 5. 后台实现（`public/admin.js` / `admin.html`）

### 5.1 订单面板

- `openOrderFeeModal()`：工厂下拉取 `/api/admin/brands/profile`，可填服务费金额 / 状态 / 到账时间 / 货款到账时间 / 备注，落 `POST /api/admin/orders/:id/fee`
- `orderAct()` / `updateOrderStatus()`：按当前状态的 `next` 渲染可流转按钮，`shipped` 强制填写运单号
- `FEE_STATUS_LABEL` 映射 5 态文案

### 5.2 品牌档案面板

- 列表 8 列：品牌 KEY / 品牌名称 / 产品数 / 证书图 / 工厂对公账户 / 简介 / 更新时间 / 操作
- 「工厂/对公账户」列三行渲染：主体全称 → `证号 + 有效期状态`（缺证号、缺有效期、已过期均标红）→ `对公 ****后四位 · 开户行`（缺键标红「缺对公账户」）。**列表不输出完整账号**
- `openBrandModal()` 表单在原有 `key/name/intro/services/contact/certs` 之外新增：主体全称、食品生产许可证号、许可品类/范围、许可证有效期至（`type=date`）、生产地址、收款户名、开户行、对公账号；保存前校验账号字符集，避免后端静默清空
- 请求路径统一 `encodeURIComponent(key)`，兼容中文品牌 key

### 5.3 服务方主体面板

- 菜单 `data-perm="seller"` 绑定权限键 `seller`，`openTab('seller')` → `loadSellerPanel()`
- `SELLER_MAP` 映射 7 个字段（`entity_name` / `credit_code` / `address` / `license_no` / `license_scope` / `contact` / `fee_note`），保存走 `PUT /api/site/seller`
- 主体名称与经营范围为空时前端拒绝提交：前台整块公示依赖这两项，缺任一即不渲染

## 6. 前台实现（`public/app.js` / `index.html` / `styles.css`）

- `renderSellerFooter()`：页脚公示「主体名称 + 居间说明 + 经营范围 + 联系方式」，`entity_name` 空则整块 `hidden`；同一函数联动首屏 `#hero-seller-note` 公示条，主体未登记时两处一起消失
- `brandLicHtml()`：品牌详情页「生产资质」区块，展示供货主体 / 食品生产许可证号 / 许可品类范围 / 许可证有效期（过期标红「已过期，请核实后再下单」）/ 生产地址，并附「仅提供选品与撮合服务」声明；四项全空则不渲染
- `factoryPayHtml()`：货款收款方（户名 / 开户行 / 账号 / **食品生产许可证号** / 许可证有效期），`has_account=false` 时提示「账户尚未登记，请勿自行转账」
- `sellerPayHtml()`：服务费收款方（我方主体），主体未登记时引导走业务员
- `orderPayStatusHtml()` / `receiptPayeeHtml()` / `receiptFeeStatusHtml()`：货款「汇至工厂」与服务费状态分列
- 全站文件检索 `代收` / `代付` / `已支付` / `支付成功`：0 命中

## 7. 安全与合规边界（硬约束）

1. **前台不可写服务费/工厂**：`sanitizeOrder()` 不采信 `factory_id`、`service_fee`、`service_fee_note`、`service_fee_status`、`service_fee_paid_at`、`goods_paid_at`、`pay_note`
2. **服务费服务端校验**：`Number.isFinite`、非负、`≤ 999999`、两位小数
3. **不落库派生值**：`total_payable` 只在响应中计算
4. **账户信息不公开**：品牌公开接口剥离 3 个账户字段；账户仅双因子查单可见
5. **不承诺未取得的资质**：`site:seller` 为空时不渲染主体声明
6. **不改存量数据**：新列全 DEFAULT，存量单 `factory_id=''` 显示「未指定」，不猜填

## 8. 关键决策记录

| # | 决策 | 结论 |
| --- | --- | --- |
| D1 | 状态机走「只改文案」还是「键位重命名」 | **键位重命名**：`paid` 的「已支付」在模式B 下属合规误导，必须清掉 |
| D2 | 服务费是否进客户消费聚合 | 本轮不加，待 P0-3 台账导出时统一改视图（`aggregateCustomer` 只算货款） |
| D3 | 销售主体存哪 | `site:seller` 站点配置，不落订单列 |
| D4 | 服务费计价方式 | 后台手工填金额；比例仅作测算提示，**不落库**（避免改比例影响历史单） |
| D5 | 工厂对公账户来源 | 后台品牌档案手工录入，空则前台走「联系对接人」兜底 |
| D6 | 服务费与状态关系 | 合并在一个接口、PATCH 语义、状态与订单状态解耦 |

## 9. 验证清单（本地已执行，逐条留痕）

| # | 用例 | 结果 |
| --- | --- | --- |
| 1 | 远程 `wrangler d1 migrations apply lightning-shop-db --remote`，核对存量单无 `pending` / `paid` | 通过（2026-11-26）：仅应用 0006，7 列 + `idx_orders_factory` / `idx_orders_fee_status` 已核对；远程 `orders` 为空表，无存量状态需迁移；线上 `/api/products` 返回 200 |
| 2 | 前台下单无法注入 `service_fee` / `service_fee_status` / `factory_id` / `status` / `pay_note` | 通过：提交带 `service_fee=9999, status=done, factory_id=hack工厂`，落库为 `status=inquiry, service_fee=0, service_fee_status=unbilled, service_fee_note=null, factory_id=null, pay_note=''`；测试单已清理 |
| 3 | `POST .../fee` 正常写返回 200 且 `version+1`；工厂 key 不存在应 400 | 通过：`version 1→2`；不存在工厂返回 400「工厂档案不存在：不存在的工厂，请先在品牌档案中建档」 |
| 4 | 服务费置 `paid` 未填时间自动补；退回 `quoted` 清空时间 | 通过：`paid` 自动写 `2026-11-26 09:38:24`；退回 `quoted` 后 `service_fee_paid_at=''` |
| 5 | 状态链 `inquiry→quoted→confirmed→forwarded→shipped（必填运单号）→done`；跳态拒绝；版本冲突 409 | 通过：四步流转成功；`shipped` 无运单 400「发货必须填写物流单号」；终态再流转 400；旧版本提交 409 且回带当前订单 |
| 6 | 查单响应含 `factory` 三件套 + `total_payable`，不含 `service_fee_note` / `base_price` | 通过：`factory` 回 5 项资质 + 3 项账户 + `has_account`；`service_fee_note`、`base_price` 均不在响应中；`total_payable=133.7`（货款 13.2 + 服务费 120.5） |
| 7 | 品牌公开接口返回资质字段、不含 `bank_account*` | 通过：`entity_name/license_no/license_scope/license_valid_to/factory_address` 全回，`bank_account/bank_name/bank_account_name` 均为 `null` |
| 8 | 服务费超上限 / 非法状态被拒 | 通过：`service_fee=1000000` → 400「服务费超出上限」；`service_fee_status=bogus` → 400「服务费状态非法：bogus」 |
| 9 | 界面：后台 8 列表格、编辑弹窗 13 字段回填、服务方主体 7 字段、前台首屏公示条、品牌页资质区块 | 通过（6 张截图，0 条 JS 报错）；列表账号已脱敏为 `****7890` |
| 10 | 全文检索禁用词为 0 命中 | 通过：`app.js` / `admin.js` / `index.html` / `styles.css` 均 0 命中 |

**迁移执行注记（本地与远程各踩一次，务必保留）**

1. **本地**：`orders` 新列与 2 个索引在早前手工执行中已存在，但 `d1_migrations` 缺 `0006` 记录，导致反复提示待应用、再次 apply 撞 duplicate column。已补写记录使状态与实际一致。
2. **远程**：库里同时存在两套迁移记录表——历史遗留的 `_d1_migrations`（0001–0005，带 checksum / baseline）与 wrangler 4.155 实际使用的 `d1_migrations`（不存在）。直接 `migrations apply --remote` 会先建 `d1_migrations` 并从 0001 重跑，到 0002 即报 `duplicate column name: base_price` 中断。
   **处置**：先 `d1 export` 全库备份，再向 `d1_migrations` 补插 0002–0005 记录（`INSERT OR IGNORE`），使 apply 只执行 0006。
   **下次远程迁移前必查**：`SELECT name FROM d1_migrations ORDER BY id;` 与 `SELECT name FROM _d1_migrations ORDER BY id;` 是否一致，不一致先对齐元数据再 apply。

## 10. 本轮不做（划界）

- 在线支付、库存、短信（模式B 下永久不做支付）
- 服务费台账 CSV 导出与月度对账（P0-3）
- 客户自助签署居间服务确认单（电子签，P2）
- 多工厂入驻 / 平台备案（业务扩到多工厂再议）
