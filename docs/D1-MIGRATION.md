# D1 迁移方案（决策记录 + 执行手册）

> 约束：**0 费用**。所有选型必须落在 Cloudflare 免费额度内，不接受任何按月付费方案。

## 1. 选型结论

| 候选 | 免费额度 | 费用 | 结论 |
| --- | --- | --- | --- |
| **D1** | 500 万行读/天、10 万行写/天、5GB 存储、单库 10GB | 0 | **主库，采用** |
| **Durable Objects（SQLite）** | 内嵌存储、强一致、串行、可 Alarm | 0（已用于登录闸） | **保留做协调/低延迟强一致场景**，不做全量主库（单对象吞吐有天花板） |
| **KV** | 10 万读/天、1000 写/天 | 0 | **降级为读缓存**，不再承载权威数据 |
| **Hyperdrive** | 10 万查询/天 | 0（代理免费），但需外部 PG/MySQL | **不采用**：上游 PG/MySQL 免费档不存在（PlanetScale PG $5/月起、MySQL $39/月），跨区域延迟也更高 |
| **PlanetScale / 外部 PG** | 无免费档 | $5+/月 | 违反 0 费用，排除 |

## 2. 为什么必须离开 KV 做权威存储

现在的 KV 布局有三个结构性缺陷，不是靠打补丁能解决的：

1. **无事务、无 CAS**：订单号碰撞会静默覆盖（丢单）；商品并发写索引会互相抹掉改动；客户聚合是「全扫订单 → 回写」，并发下单必然丢更新。现有代码用「写前重读 + 墓碑 + 双轮收敛」等大量补偿逻辑硬扛。
2. **无查询下推**：`/api/admin/orders?status=` 要先 `list()` 全量 key、再逐个 `get()` 再内存过滤；客户列表是 O(订单数) 的全扫重算。订单量一涨，KV 读次数（10 万/天）会先被打爆。
3. **写额度极低**：KV 1000 写/天。批量导入商品、订单状态流转叠加客户聚合回写，很容易触顶。

D1 把这些一次性解决：SQL 条件下推 + 索引（按扫描行计费，不再按请求开销）、事务与主键冲突、聚合查询替代全扫。

## 3. 目标结构

```
kv_doc        配置类小文档镜像（hero / categories / brands / users / roles / sessions / config）
products      商品主表（软删 deleted=1，保留审计与统计）
orders        订单主表（含 total_qty / total_amount / version 乐观锁）
order_items   订单明细（替代 items JSON 数组，支持按商品统计）
v_customer_stats  视图：一条 GROUP BY 取代「全扫订单重算客户档案」
migration_state   迁移游标 + 影子写脏标记
```

## 4. 分阶段执行

| 阶段 | 内容 | 读路径 | 风险 |
| --- | --- | --- | --- |
| **0（已合并 PR #24）** | 建表 + 影子双写 + 搬迁端点 + 一致性核对 | 仍读 KV | 极低，D1 挂不影响主流程 |
| **1（本次 PR）** | 读切换到 D1（商品列表、订单列表/查单、客户列表），KV 变兜底缓存；补齐 products/doc 写点的影子双写 | D1（异常回退 KV） | 中，已在阶段 0 核对通过后执行 |
| **2（进行中 PR #27）** | 写真源切 D1：订单状态流转改 D1 条件更新（原子 CAS）；后续接订单号唯一约束、商品写路径 | D1 | 中 |
| 3 | 清理 KV 写路径与遗留补偿代码，KV 仅做热点缓存 | D1 | 低 |

### 阶段 0 具体改动

- `migrations/0001_init.sql`：建表、索引、客户聚合视图。
- `src/d1.js`：`d1SaveProduct` / `d1SaveOrder` / `d1DeleteProduct` / `d1PutDoc` / `migrateBatch` / `verifyConsistency` / `d1CustomerList` / `d1OrderList`。所有写函数自带 try/catch，失败只在 `migration_state.d1_dirty` 记账，**绝不回滚 KV 主写**。
- `src/index.js`：
  - `saveProduct` / `saveOrder` / 商品 DELETE 分支追加影子写；
  - 新增管理端点 `POST /api/admin/d1/migrate?limit=100`（幂等、可重入、靠游标续跑）与 `GET /api/admin/d1/verify?sample=10`（KV 与 D1 计数对比 + 抽样命中 + 脏标记）。
- `wrangler.toml`：`[[d1_databases]] binding = "DB"`。

### 执行顺序（上线时）

