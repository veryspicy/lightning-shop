-- 访问统计（PV / UV / IP / 设备 / 浏览器 / 地域 / 渠道 / 漏斗）
--
-- 免费额度约束（Workers Free + D1 Free）：
--   1 次页面访问 ≈ 2 行写（tracking_event 1 行 + tracking_session 1 行 UPSERT）。
--   D1 Free 每天 10 万行写，日 PV 1 万约占 20%~30%，留足余量。
--   原始事件保留 30 天（tracking_event 由看板读取时顺带清理），会话 180 天。
--
-- 隐私：不落明文 IP / UA，只存 sha256(值 + 每日盐) 的十六进制串；visitor_id 为随机 UUID。
-- 查询口径：denormalize 到 day（东八区自然日，'YYYY-MM-DD'），避免每次查询都做时区换算。

CREATE TABLE IF NOT EXISTS tracking_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,              -- ISO 时间（UTC，用于时长/排序）
  day         TEXT NOT NULL,              -- 东八区自然日
  kind        TEXT NOT NULL,              -- pageview / view / add_cart / inquiry / search / order
  path        TEXT NOT NULL DEFAULT '',   -- 归一化路径（/、/admin、/p/[id]、/cart ...）
  raw_path    TEXT NOT NULL DEFAULT '',   -- 未归一化路径，保留 hash 具体值（/p/p01、/cart），仅供 Top 页面明细
  visitor_id  TEXT NOT NULL DEFAULT '',   -- cookie ls_vid（UV 口径）
  session_id  TEXT NOT NULL DEFAULT '',   -- cookie ls_sid
  ip_hash     TEXT NOT NULL DEFAULT '',
  ua_hash     TEXT NOT NULL DEFAULT '',
  device      TEXT NOT NULL DEFAULT '',   -- desktop / mobile / tablet
  os          TEXT NOT NULL DEFAULT '',
  browser     TEXT NOT NULL DEFAULT '',
  channel     TEXT NOT NULL DEFAULT '',   -- 与订单 channel 同源口径
  referrer    TEXT NOT NULL DEFAULT '',   -- 仅域名，不落完整 URL 查询串
  country     TEXT NOT NULL DEFAULT '',
  region      TEXT NOT NULL DEFAULT '',
  city        TEXT NOT NULL DEFAULT '',
  colo        TEXT NOT NULL DEFAULT '',
  status      INTEGER NOT NULL DEFAULT 0,
  is_bot      INTEGER NOT NULL DEFAULT 0,
  dur_ms      INTEGER,
  meta        TEXT
);

CREATE INDEX IF NOT EXISTS idx_te_day_kind  ON tracking_event (day, kind);
CREATE INDEX IF NOT EXISTS idx_te_day_path  ON tracking_event (day, path);
CREATE INDEX IF NOT EXISTS idx_te_day_rawp  ON tracking_event (day, raw_path);
CREATE INDEX IF NOT EXISTS idx_te_visitor   ON tracking_event (visitor_id, day);
CREATE INDEX IF NOT EXISTS idx_te_session   ON tracking_event (session_id);
CREATE INDEX IF NOT EXISTS idx_te_channel   ON tracking_event (day, channel);
CREATE INDEX IF NOT EXISTS idx_te_country   ON tracking_event (day, country);

CREATE TABLE IF NOT EXISTS tracking_session (
  id          TEXT PRIMARY KEY,           -- cookie ls_sid
  visitor_id  TEXT NOT NULL DEFAULT '',
  day         TEXT NOT NULL,              -- 会话开始日（跨天会话只算在开始日）
  started_at  TEXT NOT NULL,
  last_at     TEXT NOT NULL,
  entry_path  TEXT NOT NULL DEFAULT '',
  last_path   TEXT NOT NULL DEFAULT '',
  channel     TEXT NOT NULL DEFAULT '',
  referrer    TEXT NOT NULL DEFAULT '',
  country     TEXT NOT NULL DEFAULT '',
  city        TEXT NOT NULL DEFAULT '',
  device      TEXT NOT NULL DEFAULT '',
  os          TEXT NOT NULL DEFAULT '',
  browser     TEXT NOT NULL DEFAULT '',
  ip_hash     TEXT NOT NULL DEFAULT '',
  ua_hash     TEXT NOT NULL DEFAULT '',
  is_bot      INTEGER NOT NULL DEFAULT 0,
  pageviews   INTEGER NOT NULL DEFAULT 0,
  events      INTEGER NOT NULL DEFAULT 0, -- 加购 / 询价 / 搜索 / 下单
  duration_ms INTEGER NOT NULL DEFAULT 0,
  converted   INTEGER NOT NULL DEFAULT 0  -- 1 = 本会话内有下单行为
);

CREATE INDEX IF NOT EXISTS idx_ts_day       ON tracking_session (day);
CREATE INDEX IF NOT EXISTS idx_ts_visitor   ON tracking_session (visitor_id, day);
CREATE INDEX IF NOT EXISTS idx_ts_channel   ON tracking_session (day, channel);
