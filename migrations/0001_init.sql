-- 0001_init.sql — Lightning-shop D1 初始结构
-- d1-baseline-when: SELECT 1 FROM sqlite_master WHERE type='table' AND name='products'
--   ↑ 供 scripts/d1-migrate.mjs 判断「存量库已具备该迁移的结构」：成立则登记为基线不重放。
-- 目标：把 KV 的「整表 JSON + 全扫聚合」换成关系表，消除并发覆盖与全表遍历。
-- 兼容策略：kv_doc 表无损镜像全部 KV 键（配置类小文档保留键值形态），
--           products / orders / order_items 由 kv_doc 派生，供关系查询使用。

/* ---------- 键值镜像：配置、品牌档案、角色、会话等小文档 ---------- */
CREATE TABLE IF NOT EXISTS kv_doc (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/* ---------- 商品 ---------- */
CREATE TABLE IF NOT EXISTS products (
  id              TEXT PRIMARY KEY,
  seq             INTEGER NOT NULL DEFAULT 0,
  name            TEXT NOT NULL DEFAULT '',
  brand           TEXT NOT NULL DEFAULT '',
  category        TEXT NOT NULL DEFAULT '',
  spec            TEXT NOT NULL DEFAULT '',
  wholesale_price TEXT NOT NULL DEFAULT '',
  retail_price    TEXT NOT NULL DEFAULT '',
  price_note      TEXT NOT NULL DEFAULT '',
  moq             TEXT NOT NULL DEFAULT '',
  highlights      TEXT NOT NULL DEFAULT '',
  storage         TEXT NOT NULL DEFAULT '',
  shelf_life      TEXT NOT NULL DEFAULT '',
  cert            TEXT NOT NULL DEFAULT '',
  badge           TEXT NOT NULL DEFAULT '',
  image           TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT '上架',
  deleted         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT '',
  updated_at      TEXT NOT NULL DEFAULT ''
);

-- 列表页按 status 过滤 + seq 排序，索引覆盖避免全表扫描（D1 按扫描行计费）
CREATE INDEX IF NOT EXISTS idx_products_list  ON products(deleted, status, seq);
CREATE INDEX IF NOT EXISTS idx_products_cat   ON products(deleted, category);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(deleted, brand);
CREATE INDEX IF NOT EXISTS idx_products_name  ON products(deleted, name);

/* ---------- 订单 ---------- */
CREATE TABLE IF NOT EXISTS orders (
  id             TEXT PRIMARY KEY,
  customer_name  TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  remark         TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'pending',
  version        INTEGER NOT NULL DEFAULT 1,
  tracking_no    TEXT NOT NULL DEFAULT '',
  status_note    TEXT NOT NULL DEFAULT '',
  total_qty      INTEGER NOT NULL DEFAULT 0,
  total_amount   REAL NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT '',
  updated_at     TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_orders_list   ON orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_phone  ON orders(customer_phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);

/* ---------- 订单明细（替代 items JSON 数组，支持按商品统计） ---------- */
CREATE TABLE IF NOT EXISTS order_items (
  order_id   TEXT NOT NULL,
  line_no    INTEGER NOT NULL,
  product_id TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL DEFAULT '',
  spec       TEXT NOT NULL DEFAULT '',
  price      TEXT NOT NULL DEFAULT '',
  moq        TEXT NOT NULL DEFAULT '',
  qty        INTEGER NOT NULL DEFAULT 1,
  image      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (order_id, line_no),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id);

/* ---------- 客户档案：KV 时代是「全扫订单重算 + 回写」，现在改为实时聚合视图 ---------- */
CREATE VIEW IF NOT EXISTS v_customer_stats AS
SELECT
  o.customer_phone AS phone,
  (SELECT o2.customer_name FROM orders o2
    WHERE o2.customer_phone = o.customer_phone
    ORDER BY o2.created_at DESC LIMIT 1) AS name,
  SUM(CASE WHEN o.status <> 'cancelled' THEN 1 ELSE 0 END) AS order_count,
  SUM(CASE WHEN o.status <> 'cancelled' THEN
        (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) ELSE 0 END) AS total_items,
  SUM(CASE WHEN o.status <> 'cancelled' THEN o.total_qty ELSE 0 END) AS total_qty,
  ROUND(SUM(CASE WHEN o.status <> 'cancelled' THEN o.total_amount ELSE 0 END), 2) AS total_amount,
  MAX(o.created_at) AS last_order_at,
  (SELECT o3.id FROM orders o3
    WHERE o3.customer_phone = o.customer_phone
    ORDER BY o3.created_at DESC LIMIT 1) AS last_order_id
FROM orders o
WHERE o.customer_phone <> ''
GROUP BY o.customer_phone;

/* ---------- 迁移进度标记 ---------- */
CREATE TABLE IF NOT EXISTS migration_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