```bash
# 1) 建表（已执行过一次，可重复执行：全部 IF NOT EXISTS）
wrangler d1 execute lightning-shop-db --remote --file=migrations/0001_init.sql -y

# 2) 部署含影子双写的版本
wrangler deploy

# 3) 分批搬迁存量（重复调用直到 has_more=false）
#    注意：阶段 3 收尾后该端点默认 410，须先临时设 ALLOW_LEGACY_D1_ADMIN=1 再调用
curl -X POST -H "x-admin-token: <token>" https://<domain>/api/admin/d1/migrate?limit=100

# 4) 核对
curl -H "x-admin-token: <token>" https://<domain>/api/admin/d1/verify?sample=20
```

### 阶段 1 具体改动

前置：阶段 0 已合并部署，`/api/admin/d1/verify` 结果为 `kv == d1`、`last_dirty = null`。

**读路径切 D1（三处，均带 KV 兜底）**

- `getProducts`：改走 `d1ProductList(env)`（`products WHERE deleted = 0 ORDER BY seq, id`）。返回 `null`（D1 异常/未绑定）时回退 `KV.get('products')` —— 前台绝不因库抖动空页。
- `getOrders`：改走 `d1OrderList(env)`（订单条件下推 + 明细一次 `IN` 查询），取代 KV 时代的 `list()` 全扫 + 逐条 `get`；异常回退原 KV 逻辑。
- `getCustomers`：改走 `d1CustomerList(env)`（`v_customer_stats` 视图实时聚合），取代 KV 里靠下单/改单回写的 `customers:` 聚合缓存。

**补齐影子双写（阶段 0 的写覆盖缺口）**

阶段 0 只对「单条新增/编辑商品、下单、下单状态流转、删除商品」挂了影子写，以下四条写路径直接 `KV.put`，会让 D1 与 KV 分叉，读切 D1 后表现为「后台改完前台看不见」：

| 位置 | 场景 | 修复 |
| --- | --- | --- |
| 分类重命名 / 删除同步 | 批量改产品 `category` | 改走 `saveProduct` |
| `PATCH /api/products/batch` | 批量改字段 | 改走 `saveProduct` |
| `POST /api/admin/products/import` | 批量导入（新增 + upsert） | 改走 `saveProduct` |

**表结构补列**

- `migrations/0002_order_items_base_price.sql`：`order_items` 补 `base_price`（出厂价快照）。后台订单页的成本列与成本合计读该字段，0001 建表时漏了。历史行回填 SQL：

```sql
UPDATE order_items
SET base_price = COALESCE((SELECT wholesale_price FROM products p WHERE p.id = order_items.product_id), '')
WHERE base_price = '';
```

**阶段 1 故意不切的部分**

- 配置类小文档（`site:hero` / `site:price` / `site:qr` / `config:categories` / `roles` / `users` / 品牌档案 / `meta:deletedProducts`）：写路径尚未挂 `d1PutDoc` 影子写，此时切读会让「后台刚改的配置读回旧值」。留到阶段 2 与写真源一起切，`d1GetDoc` / `d1BrandProfiles` 已就绪待用。
- `sessions:` 会话与 `cache:epoch` 缓存版本号：KV 的语义（TTL + 高频读）本就适用，不进 D1。
- `products:{id}` 单条读与存在性检查：仍读 KV（阶段 2 写真源切换时一并改）。

### 阶段 1 上线顺序

```bash
# 1) 补列（可重复执行，重复时报 duplicate column 属预期）
wrangler d1 execute lightning-shop-db --remote --file=migrations/0002_order_items_base_price.sql

# 2) 回填历史订单明细的出厂价
wrangler d1 execute lightning-shop-db --remote --command "UPDATE order_items SET base_price = COALESCE((SELECT wholesale_price FROM products p WHERE p.id = order_items.product_id), '') WHERE base_price = '';"

# 3) 部署（读切 D1 + 兜底）
wrangler deploy

# 4) 冒烟：前台商品列表、后台订单列表、客户列表、查单各一次
curl -s https://<domain>/api/products | head -c 200
curl -s -H "x-admin-token: <token>" https://<domain>/api/admin/orders | head -c 200
curl -s -H "x-admin-token: <token>" https://<domain>/api/admin/customers | head -c 200

# 5) 再核对一次一致性
curl -s -H "x-admin-token: <token>" https://<domain>/api/admin/d1/verify?sample=20
```


### 阶段 1.1 补漏（已合并 PR #26）

阶段 1 上线后冒烟发现并修复：

- `d1OrderList` 明细投影漏了 `base_price` → 后台订单页成本列与成本合计整体变空。已补。
- `GET /api/admin/orders/:id` 仍直读 KV → 单条订单读与列表读源不一致。新增 `d1OrderGet`，改为 D1 优先、KV 兜底。

