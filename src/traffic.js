/**
 * 访问统计模块（PV / UV / IP / 设备 / 浏览器 / 地域 / 渠道 / 漏斗）
 *
 * 免费额度设计（Workers Free + D1 Free，任何路径都不触发计费项）
 * 1. 一次页面访问 = 1 条 event + 1 次 session UPSERT（batch 提交，两次写算一次往返）。
 * 2. 无 Durable Object、无 Bot Management、无 Cron：清理挂在后台看板读取时顺带做。
 * 3. 写失败一律静默丢弃（统计不能影响页面可用性），只打日志不计费重试。
 * 4. 采样开关 TRAFFIC_SAMPLE（0~100，默认 100），PV 冲高时降采样保护额度。
 *
 * 隐私
 * - 不落明文 IP / UA：只存 sha256(值 + 每日盐) 前 32 位十六进制。
 * - referrer 只留域名，不留完整 URL 查询串。
 * - visitor_id / session_id 是随机 UUID，不含任何个人信息。
 */

/* 原始事件保留 30 天、会话 180 天：D1 Free 5GB 存储足够，且够做同比/环比回看 */
export const TRAFFIC_EVENT_TTL_DAYS = 30;
export const TRAFFIC_SESSION_TTL_DAYS = 180;

const TRAFFIC_DAYS_MIN = 7;
const TRAFFIC_DAYS_MAX = 90;
/* 单次清理上限：DELETE 命中行数也计入 D1 写额度，分批删避免一次打爆日额度 */
const PURGE_BATCH = 800;
let LAST_PURGE_AT = 0;

const BEACON_KINDS = new Set(['view', 'add_cart', 'inquiry', 'search', 'order', 'leave']);

const BOT_UA = /(bot\b|bot[/;_ -]|crawler|spider|slurp|bingpreview|facebookexternalhit|headlesschrome|phantomjs|curl\/|wget\/|python-requests|python-urllib|go-http-client|okhttp|scrapy|ahrefs|semrush|bytespider|petalbot|yandex|baiduspider|googlebot|sogou|exabot|mj12bot|dotbot|uptime|pingdom|monitor)/i;

/* ---------------- 基础工具 ---------------- */

function nowParts() {
  const now = new Date();
  /* 东八区自然日：与订单统计（d1.js 的 date(created_at, '+8 hours')）保持同一分桶口径 */
  const cn = new Date(now.getTime() + 8 * 3600 * 1000);
  const day = `${cn.getUTCFullYear()}-${String(cn.getUTCMonth() + 1).padStart(2, '0')}-${String(cn.getUTCDate()).padStart(2, '0')}`;
  return { iso: now.toISOString(), day };
}

