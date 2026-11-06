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
| **0（本次 PR）** | 建表 + 影子双写 + 搬迁端点 + 一致性核对 | 仍读 KV | 极低，D1 挂不影响主流程 |
| 1 | 读切换到 D1（商品列表/详情、后台订单、客户列表），KV 变缓存 | D1 | 中，需先跑阶段 0 核对通过 |
| 2 | 写真源切 D1（事务、订单号唯一约束、去掉墓碑/重建索引补偿逻辑） | D1 | 中 |
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
curl -X POST -H "x-admin-token: <token>" https://<domain>/api/admin/d1/migrate?limit=100

# 4) 核对
curl -H "x-admin-token: <token>" https://<domain>/api/admin/d1/verify?sample=20
```

## 5. 避坑清单

- **D1 读副本是最终一致**：会话/读己之写场景必须 `withSession("first-primary")`，否则刚写的订单可能查不到。
- **单库写串行**：无并发写放大需求可忽略；批量导入要合批（`env.DB.batch`），不要逐条 `await`。
- **按扫描行计费**：所有列表查询必须走索引，禁止 `LIKE '%x%'` 全表扫；分页用 `LIMIT/OFFSET` 或键集分页。
- **单库 10GB 上限不可扩**：R2 存图、D1 只存结构化数据，图片绝不入库。
- **`?1` 编号参数不要用**：D1 绑定位置参数，统一 `?` + `excluded.*` 写法。
- **视图不缓存**：`v_customer_stats` 每次实时算，订单量大后再物化成表 + 触发更新。

## 6. 回滚

阶段 0 不改变任何读路径，回滚只是把 `wrangler.toml` 里的 D1 binding 移除并重新部署；KV 数据全部原样保留，`DROP TABLE` 即可清空 D1。