### 阶段 2：写路径切 D1

**第一刀：订单状态流转改 D1 原子 CAS（已合并 PR #27）**

KV 时代 `POST /api/admin/orders/:id/status` 是「读 → 版本校验 → 写前重读 → 写」，两次读之间仍有窗口，并发下后提交者会覆盖先提交者的流转（只是把窗口缩小，没有消除）。

改为 `src/d1.js` 新增 `d1OrderUpdateStatus`：

```sql
UPDATE orders
   SET status = ?, version = ?, tracking_no = ?, status_note = ?, updated_at = ?
 WHERE id = ? AND version = ?   -- 旧版本号
```

D1 单库单线程串行写 + 条件更新 = 真 CAS：`meta.changes = 1` 即赢得竞争，`= 0` 即期间已被他人推进，直接返回 409。

关键实现约束：

- **只有确认该单在 D1 里才走 CAS**：路由先用 `d1OrderGet` 取单并记录来源。历史未双写的单 `UPDATE` 命中 0 行，若不加来源判断会被误判成版本冲突，因此这类单退回 KV 读改写。
- **CAS 成功后 KV 只做副本回写**（`KV.put` 原始对象），不再走 `saveOrder`——否则会对 D1 再执行一次 `DELETE order_items + 逐条 INSERT`，白白多出一批写额度和一次瞬时不一致。
- **客户聚合照旧重算**：取消单会影响客户消费统计，CAS 分支同样调用 `upsertCustomer`。
- **D1 不可用（无 binding / 抛错）自动退回**原 KV 读改写逻辑，行为与阶段 1 一致，不新增故障模式。

**第二刀：订单创建改 D1 主写（本次 PR）**

KV 时代下单是「`genOrderId` 用 `KV.get` 探重 → `saveOrder` 写 KV」，两处都靠不住：

- KV 无事务，先查后写在并发下等于没查（两个请求可同时查到空），重号会**静默覆盖**已有订单，即丢单；
- KV 最终一致，刚探过不存在的 key 也可能被并发写入顶掉。

改为 `src/d1.js` 新增 `d1InsertOrder`（**纯 INSERT，不带 `ON CONFLICT DO UPDATE`**）+ 路由侧换号重试：

- 订单号唯一性由 `orders.id` 主键兜底，冲突时 D1 直接报错，捕获后换号重试（最多 5 次），彻底消除静默覆盖；
- 唯一性交给库之后，生成侧只需把随机空间做大：`genOrderId` 改为纯函数，4 字节 → 6 字节（2^48），并去掉 KV 存在性探测这 1~3 次读；
- 写成功后 KV 只做**副本回写**（`KV.put` 整单），不再走 `saveOrder`，避免对 D1 再做一次 `DELETE order_items + 逐条 INSERT`；
- **D1 报错直接失败（500）**，绝不退化成「只写 KV」的单边写入——读路径以 D1 为准，只写 KV 等于后台看不到这单；
- **D1 未绑定**（本地无 binding）才退回 KV 单写，保持可降级。

连带修正：客户聚合来源从 `KV.list({prefix:'orders:'})` 改为 `getOrders()`（D1 优先、KV 兜底）。KV 侧已降级为副本且 `list` 弱一致，继续按 KV 聚合会在刚下单时漏掉新单，导致客户消费额偏小。

**后续待做**

- 配置类小文档（`site:*` / `config:categories` / `roles` / `users` / 品牌档案）已随阶段 3 第一刀切 D1 主写，读侧 `d1GetDoc` / `d1BrandProfiles` 已就绪，剩余只是把 KV 兜底分支标为「仅 no_db」。
- 会话（`sessions:*`）继续留 KV：TTL 语义天然匹配，且不参与任何列表聚合。需要强一致会话时再迁。
- ~~`POST /api/admin/d1/migrate` / `GET /api/admin/d1/verify` 短期保留作灾难恢复与诊断入口~~ → **已下线（PR #38）**，见文末「阶段 3 收尾」。

### 阶段 3：写路径收口（KV 退为纯副本）

阶段 2 只切了订单的「创建 / 状态流转」。其余写路径仍是「KV 主写 + D1 影子写」，D1 时代读路径已全走 D1，这些残留会直接表现为**后台读不到刚保存的内容**。

**第一刀：文档写（已合并 PR #31）**

`putDoc` / `delDoc` 改为 D1 主写，成功后才回写 KV 副本；D1 报错即抛 `doc_write_failed`，由 `handleApi` 顶层统一转 500。`no_db` 时退回 KV 单写。