export function trafficSinceDay(days) {
  const span = Math.min(TRAFFIC_DAYS_MAX, Math.max(TRAFFIC_DAYS_MIN, Number(days) || 30));
  const cn = new Date(Date.now() + 8 * 3600 * 1000 - (span - 1) * 86400000);
  const day = `${cn.getUTCFullYear()}-${String(cn.getUTCMonth() + 1).padStart(2, '0')}-${String(cn.getUTCDate()).padStart(2, '0')}`;
  return { span, sinceDay: day };
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i <= 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function cookieHeader(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly`;
}

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * 读取 / 补种访客与会话 cookie。
 * UV 口径 = ls_vid（一年期 cookie）；会话 = ls_sid（30 分钟滑动）。
 * HttpOnly 是刻意的：前端只读事件上报结果，不依赖 JS 改写 ID，避免被页面脚本伪造 UV。
 */
export function ensureTrackingCookies(request) {
  const c = parseCookies(request.headers.get('Cookie') || '');
  const setCookies = [];
  let vid = String(c.ls_vid || '');
  let sid = String(c.ls_sid || '');
  if (!ID_RE.test(vid)) {
    vid = crypto.randomUUID();
    setCookies.push(cookieHeader('ls_vid', vid, 31536000));
  }
  if (!ID_RE.test(sid)) {
    sid = crypto.randomUUID();
    setCookies.push(cookieHeader('ls_sid', sid, 1800));
  }
  return { vid, sid, setCookies };
}

export function withTrackingCookies(resp, setCookies) {
  if (!resp || !setCookies || !setCookies.length) return resp;
  try {
    const headers = new Headers(resp.headers);
    setCookies.forEach((c) => headers.append('Set-Cookie', c));
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
  } catch (_) {
    return resp;
  }
}

async function sha256Short(input) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(input)));
    return Array.from(new Uint8Array(buf)).slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    return '';
  }
}

/* 每日盐：同一天内可做「同 IP 次数」统计，跨天不可回溯关联，降低长期追踪性 */
function dailySalt(env, day) {
  return `${day}|${env.TRAFFIC_SALT || 'lightning-shop'}`;
}

function clientIp(request) {
  const h = request.headers;
  return String(h.get('CF-Connecting-IP') || (h.get('x-forwarded-for') || '').split(',')[0] || '').trim();
}

/* ---------------- UA / 渠道解析 ---------------- */

export function parseUa(ua) {
  const s = String(ua || '');
  const isBot = BOT_UA.test(s) ? 1 : 0;
  let device = 'desktop';
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(s)) device = 'tablet';
  else if (/Mobile|iPhone|iPod|Android|Windows Phone|HarmonyOS/i.test(s)) device = 'mobile';

  let os = '其它';
  if (/Windows NT/i.test(s)) os = 'Windows';
  else if (/iPhone|iPad|iPod/i.test(s)) os = 'iOS';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'macOS';
  else if (/HarmonyOS/i.test(s)) os = 'HarmonyOS';
  else if (/Linux|X11/i.test(s)) os = 'Linux';

  let browser = '其它';
  if (/MicroMessenger/i.test(s)) browser = '微信';
  else if (/AlipayClient/i.test(s)) browser = '支付宝';
  else if (/\bQQ\//i.test(s) || /QQBrowser/i.test(s)) browser = 'QQ浏览器';
  else if (/Edg\//i.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(s)) browser = 'Opera';
  else if (/Firefox\/|FxiOS/i.test(s)) browser = 'Firefox';
  else if (/Chrome\/|CriOS/i.test(s)) browser = 'Chrome';
  else if (/Safari\//i.test(s)) browser = 'Safari';
  else if (/bot|crawler|spider/i.test(s)) browser = '爬虫';

  return { device, os, browser, isBot };
}

/* 与前端 public/app.js 的 CHANNEL_RULES 完全同一套 slug：
 * 只有两边产出同样的值（wechat / douyin / baidu ...），渠道访问量才能和渠道订单量对齐口径。 */
const REF_HOST_MAP = [
  [/weixin|wechat|wx\.qq/i, 'wechat'],
  [/douyin|iesdouyin|tiktok/i, 'douyin'],
  [/xiaohongshu|xhslink/i, 'xiaohongshu'],
  [/weibo/i, 'weibo'],
  [/zhihu/i, 'zhihu'],
  [/baidu/i, 'baidu'],
  [/bing/i, 'bing'],
  [/google/i, 'google'],
  [/1688|taobao|tmall/i, 'alibaba'],
];

export function slugChannel(v) {
  return String(v === undefined || v === null ? '' : v).trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * 渠道口径与订单 channel 完全同源（见 public/app.js 的 detectChannel）：
 * utm_source → channel → src → from → referrer 域名 → direct。
 * 只有同口径才能做「渠道访问 → 渠道成交」的转化率，否则两边对不上。
 * 前端 beacon 会带上已判定好的 channel，这里优先采用（值仍按 slug 白名单收敛）。
 */
export function resolveChannel(url, referrerUrl, hint) {
  const fromHint = slugChannel(hint);
  if (fromHint) return fromHint;
  const p = url.searchParams;
  for (const key of ['utm_source', 'channel', 'src', 'from']) {
    const v = slugChannel(p.get(key));
    if (v) return v;
  }
  const ref = String(referrerUrl || '');
  if (ref) {
    /* 同源 referer 说明是站内跳转，与前端 detectChannel 同口径按 direct 处理，
     * 否则会把自家域名当成获客渠道，污染渠道分布与转化率分母 */
    const selfHost = String((url && url.hostname) || '').replace(/^www\./i, '').toLowerCase();
    if (selfHost) {
      try {
        const refHost = new URL(ref).hostname.replace(/^www\./i, '').toLowerCase();
        if (refHost === selfHost) return 'direct';
      } catch (_) { /* 非法 referer 继续走外链匹配 */ }
    }
    for (const [re, name] of REF_HOST_MAP) if (re.test(ref)) return name;
    try {
      const host = new URL(ref).hostname.replace(/^www\./, '');
      return slugChannel(host) || 'referral';
    } catch (_) { /* 非法 referrer 落到下面 */ }
  }
  return 'direct';
}

function referrerHost(referrerUrl, selfHost) {
  const ref = String(referrerUrl || '');
  if (!ref) return '';
  try {
    const host = new URL(ref).hostname.toLowerCase();
    if (host === String(selfHost || '').toLowerCase()) return '';
    return host.slice(0, 64);
  } catch (_) {
    return '';
  }
}

/** 路径归一化：站内 hash 路由压成有意义的落地页桶，避免每个商品 id 各占一行 */
export function normalizePath(rawPath) {
  let p = String(rawPath || '').trim();
  if (!p) return '/';
  if (p.startsWith('http://') || p.startsWith('https://')) {
    try { p = new URL(p).pathname + (new URL(p).hash || ''); } catch (_) { p = '/'; }
  }
  /* 兼容三种上报形态：前端 location.hash（'#/p/1'）、整段 URL 拼接（'/#/p/1'）、首屏 pathname（'/p/1'），
   * 统一剥掉开头的 '/' + '#' 再补 '/'，否则 '/#/p/1' 会落进兜底桶 '/#/p' */
  p = p.split('?')[0].replace(/^\/?#/, '');
  if (!p.startsWith('/')) p = `/${p}`;
  if (p === '/' || p === '') return '/';
  const segs = p.split('/').filter(Boolean);
  if (segs.length === 1) return `/${segs[0]}`;
  /* /p/<id>、/b/<brand> 归并成桶；其余保留前两段，杜绝 id 型长尾 */
  if (segs[0] === 'p') return '/p/[id]';
  if (segs[0] === 'b') return '/b/[brand]';
  return `/${segs.slice(0, 2).join('/')}`;
}

/** 未归一化路径：保留 hash 里的具体目标（/p/p01、/cart），只去协议与查询串并限长，仅供「Top 页面」明细 */
export function rawPathOf(rawPath) {
  let p = String(rawPath || '').trim();
  if (!p) return '/';
  if (p.startsWith('http://') || p.startsWith('https://')) {
    try { p = new URL(p).pathname + (new URL(p).hash || ''); } catch (_) { p = '/'; }
  }
  p = p.split('?')[0].replace(/^\/?#/, '');
  if (!p.startsWith('/')) p = `/${p}`;
  return p.slice(0, 96);
}

/** 只认同源静态页面请求：排除 API、图片、带扩展名的静态资源与运维探测路径 */
export function isPageRequest(url) {
  const p = url.pathname;
  if (!p || p === '/') return true;
  if (p.startsWith('/api/') || p.startsWith('/img/') || p.startsWith('/assets/')) return false;
  if (/\.[a-z0-9]{1,6}$/i.test(p)) return false;
  return true;
}

function shouldSample(env) {
  const rate = Number(env.TRAFFIC_SAMPLE);
  if (!Number.isFinite(rate) || rate >= 100) return true;
  if (rate <= 0) return false;
  return Math.random() * 100 < rate;
}

/* ---------------- 写入 ---------------- */

function buildEventRow(env, req, fields) {
  const { iso, day } = nowParts();
  return {
    ts: iso,
    day,
    kind: fields.kind,
    path: normalizePath(fields.path),
    raw_path: fields.rawPath || rawPathOf(fields.path),
    visitor_id: fields.vid,
    session_id: fields.sid,
    device: fields.ua.device,
    os: fields.ua.os,
    browser: fields.ua.browser,
    channel: fields.channel,
    referrer: fields.referrer,
    country: String(fields.cf.country || '').slice(0, 8),
    region: String(fields.cf.region || '').slice(0, 32),
    city: String(fields.cf.city || '').slice(0, 32),
    colo: String(fields.cf.colo || '').slice(0, 8),
    status: Number(fields.status || 0),
    is_bot: fields.ua.isBot,
    dur_ms: fields.durMs === undefined || fields.durMs === null ? null : Math.max(0, Math.min(6 * 3600 * 1000, Math.round(fields.durMs))),
    meta: fields.meta ? String(fields.meta).slice(0, 200) : null,
    ip_hash: fields.ipHash,
    ua_hash: fields.uaHash,
  };
}

async function writeTraffic(env, row, session) {
  if (!env.DB) return false;
  const eventStmt = env.DB.prepare(`
    INSERT INTO tracking_event (ts, day, kind, path, raw_path, visitor_id, session_id, ip_hash, ua_hash,
      device, os, browser, channel, referrer, country, region, city, colo, status, is_bot, dur_ms, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    row.ts, row.day, row.kind, row.path, row.raw_path, row.visitor_id, row.session_id, row.ip_hash, row.ua_hash,
    row.device, row.os, row.browser, row.channel, row.referrer, row.country, row.region, row.city,
    row.colo, row.status, row.is_bot, row.dur_ms, row.meta,
  );
  /* 会话 UPSERT：pageviews/events 累加，时长取最大（leave 事件给最终值），
   * duration_ms 用 MAX 而不是累加，避免多次 beacon 叠加成假超长停留，也免了写前读。 */
  const sessionStmt = env.DB.prepare(`
    INSERT INTO tracking_session (id, visitor_id, day, started_at, last_at, entry_path, last_path,
      channel, referrer, country, city, device, os, browser, ip_hash, ua_hash, is_bot,
      pageviews, events, duration_ms, converted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_at = excluded.last_at,
      last_path = excluded.last_path,
      pageviews = tracking_session.pageviews + excluded.pageviews,
      events = tracking_session.events + excluded.events,
      duration_ms = MAX(tracking_session.duration_ms, excluded.duration_ms),
      converted = MAX(tracking_session.converted, excluded.converted),
      channel = CASE WHEN tracking_session.channel = '' OR tracking_session.channel = 'direct'
                     THEN excluded.channel ELSE tracking_session.channel END
  `).bind(
    session.id, session.visitor_id, session.day, row.ts, row.ts,
    session.entryPath, row.path, session.channel, session.referrer,
    row.country, row.city, row.device, row.os, row.browser, row.ip_hash, row.ua_hash, row.is_bot,
    session.pageviews, session.events, session.durationMs, session.converted,
  );
  try {
    await env.DB.batch([eventStmt, sessionStmt]);
    return true;
  } catch (e) {
    /* 统计失败绝不影响页面：额度触顶、表未迁移等情况在这里静默降级 */
    console.error('tracking_write_failed', e && e.message);
    return false;
  }
}

/**
 * 服务端页面访问采集（首屏 HTML 请求）。
 * 一个 PV 只写一次 event + 一次 session 累加，交给 ctx.waitUntil 异步执行，
 * 不占用页面响应时间。
 */
export async function recordPageView(env, request, url, ids) {
  if (!env.DB) return;
  if (request.method !== 'GET' || !isPageRequest(url)) return;
  if (!shouldSample(env)) return;
  const ua = parseUa(request.headers.get('User-Agent'));
  const ip = clientIp(request);
  const salt = dailySalt(env, nowParts().day);
  const [ipHash, uaHash] = await Promise.all([
    ip ? sha256Short(`${ip}|${salt}`) : Promise.resolve(''),
    sha256Short(`${String(request.headers.get('User-Agent') || '')}|${salt}`),
  ]);
  const referrer = referrerHost(request.headers.get('Referer'), url.hostname);
  const field = {
    kind: 'pageview',
    path: url.pathname === '/admin' ? '/admin' : url.pathname,
    vid: ids.vid,
    sid: ids.sid,
    ua,
    ipHash,
    uaHash,
    channel: resolveChannel(url, request.headers.get('Referer')),
    referrer,
    cf: request.cf || {},
    status: 200,
  };
  const row = buildEventRow(env, request, field);
  await writeTraffic(env, row, {
    id: ids.sid,
    visitor_id: ids.vid,
    day: row.day,
    entryPath: row.path,
    channel: row.channel,
    referrer: row.referrer,
    pageviews: 1,
    events: 0,
    durationMs: 0,
    converted: 0,
  });
}

/* /api/track 的孤立限流桶：防刷不靠 KV（KV 每天只 1000 写），isolate 内存桶足够拦异常洪峰 */
const TRACK_BUCKET = new Map();
const TRACK_WINDOW_MS = 60 * 1000;
const TRACK_MAX_PER_WINDOW = 120;

function trackAllowed(key) {
  const now = Date.now();
  const rec = TRACK_BUCKET.get(key);
  if (!rec || now - rec.start > TRACK_WINDOW_MS) {
    if (TRACK_BUCKET.size > 5000) TRACK_BUCKET.clear();
    TRACK_BUCKET.set(key, { start: now, count: 1 });
    return true;
  }
  rec.count += 1;
  return rec.count <= TRACK_MAX_PER_WINDOW;
}

function beaconJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * 前端 beacon 上报（站内 hash 路由、加购、询价、搜索、下单、离开）。
 * 身份与地理维度一律以服务端 request 为准，前端传的 id 只做校验，不接受伪造的 IP/UA。
 */
export async function handleTrackRequest(request, env, url) {
  if (request.method !== 'POST') return beaconJson({ ok: false, error: 'method_not_allowed' }, 405);
  const ids = ensureTrackingCookies(request);
  if (!trackAllowed(clientIp(request) || ids.vid)) return beaconJson({ ok: true, throttled: 1 });
  let body = null;
  try {
    const text = await request.text();
    if (text.length > 2048) return beaconJson({ ok: false, error: 'too_large' }, 413);
    body = text ? JSON.parse(text) : null;
  } catch (_) {
    return beaconJson({ ok: false, error: 'bad_json' }, 400);
  }
  const kind = String((body && body.kind) || '').trim();
  if (!BEACON_KINDS.has(kind)) return beaconJson({ ok: false, error: 'bad_kind' }, 400);

  if (!env.DB) return beaconJson({ ok: true, stored: 0 });
  if (!shouldSample(env)) return beaconJson({ ok: true, sampled: 1 });

  const ua = parseUa(request.headers.get('User-Agent'));
  const salt = dailySalt(env, nowParts().day);
  const ip = clientIp(request);
  const [ipHash, uaHash] = await Promise.all([
    ip ? sha256Short(`${ip}|${salt}`) : Promise.resolve(''),
    sha256Short(`${String(request.headers.get('User-Agent') || '')}|${salt}`),
  ]);
  const referrer = referrerHost(request.headers.get('Referer'), url.hostname);
  const path = normalizePath((body && body.path) || '/');
  /* 归一化会丢掉 hash 里的具体目标，另存一份未归一化路径供「Top 页面」明细 */
  const rawPath = rawPathOf((body && body.path) || '/');
  const durMs = Number(body && body.durationMs);
  const channel = resolveChannel(url, request.headers.get('Referer'), body && body.channel);

  /* leave 只续会话时长，不落事件行：省一半写额度，停留时长是唯一需要它的指标 */
  if (kind === 'leave') {
    if (!Number.isFinite(durMs) || durMs <= 0) return beaconJson({ ok: true, stored: 0 });
    const { iso } = nowParts();
    try {
      await env.DB.prepare(`
        UPDATE tracking_session
        SET last_at = ?, duration_ms = MIN(?, MAX(duration_ms, ?))
        WHERE id = ?
      `).bind(iso, 6 * 3600 * 1000, Math.round(durMs), ids.sid).run();
      return beaconJson({ ok: true, stored: 1 });
    } catch (e) {
      console.error('tracking_leave_failed', e && e.message);
      return beaconJson({ ok: true, stored: 0 });
    }
  }

  const row = buildEventRow(env, request, {
    kind,
    path,
    rawPath,
    vid: ids.vid,
    sid: ids.sid,
    ua,
    ipHash,
    uaHash,
    channel,
    referrer,
    cf: request.cf || {},
    status: 200,
    durMs: Number.isFinite(durMs) ? durMs : null,
    meta: body && body.meta ? JSON.stringify(body.meta).slice(0, 200) : null,
  });
  const isPv = kind === 'view';
  const stored = await writeTraffic(env, row, {
    id: ids.sid,
    visitor_id: ids.vid,
    day: row.day,
    entryPath: row.path,
    channel: row.channel,
    referrer: row.referrer,
    pageviews: isPv ? 1 : 0,
    events: isPv ? 0 : 1,
    durationMs: 0,
    converted: kind === 'order' ? 1 : 0,
  });
  return beaconJson({ ok: true, stored: stored ? 1 : 0 });
}

/* ---------------- 清理 ---------------- */

/**
 * TTL 清理：由后台看板读取顺带触发（不配 Cron，Workers Free 的 Cron 只影响触发次数，
 * 但每次触发都是独立调用；挂在已有的低频管理请求上更省）。
 * 每次最多删 PURGE_BATCH 行，让写额度消耗可预期。
 */
export async function purgeTraffic(env) {
  if (!env.DB) return false;
  /* isolate 级节流：看板每次刷新都会调到这里，每小时真正清理一次即可，避免反复扫表耗读额度 */
  const now = Date.now();
  if (now - LAST_PURGE_AT < 3600 * 1000) return false;
  LAST_PURGE_AT = now;
  const eventCut = dayStringOffset(-TRAFFIC_EVENT_TTL_DAYS);
  const sessionCut = dayStringOffset(-TRAFFIC_SESSION_TTL_DAYS);
  try {
    /* 注意：SQLite 默认不支持 DELETE ... LIMIT，分批必须走「子查询选主键」这种写法 */
    await env.DB.batch([
      env.DB.prepare('DELETE FROM tracking_event WHERE id IN (SELECT id FROM tracking_event WHERE day < ? LIMIT ?)').bind(eventCut, PURGE_BATCH),
      env.DB.prepare('DELETE FROM tracking_session WHERE id IN (SELECT id FROM tracking_session WHERE day < ? LIMIT ?)').bind(sessionCut, PURGE_BATCH),
    ]);
    return true;
  } catch (e) {
    console.error('tracking_purge_failed', e && e.message);
    return false;
  }
}

function dayStringOffset(offsetDays) {
  const cn = new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400000);
  return `${cn.getUTCFullYear()}-${String(cn.getUTCMonth() + 1).padStart(2, '0')}-${String(cn.getUTCDate()).padStart(2, '0')}`;
}

