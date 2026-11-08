-- 0002_order_items_base_price.sql — order_items 补 base_price（出厂价快照）
-- d1-baseline-when: SELECT 1 FROM pragma_table_info('order_items') WHERE name='base_price'
--   ↑ 供 scripts/d1-migrate.mjs 判断「存量库已具备该迁移的结构」：成立则登记为基线不重放。
--
-- 背景：阶段 1 读路径切 D1 后，后台订单页的成本列（public/admin.js 的 it.base_price）
--       与成本合计都要读这条快照。0001 建表时漏了该列，KV 时代它只存在于订单 JSON 里，
--       若不补列，切读后后台成本价会整体变成空。
--
-- 执行方式（远端库）：
--   npx wrangler d1 execute lightning-shop-db --remote --file migrations/0002_order_items_base_price.sql
--
-- 幂等说明：SQLite 的 ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS，重复执行会报
--   "duplicate column name: base_price"，属预期结果，可忽略。
--   历史已迁移的订单行该列为空串，后台按「无成本价」渲染，不影响金额与状态。

ALTER TABLE order_items ADD COLUMN base_price TEXT NOT NULL DEFAULT '';