**第二刀：商品写（已合并 PR #32）**

`saveProduct` D1 主写、删除以 D1 软删为主，`rebuildProductsIndex` 以 D1 为真源生成索引（不再从 KV 反补）。

**第三刀：订单侧残留清理（本次 PR）**

- **`saveOrder` 拆到数据层**：新增 `d1PersistOrder(env, order)`，语义收敛为「D1 主写 + KV 副本」：`no_db` → KV 单写（此时 KV 即真源）；D1 报错 → `{ ok:false }`，调用方必须 500，**不再有任何一条路径只写 KV**。`index.js` 的 `saveOrder` 变为一行代理，`d1SaveOrder` 布尔包装删除（迁移批次直接用 `d1UpsertOrder`）。
- **客户聚合不再回写 KV**：`recomputeOneCustomer` 原先为了「让记录收敛」做两轮全量订单扫描（每次下单多拉两遍订单表，D1 按扫描行计费），现在统计真源是视图 `v_customer_stats`，订单落库即实时生效。删除两轮扫描，KV 兜底记录仅在 `no_db` 时写。
- **状态流转的副本回写加隔离**：CAS 成功后 `KV.put` 包 try/catch，副本写失败不影响已生效的 D1 结果（原来失败会把一次成功的流转变成 500）。
- **迁移批次加完成保护**：`migrateBatch` 落 `migration_state` 的 `MIGRATE_DONE` 标记，重跑默认拒绝（`reason=already_completed`），必须显式 `?force=1`。理由很直接：KV 已是副本，用它反向覆盖 D1 只会把旧数据写回真源。
- **一致性核对语义调整**：`verifyConsistency` 中「KV 有、D1 无」才算异常，`D1 有、KV 无` 属正常（副本可能写失败，读走 D1）。

验证（本地 `wrangler dev --local`，独立 state 目录，migrations 先 apply）：

- 纯函数级：D1 正常 → `source=d1` 且 KV 一份副本；D1 抛错 → `ok:false` 且 KV **零写入**；`no_db` → `source=kv`；KV 副本抛错 → 主流程仍 `ok`。
- 端到端：登录 → 建 2 商品（成本价 40/60） → 下单（展示价 44/66，金额 154） → 后台列表/详情（明细含 `base_price`） → `pending→paid→shipped`（版本 1→2→3，旧版本号 409，非法流转 400） → 客户聚合 1 单 154 → 另一号码下单后取消，客户金额回落 0 → `migrate` 被拒（`already_completed`） → `verify` 计数一致且无缺失键。

生产写路径验证（2026-11-06，`lightning-shop.gora.dpdns.org`）：

生产不能注入故障，因此验证方式改为「真实写 + 直查库」：

1. 后台登录 → 新建测试商品 → 改价 → 软删，三步均 2xx；
2. 每步后用 `wrangler d1 execute lightning-shop-db --remote` 直查主库，确认成本价/起订量/`deleted` 已按预期落库（不是只落了 KV）；
3. `GET /api/admin/d1/verify` 收尾：`kv={products:56,orders:4}`、`d1={products:56,orders:4,order_items:4}`、`kv_drift` 无异常、`last_dirty=null`、`ok=true`——**全程无写失败样本**，说明没有一条路径退回「只写 KV」；
4. 清理：按 id 精确删除 3 条测试行，复核后台列表 56 条、无 `p60-` 残留。

顺带确认两点历史误解：后台 `/api/admin/products` 返回的是**裸数组**（不是 `{products}`）；`retail_price` 走 `applyMarginStr`，只有价格配置 `enabled` 时按 margin 加价，否则原样保存——不是「无条件重算」。

## 4.1 阶段 3 上线与生产端到端验证（2026-11-06）

发布路径：PR #33（`feat/d1-stage3-order-write` → dev）合并后，PR #34（dev → main）一次性把阶段 0-3 上线，`Deploy to Cloudflare Workers` run 42214489748 = success。

生产端到端（`lightning-shop.gora.dpdns.org`，订单写链路）：