/* ---------------- 聚合查询 ---------------- */

/**
 * 看板流量统计。全部聚合下推到 D1（按扫描行计费，不按请求数），
 * 返回结构与 d1SalesStats 对齐：{ ok, days, range, summary, trend, ... }。
 */
export async function d1TrafficStats(env, days = 30) {
  if (!env.DB) return { ok: false, reason: 'no_db' };
  const { span, sinceDay } = trafficSinceDay(days);
  const pvKind = "kind IN ('pageview','view')";
  try {
    const summarySql = `
      SELECT
        SUM(CASE WHEN ${pvKind} THEN 1 ELSE 0 END) AS pv,
        COUNT(DISTINCT CASE WHEN ${pvKind} THEN visitor_id END) AS uv,
        COUNT(DISTINCT CASE WHEN ${pvKind} THEN ip_hash END) AS ip_count,
        COUNT(DISTINCT CASE WHEN ${pvKind} THEN session_id END) AS sessions,
        SUM(CASE WHEN kind IN ('add_cart','inquiry','search','order') THEN 1 ELSE 0 END) AS events
      FROM tracking_event
      WHERE day >= ? AND is_bot = 0`;
    /* 爬虫流量单独统计：主查询已按 is_bot = 0 过滤，bot 数必须独立查询，否则恒为 0 */
    const botSql = `
      SELECT SUM(CASE WHEN ${pvKind} THEN 1 ELSE 0 END) AS bot_pv
      FROM tracking_event
      WHERE day >= ? AND is_bot = 1`;
    const sessionSql = `
      SELECT
        COUNT(*) AS sessions,
        SUM(CASE WHEN pageviews <= 1 THEN 1 ELSE 0 END) AS bounced,
        SUM(CASE WHEN converted = 1 THEN 1 ELSE 0 END) AS converted,
        ROUND(AVG(duration_ms)) AS avg_duration,
        SUM(CASE WHEN pageviews >= 2 THEN 1 ELSE 0 END) AS multi_page
      FROM tracking_session
      WHERE day >= ? AND is_bot = 0`;
    const trendSql = `
      SELECT day,
        SUM(CASE WHEN ${pvKind} THEN 1 ELSE 0 END) AS pv,
        COUNT(DISTINCT CASE WHEN ${pvKind} THEN visitor_id END) AS uv
      FROM tracking_event
      WHERE day >= ? AND is_bot = 0
      GROUP BY day ORDER BY day ASC`;
    const deviceSql = `
      SELECT device AS name, COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS uv
      FROM tracking_event
      WHERE day >= ? AND is_bot = 0 AND ${pvKind}
      GROUP BY device ORDER BY pv DESC`;
    const browserSql = `
      SELECT browser AS name, COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS uv
      FROM tracking_event
      WHERE day >= ? AND is_bot = 0 AND ${pvKind}
      GROUP BY browser ORDER BY pv DESC LIMIT 8`;
    const osSql = `
      SELECT os AS name, COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS uv
      FROM tracking_event
      WHERE day >= ? AND is_bot = 0 AND ${pvKind}
      GROUP BY os ORDER BY pv DESC LIMIT 8`;
    const channelSql = `
      SELECT COALESCE(NULLIF(channel, ''), 'direct') AS channel,
             COUNT(*) AS sessions,
             SUM(CASE WHEN converted = 1 THEN 1 ELSE 0 END) AS converted,
             SUM(pageviews) AS pv
      FROM tracking_session
      WHERE day >= ? AND is_bot = 0
      GROUP BY COALESCE(NULLIF(channel, ''), 'direct')
      ORDER BY sessions DESC LIMIT 10`;
    const geoSql = `
      SELECT COALESCE(NULLIF(country, ''), '未知') AS country,
             COALESCE(NULLIF(city, ''), '未知') AS city,
             COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS uv
      FROM tracking_event
      WHERE day >= ? AND is_bot = 0 AND ${pvKind}
      GROUP BY country, city ORDER BY pv DESC LIMIT 10`;
    const landingSql = `
      SELECT path, COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS uv
      FROM tracking_event
      WHERE day >= ? AND is_bot = 0 AND ${pvKind}
      GROUP BY path ORDER BY pv DESC LIMIT 10`;
    /* 与 landing 同源，但按未归一化路径分组：站内 hash 路由下才能看出具体商品页的热度 */
    const topPagesSql = `
      SELECT raw_path AS path, COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS uv
      FROM tracking_event
      WHERE day >= ? AND is_bot = 0 AND ${pvKind} AND raw_path <> ''
      GROUP BY raw_path ORDER BY pv DESC LIMIT 15`;
    const funnelSql = `
      SELECT
        COUNT(DISTINCT CASE WHEN ${pvKind} AND path = '/' THEN session_id END) AS home,
        COUNT(DISTINCT CASE WHEN ${pvKind} AND path = '/p/[id]' THEN session_id END) AS detail,
        COUNT(DISTINCT CASE WHEN kind = 'add_cart' THEN session_id END) AS add_cart,
        COUNT(DISTINCT CASE WHEN kind = 'order' THEN session_id END) AS orders,
        COUNT(DISTINCT CASE WHEN kind = 'search' THEN session_id END) AS searched
      FROM tracking_event
      WHERE day >= ? AND is_bot = 0`;

    const [summaryRs, sessionRs, trendRs, deviceRs, browserRs, osRs, channelRs, geoRs, landingRs, topPagesRs, funnelRs, botRs] =
      await Promise.all([
        env.DB.prepare(summarySql).bind(sinceDay).all(),
        env.DB.prepare(sessionSql).bind(sinceDay).all(),
        env.DB.prepare(trendSql).bind(sinceDay).all(),
        env.DB.prepare(deviceSql).bind(sinceDay).all(),
        env.DB.prepare(browserSql).bind(sinceDay).all(),
        env.DB.prepare(osSql).bind(sinceDay).all(),
        env.DB.prepare(channelSql).bind(sinceDay).all(),
        env.DB.prepare(geoSql).bind(sinceDay).all(),
        env.DB.prepare(landingSql).bind(sinceDay).all(),
        env.DB.prepare(topPagesSql).bind(sinceDay).all(),
        env.DB.prepare(funnelSql).bind(sinceDay).all(),
        env.DB.prepare(botSql).bind(sinceDay).all(),
      ]);

    const num = (v) => (v === null || v === undefined ? 0 : Number(v));
    const ratio = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
    const s = (summaryRs.results || [])[0] || {};
    const se = (sessionRs.results || [])[0] || {};
    const f = (funnelRs.results || [])[0] || {};

    const byDay = new Map();
    for (const row of trendRs.results || []) {
      byDay.set(String(row.day), { pv: num(row.pv), uv: num(row.uv) });
    }
    /* 补齐空白天：趋势图缺日会错位，与销售趋势同样的处理方式 */
    const trend = [];
    for (let i = span - 1; i >= 0; i -= 1) {
      const key = dayStringOffset(-i);
      const hit = byDay.get(key) || { pv: 0, uv: 0 };
      trend.push({ date: key, pv: hit.pv, uv: hit.uv });
    }

    const pv = num(s.pv);
    const uv = num(s.uv);
    const sessions = num(se.sessions);
    const bounced = num(se.bounced);
    return {
      ok: true,
      days: span,
      range: { from: trend[0].date, to: trend[trend.length - 1].date },
      summary: {
        pv,
        uv,
        sessions,
        ip_count: num(s.ip_count),
        events: num(s.events),
        bot_pv: num((botRs.results || [])[0] && (botRs.results || [])[0].bot_pv),
        pv_per_uv: uv > 0 ? Math.round((pv / uv) * 100) / 100 : 0,
        bounce_rate: ratio(bounced, sessions),
        avg_duration: num(se.avg_duration),
        converted_sessions: num(se.converted),
        conversion_rate: ratio(num(se.converted), sessions),
      },
      funnel: {
        home: num(f.home),
        detail: num(f.detail),
        searched: num(f.searched),
        add_cart: num(f.add_cart),
        orders: num(f.orders),
        /* 漏斗各环节统一以「进站会话」为基数：环节间相除在真实流量下会出现 >100%
           （用户可直接落地详情页或从购物车返回），统一基数才能保证单调递减。 */
        detail_rate: ratio(num(f.detail), sessions),
        cart_rate: ratio(num(f.add_cart), sessions),
        order_rate: ratio(num(f.orders), sessions),
      },
      trend,
      device: (deviceRs.results || []).map((r) => ({ name: String(r.name || '未知'), pv: num(r.pv), uv: num(r.uv) })),
      browser: (browserRs.results || []).map((r) => ({ name: String(r.name || '未知'), pv: num(r.pv), uv: num(r.uv) })),
      os: (osRs.results || []).map((r) => ({ name: String(r.name || '未知'), pv: num(r.pv), uv: num(r.uv) })),
      channels: (channelRs.results || []).map((r) => ({
        channel: String(r.channel || 'direct'),
        sessions: num(r.sessions),
        pv: num(r.pv),
        converted: num(r.converted),
        conversion_rate: ratio(num(r.converted), num(r.sessions)),
      })),
      geo: (geoRs.results || []).map((r) => ({ country: String(r.country), city: String(r.city), pv: num(r.pv), uv: num(r.uv) })),
      landing: (landingRs.results || []).map((r) => ({ path: String(r.path || '/'), pv: num(r.pv), uv: num(r.uv) })),
      top_pages: (topPagesRs.results || []).map((r) => ({ path: String(r.path || '/'), pv: num(r.pv), uv: num(r.uv) })),
      ttl: { events_days: TRAFFIC_EVENT_TTL_DAYS, sessions_days: TRAFFIC_SESSION_TTL_DAYS },
    };
  } catch (e) {
    console.error('traffic_stats_failed', e && e.message);
    return { ok: false, reason: 'error' };
  }
}
