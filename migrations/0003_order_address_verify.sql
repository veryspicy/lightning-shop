-- 0003_order_address_verify.sql
-- 两件事：
--   1) 订单结构化收货地址：原来地址只能塞进 remark（≤200 字自由文本），
--      后台无法按地区筛选、发货时容易漏字段。改为独立列，remark 退回「备注」本位。
--      全部 DEFAULT ''，存量订单不需要回填，读出来就是空串，前端按「未填写」展示。
--   2) 查单短信/人机二次验证：公开查单原来只凭手机号一个因子，可被枚举拖库，
--      新增 verify_code 表支撑一次性验证码（只存哈希、限次数、限时效）。

/* ---------- 订单：结构化收货信息 ---------- */
ALTER TABLE orders ADD COLUMN receiver_name  TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN receiver_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN province       TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN city           TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN district       TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN address        TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN postal_code    TEXT NOT NULL DEFAULT '';

-- 后台按地区看单量（可选能力，走省份即可）
CREATE INDEX IF NOT EXISTS idx_orders_province ON orders(province, created_at DESC);

/* ---------- 查单验证码 ----------
 * 设计要点：
 * - 只落 code_hash（SHA-256(phone|purpose|code|salt)），明文验证码不落库、不进日志；
 * - attempts 落库而非内存：内存桶跨 isolate 各记各的，爆破计数必须持久化才有意义；
 * - consumed 一次性消费：验证通过的码立即作废，防重放；
 * - window_start 不建，按 created_at 索引做「N 分钟内发了几条」的计数查询。
 */
CREATE TABLE IF NOT EXISTS verify_code (
  id           TEXT PRIMARY KEY,
  target       TEXT NOT NULL,                     -- 手机号（目前只有查单场景）
  purpose      TEXT NOT NULL DEFAULT 'order_query',
  channel      TEXT NOT NULL DEFAULT 'sms',       -- sms / turnstile / email
  code_hash    TEXT NOT NULL DEFAULT '',
  salt         TEXT NOT NULL DEFAULT '',
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  consumed     INTEGER NOT NULL DEFAULT 0,
  expires_at   TEXT NOT NULL,                     -- ISO8601 UTC
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 频控：按 target+purpose 取最近 N 条；校验：按 target+purpose 取最新未消费一条
CREATE INDEX IF NOT EXISTS idx_verify_target ON verify_code(target, purpose, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_verify_created ON verify_code(created_at DESC);