1. 匿名下单用真实在售商品（`p01` × 1）→ 2xx，`d1PersistOrder` 落库，KV 副本同步，verify 的 orders/order_items 计数同步 +1；
2. 后台订单详情回读：`total_qty=1`、`total_amount=55`、明细快照含 `base_price=50元/箱` 与 `price=55元/箱`（服务端按价格配置重算，未采信请求体）；
3. 状态流转走 D1 原子 CAS：`pending → paid`（version 1→2）→ `cancelled`（version 2→3），两次均回读一致；非法流转仍由 `ORDER_STATUS.next` 拦成 400，旧 version 仍 409；
4. 中文写入验证：显式 UTF-8 字节发送 `{"customer_name":"中文测试-张三"}`，D1 内中文完好 —— PowerShell 5.1 的 `Invoke-RestMethod` 默认按 ISO-8859-1 编码 body，中文会变 `?`，属客户端问题而非服务端，勿误判为乱码 bug；
5. 收尾 `GET /api/admin/d1/verify`：`ok=true`、`kv={products:56,orders:0}`、`d1={products:56,orders:0,order_items:0}`、`kv_drift.abnormal=false`、`last_dirty=null`。

接口事实补充（本轮踩到的）：

- `POST /api/orders` 返回 `{ok, order}`，不是裸 order；
- 订单金额字段是 `total_amount` / `total_qty`，**不是** `total`；后台列表是 `{ok, orders, total}`，客户列表是 `{ok, customers, total}`，商品列表才是裸数组；
- `GET /api/admin/orders/:id` 返回 `{ok, order}`，订单地址不落库（`address` 回读为空，与 KV 时代一致）。

数据清理：本次 3 条 + 历史 4 条验证订单（`D261106083095043AB3` / `D26110609171F96D659` / `D26110609456F13E61BC08A` / `D2611060945C3DDC67DEE54` / `D261106120393C6D60E528A` / `D2611061204818304D015E6` / `D261106121232E6A32068E7`）按 id 精确删除：`order_items` 7 行 + `orders` 7 行，KV 副本 `orders:*` 7 键与 4 个测试号 `customers:*` 一并清除，删前快照见 `temp/order-cleanup-backup.json`。清理后后台订单/客户均为空、商品仍 56 条。

> 坑：`wrangler kv key delete` 在 binding 同时配置 `id` 与 `preview_id` 时必须显式加 `--preview false` 才是生产命名空间，否则直接报错退出（早期 `key list` 也是同一类坑）。

### 阶段 3 收尾：legacy D1 管理端点下线（PR #38）

迁移完结后 `POST /api/admin/d1/migrate` 与 `GET /api/admin/d1/verify` 默认关闭：管理员鉴权通过后仍统一返回 `410 endpoint_retired`。

- 理由：`migrate?force=1` 能用 KV 陈旧副本反向覆盖 D1 真源，一个误操作就把真库写旧；`verify` 的「KV 有 D1 无」判断在 KV 退为副本后也失去诊断意义。
- 保留应急能力：临时设置环境变量 `ALLOW_LEGACY_D1_ADMIN=1` 即可恢复两个端点（不再常驻生产），用完立刻撤销。
- 本地验证：不设变量 → `verify`/`migrate` 均 410；设 `--var ALLOW_LEGACY_D1_ADMIN:1` → `verify` 200（`ok=true`、`kv_drift.abnormal=false`）、`migrate` 200 但 `skipped=true, reason=already_completed`。
- 生产操作改为离线执行：`wrangler versions deploy` 回滚 + `wrangler d1 time-travel` / 每日 R2 备份恢复，不再走 Worker 内的搬迁接口。

## 5. 避坑清单

- **D1 读副本是最终一致**：会话/读己之写场景必须 `withSession("first-primary")`，否则刚写的订单可能查不到。
- **单库写串行**：无并发写放大需求可忽略；批量导入要合批（`env.DB.batch`），不要逐条 `await`。
- **按扫描行计费**：所有列表查询必须走索引，禁止 `LIKE '%x%'` 全表扫；分页用 `LIMIT/OFFSET` 或键集分页。
- **单库 10GB 上限不可扩**：R2 存图、D1 只存结构化数据，图片绝不入库。
- **`?1` 编号参数不要用**：D1 绑定位置参数，统一 `?` + `excluded.*` 写法。
- **视图不缓存**：`v_customer_stats` 每次实时算，订单量大后再物化成表 + 触发更新。

## 6. 回滚

- **阶段 0**：不改变任何读路径，回滚只是把 `wrangler.toml` 里的 D1 binding 移除并重新部署；KV 数据全部原样保留，`DROP TABLE` 即可清空 D1。
- **阶段 1**：回滚用 `wrangler versions deploy` 回退到上一版本即可（KV 仍是全量主写，数据未丢）。若只是 D1 单点故障、不想回版本，把 `d1ProductList` / `d1OrderList` / `d1CustomerList` 的返回置为 `null`，三个读函数会自动走 KV 兜底分支。`order_items.base_price` 是新增列，回滚后旧代码不读它，无需回退 DDL。
