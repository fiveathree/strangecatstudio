// 奇怪貓工作室 booking API — Cloudflare Worker + D1.
//
// Public:
//   GET  /api/slots?studio=tn&from=YYYY-MM-DD&days=14   places left per slot
//   POST /api/bookings                                  make a booking
//   POST /api/bookings/payment                          report transfer's last five digits
// Studio only (Authorization: Bearer <ADMIN_TOKEN>):
//   GET   /api/admin/bookings?from=YYYY-MM-DD
//   PATCH /api/admin/bookings/:id        { status }
//   POST  /api/admin/closures            { studio, date, reason }
//   DELETE /api/admin/closures           { studio, date }
//   PUT   /api/admin/settings            { notify_emails } or { points: { earnPer, pointValue, classPoints } }
//   GET/POST /api/admin/products, PUT/DELETE /api/admin/products/:id
//   POST  /api/admin/images              (photo bytes) -> { id, url }
//   POST  /api/admin/categories { kind, name }, PUT/DELETE /api/admin/categories/:id
//   GET   /api/admin/orders, PATCH /api/admin/orders/:id   { status, tracking, admin_note }
//   GET/POST /api/admin/customers, GET/PUT /api/admin/customers/:phone
//   POST  /api/admin/customers/:phone/points   { delta, reason }
//   GET   /api/admin/points                    loyalty rules, totals, recent ledger
//   GET   /api/admin/report                    sales and customer figures
// Public shop:
//   GET  /api/products, GET /api/images/:id
//   POST /api/orders                 place an order
//   POST /api/orders/payment         report transfer's last five digits
//   POST /api/orders/lookup          { code, phone } -> the customer's own order
//   POST /api/points/balance         { code, phone } -> points the customer can spend
//   POST /api/promos/check           { code, subtotal } -> what the code takes off
// Back office sign-in and owner-only pages:
//   POST /api/admin/login { username, password } -> { token }; GET /api/admin/me; POST /api/admin/logout
//   /api/admin/staff, /api/admin/promos, /api/admin/audit, /api/admin/backup, PUT /api/admin/password

// ---- Settings the studio is likely to change -------------------------------
export const CONFIG = {
  addresses: { tn: '台南市北區長榮路四段40號', kh: '高雄市中華五路939巷24號' },
  slotMinutes: 90,      // length of one bookable slot
  capacity: 4,          // people per slot, per studio (classes and visits share it)
  minDaysAhead: 1,      // earliest bookable day: tomorrow
  maxDaysAhead: 60,
  maxPeoplePerBooking: 4,
  studios: {
    // weekdays: 0 = Sunday … 6 = Saturday
    tn: { name: '台南工作室', weekdays: [0, 1, 2, 3, 4, 5, 6], open: '13:30', close: '21:00' },
    kh: { name: '高雄工作室', weekdays: [2, 3, 4, 5, 6], open: '13:30', close: '19:30' },
  },
  types: { class: '琉璃體驗課', visit: '到訪鑑賞' },
  // The same people run both studios, so they can only be in one city a day.
  // A studio is closed on any date that already has a booking at one of the
  // studios listed for it here. Use empty lists to let both open the same day.
  blockedBy: { tn: ['kh'], kh: ['tn'] },
};

// Shop: how an order can reach the customer, and what each way costs (NT$).
// `ask` is what the customer has to fill in; leave it out for studio pick-up.
export const SHOP = {
  shipping: {
    store: { name: '7-11 取貨', fee: 60, ask: '取貨門市名稱' },
    home: { name: '宅配到府', fee: 120, ask: '收件地址' },
    tn: { name: '台南工作室自取', fee: 0 },
    kh: { name: '高雄工作室自取', fee: 0 },
  },
  maxQtyPerItem: 10,
  maxUnpaidOrders: 3,   // per phone number
  // Loyalty points: one point for every `earnPer` NT$ of goods (shipping excluded),
  // given when the studio marks the order as paid. Each point is worth `pointValue` NT$
  // off a later order. Set earnPer to 0 to switch points off.
  // These are only the starting values: the studio changes them under 積分管理 in the back office.
  // classPoints = points given when a class booking is confirmed (0 = none).
  points: { earnPer: 100, pointValue: 1, classPoints: 0 },
};
// -----------------------------------------------------------------------------

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const STATUSES = ['pending', 'reported', 'confirmed', 'cancelled'];

// Shop catalogue
// Products are filed two ways, both editable from the admin page (table `categories`):
// 'stone' = what it is made of (主石), 'cat' = what kind of piece it is (類別).
const CATEGORY_KINDS = { stone: '主石', cat: '類別' };
const SUPPLIES = ['stock', 'made'];
const PRODUCT_STATUSES = ['active', 'soldout', 'hidden'];
const MAX_IMAGE_BYTES = 700 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
// pending = waiting for the transfer, reported = customer sent the last five digits,
// paid = studio saw the money, shipped = on its way or ready to collect, done = received.
const ORDER_STATUSES = ['pending', 'reported', 'paid', 'shipped', 'done', 'cancelled'];

function minutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function hhmm(total) {
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}

/** Start times of every slot that fits inside a studio's opening hours. */
export function slotTimes(studio) {
  const s = CONFIG.studios[studio];
  const out = [];
  for (let t = minutes(s.open); t + CONFIG.slotMinutes <= minutes(s.close); t += CONFIG.slotMinutes) out.push(hhmm(t));
  return out;
}

/** Today's date in Taipei as YYYY-MM-DD, whatever timezone the server runs in. */
export function taipeiToday(now = Date.now()) {
  return new Date(now + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}

function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekday(date) {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}

function isDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
}

/** Why a date can't be booked at this studio, or null when it can. */
function dateProblem(studio, date, today) {
  if (date < addDays(today, CONFIG.minDaysAhead)) return '這一天已不接受預約';
  if (date > addDays(today, CONFIG.maxDaysAhead)) return '尚未開放這一天的預約';
  if (!CONFIG.studios[studio].weekdays.includes(weekday(date))) return '工作室當天休息';
  return null;
}

function blockers(studio) {
  return CONFIG.blockedBy[studio] || [];
}

function closedForOtherStudio(studio) {
  return '當日於' + blockers(studio).map((s) => CONFIG.studios[s].name).join('、') + '服務';
}

async function getSetting(env, key) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : '';
}

/** Shop-wide choices the owner makes under 設定. */
async function shopSettings(env) {
  const rows = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('bank_info', 'free_ship_over', 'customer_emails')").all();
  const saved = Object.fromEntries(rows.results.map((r) => [r.key, r.value]));
  return {
    bankInfo: saved.bank_info || '',                       // shown to customers who owe a transfer
    freeShipOver: Math.max(Number(saved.free_ship_over) || 0, 0), // goods total that earns free shipping; 0 = never
    customerEmails: saved.customer_emails !== '0',         // email customers about their orders and bookings
  };
}

const money = (n) => 'NT$' + Number(n).toLocaleString('en-US');

/** The email a customer gets about their own booking, or null when this change isn't worth one. */
function bookingMail(event, b, shop, site) {
  if (!b.email) return null;
  const when = b.date + ' ' + b.time;
  const where = CONFIG.studios[b.studio].name + '（' + CONFIG.addresses[b.studio] + '）';
  const what = CONFIG.types[b.type] + '・' + b.people + ' 位';
  const foot = ['', '預約編號：' + b.code, '需要改期或取消，請用官方 LINE 聯絡我們。', '', '奇怪貓工作室 Studio Strange Cat', site];
  if (event === 'booked' && b.status === 'pending') {
    return { to: b.email, subject: '【奇怪貓工作室】已收到你的預約 ' + when, body: [b.name + ' 你好，', '', '我們已為你保留名額：', when, where, what, '',
      '請在三天內完成匯款，並到網站回報帳號末五碼，確認後才算預約成功。', shop.bankInfo ? '匯款資料：' + shop.bankInfo : '匯款資料請用官方 LINE 向我們索取。', ...foot].join('\n') };
  }
  if ((event === 'booked' || event === 'status') && b.status === 'confirmed') {
    return { to: b.email, subject: '【奇怪貓工作室】預約已確認 ' + when, body: [b.name + ' 你好，', '', '你的預約已確認，到時見！', when, where, what, ...foot].join('\n') };
  }
  if (event === 'status' && b.status === 'cancelled') {
    return { to: b.email, subject: '【奇怪貓工作室】預約已取消 ' + when, body: [b.name + ' 你好，', '', '以下預約已取消：', when, where, what, ...foot].join('\n') };
  }
  return null;
}

/** The same, for a shop order. */
function orderMail(event, o, shop, site) {
  if (!o.email) return null;
  const lines = (o.items || []).map((it) => '・' + it.name + (it.options ? '（' + it.options + '）' : '') + ' × ' + it.qty + '　' + money(it.price * it.qty));
  const sums = [
    o.promo_discount ? '優惠碼 ' + o.promo_code + '　−' + money(o.promo_discount) : '',
    o.discount ? '積分折抵　−' + money(o.discount) : '',
    SHOP.shipping[o.ship_method].name + (o.ship_to ? '：' + o.ship_to : '') + '　運費 ' + (o.ship_fee ? money(o.ship_fee) : '免運'),
    '合計 ' + money(o.total),
  ].filter(String);
  const foot = ['', '訂單編號：' + o.code, '查詢訂單：' + site + 'cart.html#lookup', '', '奇怪貓工作室 Studio Strange Cat'];
  const mail = (subject, intro) => ({ to: o.email, subject: '【奇怪貓工作室】' + subject, body: [o.name + ' 你好，', '', ...intro, '', ...lines, ...sums, ...foot].join('\n') });
  if (event === 'order') {
    return mail('已收到你的訂單 ' + o.code, ['謝謝你的訂購！請匯款 ' + money(o.total) + '，再到「查詢訂單」回報帳號末五碼，我們確認後就會出貨。',
      shop.bankInfo ? '匯款資料：' + shop.bankInfo : '匯款資料請用官方 LINE 向我們索取。']);
  }
  if (event !== 'order_status') return null;
  if (o.status === 'paid') return mail('已確認收款 ' + o.code, ['我們已收到你的款項，正在準備出貨。' + (o.points_earned ? '這筆訂單為你累積了 ' + o.points_earned + ' 點積分。' : '')]);
  if (o.status === 'shipped') {
    const pickup = !SHOP.shipping[o.ship_method].ask;
    return mail((pickup ? '可以取貨了 ' : '已出貨 ') + o.code, [pickup ? '你的訂單已準備好，歡迎在營業時間到工作室取貨。' : '你的訂單已寄出。' + (o.tracking ? '寄件編號：' + o.tracking : '')]);
  }
  if (o.status === 'cancelled') return mail('訂單已取消 ' + o.code, ['以下訂單已取消。如已匯款，我們會與你聯絡退款。']);
  return null;
}

/** Posts to the studio's notifier (a Google Apps Script web app): it emails the studio, and the customer when `customer` is set. */
function send(env, ctx, build) {
  if (!env.NOTIFY_URL) return;
  const work = Promise.all([getSetting(env, 'notify_emails'), shopSettings(env)]).then(([emails, shop]) => {
    const site = env.SITE_URL || '';
    const payload = build(shop, site);
    payload.emails = emails ? emails.split(',') : []; // studio recipients chosen on the admin page
    if (!shop.customerEmails || !payload.customer) delete payload.customer;
    return fetch(env.NOTIFY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  }).catch((err) => console.error('notify failed', err));
  // Let the reply go out without waiting for the notifier.
  if (ctx && ctx.waitUntil) ctx.waitUntil(work);
  return work;
}

function notify(env, ctx, event, booking) {
  if (!booking) return;
  return send(env, ctx, (shop, site) => ({
    event, // 'booked' | 'payment' | 'status'
    booking: { ...booking, studioName: CONFIG.studios[booking.studio].name, typeName: CONFIG.types[booking.type] },
    slotMinutes: CONFIG.slotMinutes,
    customer: bookingMail(event, booking, shop, site),
  }));
}

function notifyOrder(env, ctx, event, order) {
  if (!order) return;
  return send(env, ctx, (shop, site) => ({
    event, // 'order' | 'order_payment' | 'order_status'
    order: { ...order, shipName: SHOP.shipping[order.ship_method].name },
    customer: orderMail(event, order, shop, site),
  }));
}

// ---- Protection against abuse ----
/**
 * True when this visitor has done `name` more than `max` times in the current window.
 * Counted per IP address; requests without one (local tests) are never limited.
 */
async function limited(env, request, name, max, seconds) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return false;
  const win = Math.floor(Date.now() / 1000 / seconds);
  const row = await env.DB.prepare(
    'INSERT INTO rate_limits (key, win, n) VALUES (?, ?, 1) ON CONFLICT(key, win) DO UPDATE SET n = n + 1 RETURNING n'
  ).bind(name + ':' + ip, win).first();
  // Old windows are swept out now and then rather than on every request.
  if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM rate_limits WHERE win < ?').bind(Math.floor(Date.now() / 1000 / 86400) - 1).run();
  return row.n > max;
}
const TOO_MANY = [{ error: '操作太頻繁了，請稍後再試，或以官方 LINE 聯絡我們' }, 429];

// ---- Staff accounts ----
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (text) => new Uint8Array(text.match(/../g).map((h) => parseInt(h, 16)));
async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}
/** Passwords are never stored: only a salted, deliberately slow hash of them. */
async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(salt), iterations: 100000 }, key, 256));
}
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const SESSION_HOURS = 12;
const MASTER = { id: 0, name: '主帳號', username: 'admin', role: 'owner' };

/** Who is asking: the master password, a signed-in member of staff, or nobody. */
async function identify(request, env) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  if (env.ADMIN_TOKEN && same(token, env.ADMIN_TOKEN)) return MASTER;
  const row = await env.DB.prepare(
    `SELECT s.staff_id, st.name, st.username, st.role, st.active FROM sessions s LEFT JOIN staff st ON st.id = s.staff_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(await sha256(token), new Date().toISOString()).first();
  if (!row) return null;
  if (row.staff_id === 0) return MASTER;
  return row.active ? { id: row.staff_id, name: row.name, username: row.username, role: row.role } : null;
}

async function login(request, env) {
  if (await limited(env, request, 'login', 10, 900)) return TOO_MANY;
  const body = await request.json().catch(() => ({}));
  const username = clean(body.username, 30).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  let who = null;
  if (!username || username === 'admin') {
    if (env.ADMIN_TOKEN && same(password, env.ADMIN_TOKEN)) who = MASTER;
  } else {
    const row = await env.DB.prepare('SELECT * FROM staff WHERE username = ? AND active = 1').bind(username).first();
    if (row && same(await hashPassword(password, row.salt), row.hash)) who = { id: row.id, name: row.name, username: row.username, role: row.role };
  }
  if (!who) return [{ error: '帳號或密碼不正確' }, 401];
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(new Date(now).toISOString()).run();
  await env.DB.prepare('INSERT INTO sessions (token_hash, staff_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), who.id, new Date(now + SESSION_HOURS * 3600000).toISOString()).run();
  await env.DB.prepare('INSERT INTO audit (staff_id, staff_name, action, detail, created_at) VALUES (?, ?, ?, ?, ?)').bind(who.id, who.name, '登入', '', new Date(now).toISOString()).run();
  return [{ token, name: who.name, username: who.username, role: who.role }, 200];
}

// What each change is called in the activity log. Photo uploads are left out (the product save that follows is logged).
const AUDIT = [
  [/^PATCH \/api\/admin\/bookings\/\d+$/, '更改預約狀態'], [/^POST \/api\/admin\/closures$/, '新增休息日'], [/^DELETE \/api\/admin\/closures$/, '移除休息日'],
  [/^POST \/api\/admin\/products$/, '新增貨品'], [/^PUT \/api\/admin\/products\/\d+$/, '修改貨品'], [/^DELETE \/api\/admin\/products\/\d+$/, '刪除貨品'],
  [/^POST \/api\/admin\/categories$/, '新增分類'], [/^PUT \/api\/admin\/categories\/\d+$/, '修改分類'], [/^DELETE \/api\/admin\/categories\/\d+$/, '刪除分類'],
  [/^PATCH \/api\/admin\/orders\/\d+$/, '更新訂單'], [/^POST \/api\/admin\/customers$/, '新增客人'], [/^PUT \/api\/admin\/customers\/\+?\d+$/, '修改客人資料'],
  [/^POST \/api\/admin\/customers\/\+?\d+\/points$/, '調整積分'], [/^PUT \/api\/admin\/settings$/, '更改設定'],
  [/^POST \/api\/admin\/staff$/, '新增帳號'], [/^PUT \/api\/admin\/staff\/\d+$/, '修改帳號'], [/^DELETE \/api\/admin\/staff\/\d+$/, '刪除帳號'],
  [/^PUT \/api\/admin\/password$/, '更改自己的密碼'], [/^POST \/api\/admin\/promos$/, '新增優惠碼'], [/^PUT \/api\/admin\/promos\/\d+$/, '修改優惠碼'],
  [/^DELETE \/api\/admin\/promos\/\d+$/, '刪除優惠碼'], [/^GET \/api\/admin\/backup$/, '下載備份'],
];
// Only the owner may touch these: accounts, settings, money figures, backups, promotions, the log itself.
const OWNER_ONLY = /^\/api\/admin\/(staff|settings|report|backup|audit|promos)(\/|$)/;

/** Keeps one record per customer, keyed by phone. Newer details replace older ones; blanks never erase. */
async function rememberCustomer(env, { name, phone, email = '', line = '', marketing = false }) {
  const now = new Date().toISOString();
  // Agreeing to hear from the studio is only ever switched on here; the studio switches it off on request.
  await env.DB.prepare(
    `INSERT INTO customers (phone, name, email, line_id, note, tags, marketing, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, '', '', ?6, ?5, ?5)
     ON CONFLICT(phone) DO UPDATE SET name = ?2,
       email = CASE WHEN ?3 != '' THEN ?3 ELSE email END,
       line_id = CASE WHEN ?4 != '' THEN ?4 ELSE line_id END,
       marketing = MAX(marketing, ?6),
       updated_at = ?5`
  ).bind(phone, name, email, line, now, marketing ? 1 : 0).run();
}

/** The loyalty rules in force: what the studio saved, or the starting values above. */
async function pointRules(env) {
  const rows = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('points_earn_per', 'points_value', 'points_class', 'points_expire_months')").all();
  const saved = Object.fromEntries(rows.results.map((r) => [r.key, Number(r.value)]));
  const pick = (key, fallback) => (Number.isInteger(saved[key]) && saved[key] >= 0 ? saved[key] : fallback);
  return {
    earnPer: pick('points_earn_per', SHOP.points.earnPer),
    pointValue: Math.max(pick('points_value', SHOP.points.pointValue), 1),
    classPoints: pick('points_class', SHOP.points.classPoints),
    expireMonths: pick('points_expire_months', 0), // unused for this many months = gone; 0 = never
  };
}

/**
 * Clears the points of anyone whose last points activity (earning or spending) is older
 * than the expiry period. Run whenever balances are about to be shown or spent.
 */
async function sweepExpired(env) {
  const { expireMonths } = await pointRules(env);
  if (!expireMonths) return;
  const cutoff = new Date();
  cutoff.setUTCMonth(cutoff.getUTCMonth() - expireMonths);
  await env.DB.prepare(
    `INSERT INTO points (phone, delta, reason, order_id, created_at)
     SELECT phone, -SUM(delta), ?1, NULL, ?2 FROM points GROUP BY phone HAVING SUM(delta) > 0 AND MAX(created_at) < ?3`
  ).bind('積分到期（超過 ' + expireMonths + ' 個月沒有累積或使用）', new Date().toISOString(), cutoff.toISOString()).run();
}

async function pointsBalance(env, phone) {
  const row = await env.DB.prepare('SELECT COALESCE(SUM(delta), 0) AS n FROM points WHERE phone = ?').bind(phone).first();
  return row.n;
}

async function addPoints(env, phone, delta, reason, orderId = null) {
  if (!delta) return;
  await env.DB.prepare('INSERT INTO points (phone, delta, reason, order_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(phone, delta, reason, orderId, new Date().toISOString()).run();
}

/** Points are tied to a phone number, so spending them needs proof: the code of one of that phone's orders. */
async function ownsOrder(env, phone, code) {
  if (!code || !phone) return false;
  return Boolean(await env.DB.prepare('SELECT 1 FROM orders WHERE code = ?1 AND phone = ?2 UNION SELECT 1 FROM bookings WHERE code = ?1 AND phone = ?2').bind(code, phone).first());
}

async function checkPoints(body, env) {
  const phone = clean(body.phone, 20).replace(/[^\d+]/g, '');
  const code = clean(body.code, 12).toUpperCase();
  if (!await ownsOrder(env, phone, code)) return [{ error: '找不到這個編號，請確認訂單或預約編號與手機' }, 404];
  await sweepExpired(env);
  return [{ points: await pointsBalance(env, phone), pointValue: (await pointRules(env)).pointValue }, 200];
}

function cors(env, request) {
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
  const origin = request.headers.get('Origin') || '';
  const allow = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Vary': 'Origin',
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

function clean(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function newCode() {
  // No 0/O/1/I so the code survives being read out over LINE.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

async function getSlots(url, env) {
  const studio = url.searchParams.get('studio');
  if (!CONFIG.studios[studio]) return [{ error: '請選擇工作室' }, 400];
  const today = taipeiToday();
  let from = url.searchParams.get('from');
  if (!isDate(from) || from < today) from = today;
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days'), 10) || 14, 1), 31);
  const to = addDays(from, days - 1);

  const taken = await env.DB.prepare(
    "SELECT date, time, SUM(people) AS people FROM bookings WHERE studio = ? AND date BETWEEN ? AND ? AND status != 'cancelled' GROUP BY date, time"
  ).bind(studio, from, to).all();
  const closed = await env.DB.prepare('SELECT date, reason FROM closures WHERE studio = ? AND date BETWEEN ? AND ?').bind(studio, from, to).all();
  const used = {};
  for (const row of taken.results) used[row.date + ' ' + row.time] = row.people;
  const closures = {};
  for (const row of closed.results) closures[row.date] = row.reason || '休息';
  const others = blockers(studio);
  if (others.length) {
    const busy = await env.DB.prepare(
      `SELECT DISTINCT date FROM bookings WHERE studio IN (${others.map(() => '?').join(',')}) AND date BETWEEN ? AND ? AND status != 'cancelled'`
    ).bind(...others, from, to).all();
    for (const row of busy.results) if (!closures[row.date]) closures[row.date] = closedForOtherStudio(studio);
  }

  const out = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    const problem = closures[date] || dateProblem(studio, date, today);
    out.push({
      date,
      weekday: weekday(date),
      closed: problem || null,
      slots: problem ? [] : slotTimes(studio).map((time) => ({ time, left: Math.max(CONFIG.capacity - (used[date + ' ' + time] || 0), 0) })),
    });
  }
  return [{ studio, capacity: CONFIG.capacity, slotMinutes: CONFIG.slotMinutes, days: out }, 200];
}

async function createBooking(body, env, ctx) {
  const studio = body.studio;
  const type = body.type;
  const people = Number(body.people);
  const name = clean(body.name, 40);
  const phone = clean(body.phone, 20).replace(/[^\d+]/g, '');
  const email = clean(body.email, 80);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return [{ error: 'Email 格式不正確' }, 400];
  if (!CONFIG.studios[studio]) return [{ error: '請選擇工作室' }, 400];
  if (!CONFIG.types[type]) return [{ error: '請選擇預約項目' }, 400];
  if (!Number.isInteger(people) || people < 1 || people > CONFIG.maxPeoplePerBooking) return [{ error: '人數不正確' }, 400];
  if (!name) return [{ error: '請填寫姓名' }, 400];
  if (phone.length < 8) return [{ error: '請填寫可聯絡的電話' }, 400];
  if (!isDate(body.date)) return [{ error: '日期不正確' }, 400];
  if (!slotTimes(studio).includes(body.time)) return [{ error: '時段不正確' }, 400];
  const problem = dateProblem(studio, body.date, taipeiToday());
  if (problem) return [{ error: problem }, 400];
  const closed = await env.DB.prepare('SELECT 1 FROM closures WHERE studio = ? AND date = ?').bind(studio, body.date).first();
  if (closed) return [{ error: '工作室當天休息' }, 400];

  // Visits have nothing to pay, so they are confirmed straight away.
  const status = type === 'visit' ? 'confirmed' : 'pending';
  const code = newCode();
  // The capacity check lives inside the INSERT itself, so two people sending
  // at the same moment can never both take the last place in a slot.
  const result = await env.DB.prepare(
    `INSERT INTO bookings (code, studio, date, time, type, people, name, phone, line_id, note, status, created_at, email)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?15
     WHERE (SELECT COALESCE(SUM(people), 0) FROM bookings WHERE studio = ?2 AND date = ?3 AND time = ?4 AND status != 'cancelled') + ?6 <= ?13
       AND NOT EXISTS (SELECT 1 FROM bookings WHERE date = ?3 AND status != 'cancelled' AND instr(?14, ',' || studio || ',') > 0)`
  ).bind(code, studio, body.date, body.time, type, people, name, phone, clean(body.line, 40), clean(body.note, 300), status, new Date().toISOString(), CONFIG.capacity, ',' + blockers(studio).join(',') + ',', email).run();
  if (!result.meta.changes) {
    const elsewhere = blockers(studio).length && await env.DB.prepare(
      "SELECT 1 FROM bookings WHERE date = ? AND status != 'cancelled' AND instr(?, ',' || studio || ',') > 0"
    ).bind(body.date, ',' + blockers(studio).join(',') + ',').first();
    return [{ error: elsewhere ? '這一天' + closedForOtherStudio(studio) + '，請改選其他日期' : '這個時段剛剛額滿了，請改選其他時段' }, 409];
  }
  await rememberCustomer(env, { name, phone, email, line: clean(body.line, 40) });
  notify(env, ctx, 'booked', { code, studio, date: body.date, time: body.time, type, people, name, phone, email, line_id: clean(body.line, 40), note: clean(body.note, 300), status });

  return [{ code, studio, studioName: CONFIG.studios[studio].name, date: body.date, time: body.time, type, typeName: CONFIG.types[type], people, status, slotMinutes: CONFIG.slotMinutes, bankInfo: (await shopSettings(env)).bankInfo }, 201];
}

async function reportPayment(body, env, ctx) {
  const code = clean(body.code, 12).toUpperCase();
  const phone = clean(body.phone, 20).replace(/[^\d+]/g, '');
  const last5 = clean(body.last5, 5);
  if (!/^\d{5}$/.test(last5)) return [{ error: '請輸入匯款帳號末五碼（5 位數字）' }, 400];
  const result = await env.DB.prepare(
    "UPDATE bookings SET pay_last5 = ?, status = CASE WHEN status = 'pending' THEN 'reported' ELSE status END WHERE code = ? AND phone = ? AND status != 'cancelled'"
  ).bind(last5, code, phone).run();
  if (!result.meta.changes) return [{ error: '找不到這筆預約，請確認預約編號與電話' }, 404];
  notify(env, ctx, 'payment', await env.DB.prepare('SELECT * FROM bookings WHERE code = ?').bind(code).first());
  return [{ ok: true }, 200];
}

/** Turns a database row into what the pages use. */
function parseOptions(text) {
  try { const v = JSON.parse(text || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
const idList = (text) => (text || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);

function productOut(row, origin) {
  const image = row.image_id ? origin + '/api/images/' + row.image_id : row.image_url || '';
  const galleryIds = idList(row.gallery);
  // A sale price only counts when it really is lower than the usual one.
  const onSale = row.sale_price !== null && row.sale_price !== undefined && row.price !== null && row.sale_price < row.price;
  return {
    id: row.id, name: row.name, stone: row.stone, cat: row.cat, supply: row.supply, note: row.note || '',
    description: row.description || '',
    price: row.price, salePrice: onSale ? row.sale_price : null, priceNow: onSale ? row.sale_price : row.price,
    priceFrom: Boolean(row.price_from), stock: row.stock,
    options: parseOptions(row.options), // e.g. [{ name: '戒圍', values: ['10', '11', '12'] }]
    galleryIds, images: (image ? [image] : []).concat(galleryIds.map((id) => origin + '/api/images/' + id)),
    // Counted stock that has run out reads as sold out without anyone changing the status.
    status: row.status === 'active' && row.stock === 0 ? 'soldout' : row.status,
    sort: row.sort, link: row.link || '',
    // Only ready-made pieces with a fixed price go in the cart; the rest are arranged with the studio.
    buyable: row.status === 'active' && row.stock !== 0 && row.supply === 'stock' && row.price !== null && !row.price_from && !row.link,
    image,
  };
}

/** The extra product details that are saved after the main fields; returns [values] or [null, problem]. */
function productExtras(body, price) {
  const sale = body.salePrice === null || body.salePrice === undefined || body.salePrice === '' ? null : Number(body.salePrice);
  if (sale !== null && (!Number.isInteger(sale) || sale < 0)) return [null, '特價不正確'];
  if (sale !== null && (price === null || sale >= price)) return [null, '特價要比原價低'];
  const gallery = (Array.isArray(body.galleryIds) ? body.galleryIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 5);
  const options = [];
  for (const o of Array.isArray(body.options) ? body.options.slice(0, 3) : []) {
    const name = clean(o && o.name, 12);
    const values = [...new Set((Array.isArray(o && o.values) ? o.values : []).map((v) => clean(String(v), 20)).filter(Boolean))].slice(0, 30);
    if (!name && !values.length) continue;
    if (!name || !values.length) return [null, '每個規格選項都要有名稱和至少一個選擇'];
    if (/[:：、|]/.test(name + values.join(''))) return [null, '規格選項不能含有 : 、 | 這些符號'];
    options.push({ name, values });
  }
  return [[clean(body.description, 2000), sale, gallery.join(','), JSON.stringify(options)]];
}

async function saveExtras(env, id, extras, before) {
  const row = await env.DB.prepare('UPDATE products SET description = ?, sale_price = ?, gallery = ?, options = ? WHERE id = ? RETURNING *').bind(...extras, id).first();
  // Extra photos that were removed are no longer used by anything.
  const keep = idList(extras[2]);
  for (const old of idList(before)) if (!keep.includes(old)) await env.DB.prepare('DELETE FROM images WHERE id = ?').bind(old).run();
  return row;
}

// ---- Promo codes ----
function promoIn(body) {
  const code = clean(body.code, 20).toUpperCase();
  if (!/^[A-Z0-9]{3,20}$/.test(code)) return [null, '優惠碼請用 3–20 個英文字母或數字'];
  if (!['percent', 'amount'].includes(body.kind)) return [null, '請選擇折扣方式'];
  const value = Number(body.value);
  if (!Number.isInteger(value) || value < 1 || (body.kind === 'percent' && value > 90)) return [null, body.kind === 'percent' ? '折扣請填 1–90（代表減幾 %）' : '折扣金額請填 1 或以上的整數'];
  const whole = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
  const minSpend = whole(body.minSpend) || 0;
  const maxUses = whole(body.maxUses);
  if (!Number.isInteger(minSpend) || minSpend < 0) return [null, '最低消費不正確'];
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) return [null, '可用次數請填 1 或以上，或留空代表不限'];
  const starts = body.starts || '';
  const ends = body.ends || '';
  if ((starts && !isDate(starts)) || (ends && !isDate(ends)) || (starts && ends && ends < starts)) return [null, '有效日期不正確'];
  return [[code, body.kind, value, minSpend, maxUses, starts, ends, body.active === false ? 0 : 1]];
}

/** Why a code can't be used on goods worth `subtotal` today, or null when it can. */
function promoProblem(promo, subtotal) {
  const today = taipeiToday();
  if (!promo || !promo.active) return '這個優惠碼無效';
  if (promo.starts && today < promo.starts) return '這個優惠碼還沒開始';
  if (promo.ends && today > promo.ends) return '這個優惠碼已經過期';
  if (promo.max_uses !== null && promo.used >= promo.max_uses) return '這個優惠碼已經用完';
  if (subtotal < promo.min_spend) return '這個優惠碼要消費滿 ' + money(promo.min_spend) + ' 才能使用';
  return null;
}
function promoDiscount(promo, subtotal) {
  return promo.kind === 'percent' ? Math.floor(subtotal * promo.value / 100) : Math.min(promo.value, subtotal);
}

async function checkPromo(body, env) {
  const subtotal = Number(body.subtotal) || 0;
  const promo = await env.DB.prepare('SELECT * FROM promos WHERE code = ?').bind(clean(body.code, 20).toUpperCase()).first();
  const problem = promoProblem(promo, subtotal);
  if (problem) return [{ error: problem }, 404];
  return [{ code: promo.code, kind: promo.kind, value: promo.value, minSpend: promo.min_spend, discount: promoDiscount(promo, subtotal) }, 200];
}

/** Checks a product sent from the admin page; returns [fields] or [null, problem]. */
function productIn(body, cats) {
  const name = clean(body.name, 60);
  if (!name) return [null, '請填寫貨品名稱'];
  if (!cats.stone.some((c) => c.slug === body.stone)) return [null, '請選擇主石'];
  if (!cats.cat.some((c) => c.slug === body.cat)) return [null, '請選擇類別'];
  if (!SUPPLIES.includes(body.supply)) return [null, '請選擇供應方式'];
  if (!PRODUCT_STATUSES.includes(body.status)) return [null, '狀態不正確'];
  const whole = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const price = whole(body.price);
  const stock = whole(body.stock);
  if (price !== null && (!Number.isInteger(price) || price < 0 || price > 9999999)) return [null, '價錢不正確'];
  if (stock !== null && (!Number.isInteger(stock) || stock < 0 || stock > 9999)) return [null, '庫存不正確'];
  const link = clean(body.link, 300);
  if (link && !/^(https:\/\/|[\w-]+\.html)/.test(link)) return [null, '連結需以 https:// 開頭，或是本站的頁面檔名'];
  const imageId = whole(body.imageId);
  return [[name, body.stone, body.cat, body.supply, clean(body.note, 120), price, body.priceFrom ? 1 : 0, stock, body.status,
    Number.isInteger(Number(body.sort)) ? Number(body.sort) : 0, link, imageId]];
}

/** { stone: [{ id, slug, name, sort }], cat: [...] } in the order the studio chose. */
async function listCategories(env) {
  const rows = await env.DB.prepare('SELECT id, kind, slug, name, sort FROM categories ORDER BY sort, id').all();
  const out = { stone: [], cat: [] };
  for (const r of rows.results) if (out[r.kind]) out[r.kind].push({ id: r.id, slug: r.slug, name: r.name, sort: r.sort });
  return out;
}

async function listProducts(env, origin, includeHidden) {
  const rows = await env.DB.prepare(
    `SELECT * FROM products ${includeHidden ? '' : "WHERE status != 'hidden'"} ORDER BY sort, id`
  ).all();
  return rows.results.map((r) => productOut(r, origin));
}

async function getImage(id, env, headers) {
  const row = await env.DB.prepare('SELECT type, data FROM images WHERE id = ?').bind(Number(id)).first();
  if (!row) return json({ error: 'Not found' }, 404, headers);
  // An uploaded photo never changes (a new upload gets a new id), so browsers may keep it.
  return new Response(new Uint8Array(row.data), { headers: { ...headers, 'Content-Type': row.type, 'Cache-Control': 'public, max-age=31536000, immutable' } });
}

async function orderWithItems(env, order) {
  const items = await env.DB.prepare('SELECT product_id, name, price, qty, options FROM order_items WHERE order_id = ? ORDER BY rowid').bind(order.id).all();
  return { ...order, items: items.results };
}

async function putBackStock(env, items) {
  for (const it of items) {
    await env.DB.prepare('UPDATE products SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL').bind(it.qty, it.product_id).run();
  }
}

async function createOrder(body, env, ctx) {
  const name = clean(body.name, 40);
  const phone = clean(body.phone, 20).replace(/[^\d+]/g, '');
  const email = clean(body.email, 80);
  const method = SHOP.shipping[body.shipMethod] ? body.shipMethod : null;
  const shipTo = clean(body.shipTo, 160);
  if (!name) return [{ error: '請填寫姓名' }, 400];
  if (phone.length < 8) return [{ error: '請填寫可聯絡的電話' }, 400];
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return [{ error: 'Email 格式不正確' }, 400];
  if (!method) return [{ error: '請選擇取貨方式' }, 400];
  if (SHOP.shipping[method].ask && !shipTo) return [{ error: '請填寫' + SHOP.shipping[method].ask }, 400];
  // Unpaid orders hold stock, so one phone number can only have a few waiting at a time.
  const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE phone = ? AND status = 'pending'").bind(phone).first();
  if (waiting.n >= SHOP.maxUnpaidOrders) return [{ error: '你有 ' + waiting.n + ' 筆訂單尚未付款，請先完成匯款或用官方 LINE 聯絡我們取消' }, 429];

  // Merge repeated lines, then read prices from the database: the browser's numbers are never trusted.
  // The same piece in the same options is one line; a different ring size is its own line.
  const wanted = new Map();
  for (const it of Array.isArray(body.items) ? body.items.slice(0, 30) : []) {
    const id = Number(it && it.id);
    const qty = Number(it && it.qty);
    if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1) return [{ error: '購物車內容不正確' }, 400];
    const chosen = it.options && typeof it.options === 'object' ? it.options : {};
    const key = id + '|' + JSON.stringify(Object.keys(chosen).sort().map((k) => [k, String(chosen[k])]));
    const line = wanted.get(key) || { id, qty: 0, chosen };
    line.qty += qty;
    wanted.set(key, line);
  }
  if (!wanted.size) return [{ error: '購物車是空的' }, 400];
  const lines = [];
  const perProduct = {};
  for (const { id, qty, chosen } of wanted.values()) {
    const row = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
    const p = row && productOut(row, '');
    if (!p || !p.buyable) return [{ error: (row ? '「' + row.name + '」' : '其中一件貨品') + '目前無法線上訂購，請從購物車移除', productId: id }, 409];
    perProduct[id] = (perProduct[id] || 0) + qty;
    if (perProduct[id] > SHOP.maxQtyPerItem) return [{ error: '「' + p.name + '」每張訂單最多 ' + SHOP.maxQtyPerItem + ' 件', productId: id }, 400];
    // Every option the product has must be answered with one of its own choices.
    const picked = [];
    for (const o of p.options) {
      const value = String(chosen[o.name] === undefined ? '' : chosen[o.name]);
      if (!o.values.includes(value)) return [{ error: '請為「' + p.name + '」選擇' + o.name, productId: id }, 400];
      picked.push(o.name + ':' + value);
    }
    lines.push({ product_id: id, name: p.name, price: p.priceNow, qty, options: picked.join('、') });
  }

  // Take the stock one item at a time; each UPDATE only succeeds while enough is left,
  // so two customers can never both buy the last piece. If a later item fails, undo the earlier ones.
  const taken = [];
  for (const line of lines) {
    const r = await env.DB.prepare(
      "UPDATE products SET stock = CASE WHEN stock IS NULL THEN NULL ELSE stock - ?1 END WHERE id = ?2 AND status = 'active' AND (stock IS NULL OR stock >= ?1)"
    ).bind(line.qty, line.product_id).run();
    if (!r.meta.changes) {
      await putBackStock(env, taken);
      return [{ error: '「' + line.name + '」庫存不足，請調整數量', productId: line.product_id }, 409];
    }
    taken.push(line);
  }

  const subtotal = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
  const rules = await pointRules(env);
  const shop = await shopSettings(env);
  // From here on, anything that stops the order must first hand back what was already taken.
  let promo = null;
  const undo = async () => {
    await putBackStock(env, taken);
    if (promo) await env.DB.prepare('UPDATE promos SET used = MAX(used - 1, 0) WHERE id = ?').bind(promo.id).run();
  };

  // Promo code: checked against today's rules, then claimed in one step so a limited code can't be over-used.
  let promoOff = 0;
  const promoCode = clean(body.promo, 20).toUpperCase();
  if (promoCode) {
    const found = await env.DB.prepare('SELECT * FROM promos WHERE code = ?').bind(promoCode).first();
    const problem = promoProblem(found, subtotal);
    if (problem) { await undo(); return [{ error: problem }, 400]; }
    const claimed = await env.DB.prepare('UPDATE promos SET used = used + 1 WHERE id = ? AND (max_uses IS NULL OR used < max_uses)').bind(found.id).run();
    if (!claimed.meta.changes) { await undo(); return [{ error: '這個優惠碼剛剛用完了' }, 409]; }
    promo = found;
    promoOff = promoDiscount(found, subtotal);
  }
  const goods = subtotal - promoOff; // what the customer pays for the goods before points
  const freeShip = shop.freeShipOver > 0 && goods >= shop.freeShipOver;
  const shipFee = freeShip ? 0 : SHOP.shipping[method].fee;

  // Spending points: never more than the goods are worth, and only with a past order's code as proof.
  let pointsUsed = 0;
  const wantPoints = Number(body.pointsUse) || 0;
  if (wantPoints) {
    const fail = async (error, status) => { await undo(); return [{ error }, status]; };
    if (!Number.isInteger(wantPoints) || wantPoints < 0) return fail('積分數量不正確', 400);
    await sweepExpired(env);
    if (!await ownsOrder(env, phone, clean(body.pointsCode, 12).toUpperCase())) return fail('積分驗證失敗：請確認過往訂單編號與手機', 400);
    pointsUsed = Math.min(wantPoints, Math.floor(goods / rules.pointValue));
    // The balance check lives inside the INSERT, so the same points can't be spent twice at once.
    const spent = await env.DB.prepare(
      `INSERT INTO points (phone, delta, reason, order_id, created_at)
       SELECT ?1, -?2, '訂單折抵', NULL, ?3 WHERE (SELECT COALESCE(SUM(delta), 0) FROM points WHERE phone = ?1) >= ?2`
    ).bind(phone, pointsUsed, new Date().toISOString()).run();
    if (!spent.meta.changes) return fail('積分不足，請調整使用數量', 409);
  }
  const discount = pointsUsed * rules.pointValue;

  const order = {
    code: newCode(), name, phone, email, line_id: clean(body.line, 40), ship_method: method, ship_to: shipTo,
    note: clean(body.note, 300), subtotal, promo_code: promo ? promo.code : '', promo_discount: promoOff, discount, points_used: pointsUsed,
    ship_fee: shipFee, total: goods - discount + shipFee,
    status: 'pending', created_at: new Date().toISOString(),
  };
  let saved;
  try {
    saved = await env.DB.prepare(
      `INSERT INTO orders (code, name, phone, email, line_id, ship_method, ship_to, note, subtotal, discount, points_used, ship_fee, total, status, created_at, promo_code, promo_discount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).bind(order.code, name, phone, email, order.line_id, method, shipTo, order.note, subtotal, discount, pointsUsed, shipFee, order.total, 'pending', order.created_at, order.promo_code, promoOff).first();
    for (const l of lines) {
      await env.DB.prepare('INSERT INTO order_items (order_id, product_id, name, price, qty, options) VALUES (?, ?, ?, ?, ?, ?)').bind(saved.id, l.product_id, l.name, l.price, l.qty, l.options).run();
    }
  } catch (err) {
    await undo();
    await addPoints(env, phone, pointsUsed, '訂單未成立，退回積分');
    throw err;
  }
  await rememberCustomer(env, { name, phone, email, line: order.line_id, marketing: Boolean(body.marketing) });
  notifyOrder(env, ctx, 'order', { ...order, items: lines });
  const willEarn = rules.earnPer ? Math.floor((goods - discount) / rules.earnPer) : 0;
  return [{ code: order.code, items: lines, subtotal, promoCode: order.promo_code, promoDiscount: promoOff, discount, pointsUsed, shipFee, total: order.total, shipName: SHOP.shipping[method].name, status: 'pending', willEarn, bankInfo: shop.bankInfo }, 201];
}

async function reportOrderPayment(body, env, ctx) {
  const code = clean(body.code, 12).toUpperCase();
  const phone = clean(body.phone, 20).replace(/[^\d+]/g, '');
  const last5 = clean(body.last5, 5);
  if (!/^\d{5}$/.test(last5)) return [{ error: '請輸入匯款帳號末五碼（5 位數字）' }, 400];
  const result = await env.DB.prepare(
    "UPDATE orders SET pay_last5 = ?, status = CASE WHEN status = 'pending' THEN 'reported' ELSE status END WHERE code = ? AND phone = ? AND status != 'cancelled'"
  ).bind(last5, code, phone).run();
  if (!result.meta.changes) return [{ error: '找不到這筆訂單，請確認訂單編號與電話' }, 404];
  notifyOrder(env, ctx, 'order_payment', await orderWithItems(env, await env.DB.prepare('SELECT * FROM orders WHERE code = ?').bind(code).first()));
  return [{ ok: true }, 200];
}

/** Lets a customer check their own order; both the code and the phone must match. */
async function lookupOrder(body, env) {
  const code = clean(body.code, 12).toUpperCase();
  const phone = clean(body.phone, 20).replace(/[^\d+]/g, '');
  const row = code && phone && await env.DB.prepare('SELECT * FROM orders WHERE code = ? AND phone = ?').bind(code, phone).first();
  if (!row) return [{ error: '找不到這筆訂單，請確認訂單編號與電話' }, 404];
  await sweepExpired(env);
  const o = await orderWithItems(env, row);
  return [{ code: o.code, status: o.status, items: o.items, subtotal: o.subtotal, promoCode: o.promo_code || '', promoDiscount: o.promo_discount || 0, discount: o.discount, shipFee: o.ship_fee, total: o.total,
    points: await pointsBalance(env, phone), bankInfo: (await shopSettings(env)).bankInfo,
    shipName: SHOP.shipping[o.ship_method].name, shipTo: o.ship_to, tracking: o.tracking || '', paid: Boolean(o.pay_last5), date: taipeiToday(Date.parse(o.created_at)) }, 200];
}

/** Checks a customer record sent from the admin page; returns [fields] or [null, problem]. */
function customerIn(body) {
  const name = clean(body.name, 40);
  if (!name) return [null, '請填寫姓名'];
  const email = clean(body.email, 80);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return [null, 'Email 格式不正確'];
  const birthday = clean(body.birthday, 5);
  if (birthday && !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(birthday)) return [null, '生日請用 MM-DD，例如 03-15'];
  // Tags are short labels separated by commas; duplicates and blanks are dropped.
  const tags = [...new Set(clean(body.tags, 200).split(/[,，、]+/).map((t) => t.trim().slice(0, 12)).filter(Boolean))].slice(0, 8).join(',');
  return [[name, email, clean(body.line_id, 40), clean(body.note, 500), tags, birthday, body.marketing ? 1 : 0]];
}

/** Money counts once the studio has confirmed it: paid, shipped or done. Months are Taipei time. */
async function report(env) {
  const month = "substr(datetime(created_at, '+8 hours'), 1, 7)";
  const earned = "status IN ('paid', 'shipped', 'done')";
  const byMonth = await env.DB.prepare(
    `SELECT ${month} AS month, COUNT(*) AS orders, SUM(CASE WHEN ${earned} THEN 1 ELSE 0 END) AS paid_orders,
       SUM(CASE WHEN ${earned} THEN total ELSE 0 END) AS revenue
     FROM orders WHERE status != 'cancelled' GROUP BY month ORDER BY month DESC LIMIT 12`
  ).all();
  const bookingsByMonth = await env.DB.prepare(
    "SELECT substr(date, 1, 7) AS month, COUNT(*) AS bookings, SUM(people) AS people FROM bookings WHERE status != 'cancelled' GROUP BY month ORDER BY month DESC LIMIT 12"
  ).all();
  const newByMonth = await env.DB.prepare(`SELECT ${month} AS month, COUNT(*) AS customers FROM customers GROUP BY month ORDER BY month DESC LIMIT 12`).all();
  const top = await env.DB.prepare(
    `SELECT i.name, SUM(i.qty) AS qty, SUM(i.qty * i.price) AS revenue FROM order_items i JOIN orders o ON o.id = i.order_id
     WHERE o.${earned} GROUP BY i.product_id, i.name ORDER BY revenue DESC LIMIT 10`
  ).all();
  const totals = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM customers) AS customers,
       (SELECT COUNT(*) FROM (SELECT phone FROM orders WHERE ${earned} GROUP BY phone HAVING COUNT(*) > 1)) AS repeat_buyers,
       (SELECT COUNT(DISTINCT phone) FROM orders WHERE ${earned}) AS buyers,
       (SELECT COALESCE(SUM(total), 0) FROM orders WHERE ${earned}) AS revenue,
       (SELECT COUNT(*) FROM orders WHERE ${earned}) AS paid_orders,
       (SELECT COUNT(*) FROM orders WHERE status IN ('pending', 'reported')) AS unpaid_orders,
       (SELECT COALESCE(SUM(delta), 0) FROM points) AS points_outstanding`
  ).first();
  const months = {};
  const at = (m) => (months[m] = months[m] || { month: m, orders: 0, paid_orders: 0, revenue: 0, bookings: 0, people: 0, customers: 0 });
  for (const r of byMonth.results) Object.assign(at(r.month), r);
  for (const r of bookingsByMonth.results) Object.assign(at(r.month), r);
  for (const r of newByMonth.results) Object.assign(at(r.month), r);
  return { totals, months: Object.values(months).sort((a, b) => (a.month < b.month ? 1 : -1)).slice(0, 12), top: top.results };
}

async function admin(request, url, env, ctx) {
  const path = url.pathname;
  if (path === '/api/admin/login' && request.method === 'POST') return login(request, env);
  const who = await identify(request, env);
  if (!who) return [{ error: '未授權' }, 401];
  if (OWNER_ONLY.test(path) && who.role !== 'owner') return [{ error: '這項功能只有店主帳號可以使用' }, 403];

  // Every change is written to the activity log with who made it.
  const label = (AUDIT.find(([pattern]) => pattern.test(request.method + ' ' + path)) || [])[1];
  const sent = label && request.method !== 'GET' ? await request.clone().text().catch(() => '') : '';
  const result = await adminRoutes(request, url, env, ctx, who);
  if (label && result[1] < 400) {
    let detail = path.replace('/api/admin/', '');
    try {
      const body = JSON.parse(sent || '{}');
      for (const secret of ['password', 'current', 'next']) delete body[secret];
      if (Object.keys(body).length) detail += ' ' + JSON.stringify(body);
    } catch (e) { /* not JSON: the path alone will do */ }
    await env.DB.prepare('INSERT INTO audit (staff_id, staff_name, action, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(who.id, who.name, label, detail.slice(0, 400), new Date().toISOString()).run();
  }
  return result;
}

/** Checks the fields of a staff account; `needPassword` is false when editing without changing it. */
function staffIn(body, needPassword) {
  const name = clean(body.name, 30);
  const username = clean(body.username, 30).toLowerCase();
  if (!name) return [null, '請填寫姓名'];
  if (!/^[a-z0-9_.-]{3,30}$/.test(username) || username === 'admin') return [null, '登入帳號請用 3–30 個英文小寫、數字或 . _ -（不可用 admin）'];
  if (!['owner', 'staff'].includes(body.role)) return [null, '請選擇權限'];
  const password = typeof body.password === 'string' ? body.password : '';
  if ((needPassword || password) && password.length < 8) return [null, '密碼至少 8 個字元'];
  return [{ name, username, role: body.role, password, active: body.active === false ? 0 : 1 }];
}

async function adminRoutes(request, url, env, ctx, who) {
  const path = url.pathname;

  if (path === '/api/admin/me' && request.method === 'GET') return [{ name: who.name, username: who.username, role: who.role, master: who.id === 0 }, 200];
  if (path === '/api/admin/logout' && request.method === 'POST') {
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
    return [{ ok: true }, 200];
  }
  if (path === '/api/admin/password' && request.method === 'PUT') {
    if (who.id === 0) return [{ error: '主帳號的密碼在 Cloudflare 後台更改（ADMIN_TOKEN）' }, 400];
    const body = await request.json().catch(() => ({}));
    const row = await env.DB.prepare('SELECT * FROM staff WHERE id = ?').bind(who.id).first();
    if (!row || !same(await hashPassword(String(body.current || ''), row.salt), row.hash)) return [{ error: '目前的密碼不正確' }, 400];
    if (typeof body.next !== 'string' || body.next.length < 8) return [{ error: '新密碼至少 8 個字元' }, 400];
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    await env.DB.prepare('UPDATE staff SET salt = ?, hash = ? WHERE id = ?').bind(salt, await hashPassword(body.next, salt), who.id).run();
    return [{ ok: true }, 200];
  }

  // Accounts (owner only).
  const staffMatch = path.match(/^\/api\/admin\/staff(?:\/(\d+))?$/);
  if (staffMatch && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT id, username, name, role, active, created_at FROM staff ORDER BY id').all();
    return [{ staff: rows.results }, 200];
  }
  if (staffMatch && !staffMatch[1] && request.method === 'POST') {
    const [f, problem] = staffIn(await request.json().catch(() => ({})), true);
    if (!f) return [{ error: problem }, 400];
    if (await env.DB.prepare('SELECT 1 FROM staff WHERE username = ?').bind(f.username).first()) return [{ error: '這個登入帳號已經有人使用' }, 409];
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    await env.DB.prepare('INSERT INTO staff (username, name, role, salt, hash, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .bind(f.username, f.name, f.role, salt, await hashPassword(f.password, salt), new Date().toISOString()).run();
    return [{ ok: true }, 201];
  }
  if (staffMatch && staffMatch[1] && request.method === 'PUT') {
    const id = Number(staffMatch[1]);
    const [f, problem] = staffIn(await request.json().catch(() => ({})), false);
    if (!f) return [{ error: problem }, 400];
    if (await env.DB.prepare('SELECT 1 FROM staff WHERE username = ? AND id != ?').bind(f.username, id).first()) return [{ error: '這個登入帳號已經有人使用' }, 409];
    const r = await env.DB.prepare('UPDATE staff SET username = ?, name = ?, role = ?, active = ? WHERE id = ?').bind(f.username, f.name, f.role, f.active, id).run();
    if (!r.meta.changes) return [{ error: '找不到這個帳號' }, 404];
    if (f.password) {
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      await env.DB.prepare('UPDATE staff SET salt = ?, hash = ? WHERE id = ?').bind(salt, await hashPassword(f.password, salt), id).run();
    }
    // A changed password or a switched-off account signs that person out everywhere.
    if (f.password || !f.active) await env.DB.prepare('DELETE FROM sessions WHERE staff_id = ?').bind(id).run();
    return [{ ok: true }, 200];
  }
  if (staffMatch && staffMatch[1] && request.method === 'DELETE') {
    const id = Number(staffMatch[1]);
    if (id === who.id) return [{ error: '不能刪除自己正在使用的帳號' }, 400];
    const r = await env.DB.prepare('DELETE FROM staff WHERE id = ?').bind(id).run();
    if (!r.meta.changes) return [{ error: '找不到這個帳號' }, 404];
    await env.DB.prepare('DELETE FROM sessions WHERE staff_id = ?').bind(id).run();
    return [{ ok: true }, 200];
  }

  if (path === '/api/admin/audit' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT staff_name, action, detail, created_at FROM audit ORDER BY id DESC LIMIT 300').all();
    return [{ audit: rows.results }, 200];
  }

  // Everything except photos (too big) and sign-in data, as one file the owner can keep.
  if (path === '/api/admin/backup' && request.method === 'GET') {
    const tables = {};
    for (const t of ['bookings', 'closures', 'settings', 'categories', 'products', 'orders', 'order_items', 'customers', 'points', 'promos']) {
      tables[t] = (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
    }
    return [{ exported_at: new Date().toISOString(), note: '不包含貨品相片、後台帳號與登入紀錄', tables }, 200];
  }

  if (path === '/api/admin/bookings' && request.method === 'GET') {
    const from = isDate(url.searchParams.get('from')) ? url.searchParams.get('from') : taipeiToday();
    const rows = await env.DB.prepare('SELECT * FROM bookings WHERE date >= ? ORDER BY date, time, studio, id').bind(from).all();
    const closed = await env.DB.prepare('SELECT * FROM closures WHERE date >= ? ORDER BY date, studio').bind(from).all();
    return [{ bookings: rows.results, closures: closed.results, config: CONFIG, settings: { notify_emails: await getSetting(env, 'notify_emails'), points: await pointRules(env), shop: await shopSettings(env) } }, 200];
  }

  const match = path.match(/^\/api\/admin\/bookings\/(\d+)$/);
  if (match && request.method === 'PATCH') {
    const body = await request.json().catch(() => ({}));
    if (!STATUSES.includes(body.status)) return [{ error: '狀態不正確' }, 400];
    const result = await env.DB.prepare('UPDATE bookings SET status = ? WHERE id = ?').bind(body.status, Number(match[1])).run();
    if (!result.meta.changes) return [{ error: '找不到這筆預約' }, 404];
    const booking = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(Number(match[1])).first();
    // Class points: given once when the class is confirmed, taken back if it is then cancelled.
    // The ledger line names the booking, which is how "already given" is known.
    if (booking.type === 'class') {
      const reason = '體驗課 ' + booking.code + ' 回饋';
      const given = (await env.DB.prepare('SELECT COALESCE(SUM(delta), 0) AS n FROM points WHERE phone = ? AND reason = ?').bind(booking.phone, reason).first()).n;
      const { classPoints } = await pointRules(env);
      if (booking.status === 'confirmed' && !given && classPoints) await addPoints(env, booking.phone, classPoints, reason);
      if (booking.status === 'cancelled' && given > 0) {
        // Never below zero: if some were already spent, only what is left comes back.
        const back = Math.min(given, await pointsBalance(env, booking.phone));
        await addPoints(env, booking.phone, -given, reason);
        if (back < given) await addPoints(env, booking.phone, given - back, '體驗課 ' + booking.code + ' 取消，已用積分不追回');
      }
    }
    notify(env, ctx, 'status', booking);
    return [{ ok: true }, 200];
  }

  if (path === '/api/admin/products' && request.method === 'GET') {
    return [{ products: await listProducts(env, url.origin, true), categories: await listCategories(env) }, 200];
  }

  // Categories: add, rename, reorder; one that still has products can't be removed.
  const catMatch = path.match(/^\/api\/admin\/categories(?:\/(\d+))?$/);
  if (catMatch && request.method === 'POST' && !catMatch[1]) {
    const body = await request.json().catch(() => ({}));
    const name = clean(body.name, 20);
    if (!CATEGORY_KINDS[body.kind]) return [{ error: '分類種類不正確' }, 400];
    if (!name) return [{ error: '請填寫分類名稱' }, 400];
    if (await env.DB.prepare('SELECT 1 FROM categories WHERE kind = ? AND name = ?').bind(body.kind, name).first()) return [{ error: '已經有同名的分類' }, 409];
    const last = await env.DB.prepare('SELECT COALESCE(MAX(sort), 0) AS n FROM categories WHERE kind = ?').bind(body.kind).first();
    // The slug is what products store; it never changes, so renaming a category is safe.
    const slug = 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
    await env.DB.prepare('INSERT INTO categories (kind, slug, name, sort) VALUES (?, ?, ?, ?)').bind(body.kind, slug, name, last.n + 10).run();
    return [{ categories: await listCategories(env) }, 201];
  }
  if (catMatch && catMatch[1] && request.method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    const current = await env.DB.prepare('SELECT * FROM categories WHERE id = ?').bind(Number(catMatch[1])).first();
    if (!current) return [{ error: '找不到這個分類' }, 404];
    const name = body.name === undefined ? current.name : clean(body.name, 20);
    if (!name) return [{ error: '請填寫分類名稱' }, 400];
    const sort = Number.isInteger(Number(body.sort)) && body.sort !== undefined && body.sort !== '' ? Number(body.sort) : current.sort;
    await env.DB.prepare('UPDATE categories SET name = ?, sort = ? WHERE id = ?').bind(name, sort, current.id).run();
    return [{ categories: await listCategories(env) }, 200];
  }
  if (catMatch && catMatch[1] && request.method === 'DELETE') {
    const current = await env.DB.prepare('SELECT * FROM categories WHERE id = ?').bind(Number(catMatch[1])).first();
    if (!current) return [{ error: '找不到這個分類' }, 404];
    const column = current.kind === 'stone' ? 'stone' : 'cat';
    const used = await env.DB.prepare(`SELECT COUNT(*) AS n FROM products WHERE ${column} = ?`).bind(current.slug).first();
    if (used.n) return [{ error: '還有 ' + used.n + ' 件貨品在「' + current.name + '」，請先把它們改到其他分類' }, 409];
    await env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(current.id).run();
    return [{ categories: await listCategories(env) }, 200];
  }

  if (path === '/api/admin/images' && request.method === 'POST') {
    const type = (request.headers.get('Content-Type') || '').split(';')[0];
    if (!IMAGE_TYPES.includes(type)) return [{ error: '相片格式需為 JPG、PNG 或 WebP' }, 400];
    const data = new Uint8Array(await request.arrayBuffer());
    if (!data.length || data.length > MAX_IMAGE_BYTES) return [{ error: '相片檔案太大' }, 400];
    const saved = await env.DB.prepare('INSERT INTO images (type, data) VALUES (?, ?) RETURNING id').bind(type, data).first();
    return [{ id: saved.id, url: url.origin + '/api/images/' + saved.id }, 201];
  }

  const productMatch = path.match(/^\/api\/admin\/products(?:\/(\d+))?$/);
  if (productMatch && (request.method === 'POST' || request.method === 'PUT')) {
    const body = await request.json().catch(() => ({}));
    const [fields, problem] = productIn(body, await listCategories(env));
    if (!fields) return [{ error: problem }, 400];
    const [extras, extraProblem] = productExtras(body, fields[5]);
    if (!extras) return [{ error: extraProblem }, 400];
    if (request.method === 'POST' && !productMatch[1]) {
      const saved = await env.DB.prepare(
        `INSERT INTO products (name, stone, cat, supply, note, price, price_from, stock, status, sort, link, image_id, image_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?) RETURNING *`
      ).bind(...fields, new Date().toISOString()).first();
      return [{ product: productOut(await saveExtras(env, saved.id, extras, ''), url.origin) }, 201];
    }
    if (request.method === 'PUT' && productMatch[1]) {
      // A product keeps its current photo unless a new one was uploaded with this save.
      const before = await env.DB.prepare('SELECT image_id, gallery FROM products WHERE id = ?').bind(Number(productMatch[1])).first();
      const saved = await env.DB.prepare(
        `UPDATE products SET name = ?, stone = ?, cat = ?, supply = ?, note = ?, price = ?, price_from = ?, stock = ?, status = ?, sort = ?, link = ?,
           image_id = COALESCE(?, image_id) WHERE id = ? RETURNING *`
      ).bind(...fields, Number(productMatch[1])).first();
      if (!saved) return [{ error: '找不到這件貨品' }, 404];
      // The photo it replaced is no longer used by anything.
      if (before && before.image_id && before.image_id !== saved.image_id) await env.DB.prepare('DELETE FROM images WHERE id = ?').bind(before.image_id).run();
      return [{ product: productOut(await saveExtras(env, saved.id, extras, before.gallery), url.origin) }, 200];
    }
  }
  if (productMatch && productMatch[1] && request.method === 'DELETE') {
    const gone = await env.DB.prepare('DELETE FROM products WHERE id = ? RETURNING image_id, gallery').bind(Number(productMatch[1])).first();
    if (!gone) return [{ error: '找不到這件貨品' }, 404];
    for (const id of [gone.image_id, ...idList(gone.gallery)]) if (id) await env.DB.prepare('DELETE FROM images WHERE id = ?').bind(id).run();
    return [{ ok: true }, 200];
  }

  const promoMatch = path.match(/^\/api\/admin\/promos(?:\/(\d+))?$/);
  if (promoMatch && request.method === 'GET') {
    return [{ promos: (await env.DB.prepare('SELECT * FROM promos ORDER BY id DESC').all()).results }, 200];
  }
  if (promoMatch && (request.method === 'POST' || request.method === 'PUT')) {
    const [f, problem] = promoIn(await request.json().catch(() => ({})));
    if (!f) return [{ error: problem }, 400];
    const id = promoMatch[1] ? Number(promoMatch[1]) : 0;
    if (await env.DB.prepare('SELECT 1 FROM promos WHERE code = ? AND id != ?').bind(f[0], id).first()) return [{ error: '已經有相同的優惠碼' }, 409];
    if (request.method === 'POST' && !id) {
      await env.DB.prepare('INSERT INTO promos (code, kind, value, min_spend, max_uses, starts, ends, active, used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)').bind(...f, new Date().toISOString()).run();
      return [{ ok: true }, 201];
    }
    const r = await env.DB.prepare('UPDATE promos SET code = ?, kind = ?, value = ?, min_spend = ?, max_uses = ?, starts = ?, ends = ?, active = ? WHERE id = ?').bind(...f, id).run();
    return r.meta.changes ? [{ ok: true }, 200] : [{ error: '找不到這個優惠碼' }, 404];
  }
  if (promoMatch && promoMatch[1] && request.method === 'DELETE') {
    const r = await env.DB.prepare('DELETE FROM promos WHERE id = ?').bind(Number(promoMatch[1])).run();
    return r.meta.changes ? [{ ok: true }, 200] : [{ error: '找不到這個優惠碼' }, 404];
  }

  if (path === '/api/admin/orders' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 300').all();
    const items = await env.DB.prepare('SELECT order_id, product_id, name, price, qty, options FROM order_items WHERE order_id IN (SELECT id FROM orders ORDER BY id DESC LIMIT 300)').all();
    const byOrder = {};
    for (const it of items.results) (byOrder[it.order_id] = byOrder[it.order_id] || []).push(it);
    return [{ orders: rows.results.map((o) => ({ ...o, items: byOrder[o.id] || [] })), shipping: SHOP.shipping }, 200];
  }

  const orderMatch = path.match(/^\/api\/admin\/orders\/(\d+)$/);
  if (orderMatch && request.method === 'PATCH') {
    const id = Number(orderMatch[1]);
    const body = await request.json().catch(() => ({}));
    const current = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
    if (!current) return [{ error: '找不到這筆訂單' }, 404];
    const status = body.status === undefined ? current.status : body.status;
    if (!ORDER_STATUSES.includes(status)) return [{ error: '狀態不正確' }, 400];
    // A cancelled order has already given its stock back, so it stays cancelled.
    if (current.status === 'cancelled' && status !== 'cancelled') return [{ error: '已取消的訂單不能恢復，請客人重新下單' }, 400];
    const tracking = body.tracking === undefined ? current.tracking : clean(body.tracking, 60);
    const adminNote = body.admin_note === undefined ? current.admin_note : clean(body.admin_note, 300);
    await env.DB.prepare('UPDATE orders SET status = ?, tracking = ?, admin_note = ? WHERE id = ?').bind(status, tracking, adminNote, id).run();
    const saved = await orderWithItems(env, await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first());
    if (status === 'cancelled' && current.status !== 'cancelled') {
      await putBackStock(env, saved.items);
      // Hand back what the customer spent, and take back what this order earned them.
      await addPoints(env, current.phone, current.points_used, '訂單 ' + current.code + ' 取消，退回積分', id);
      await addPoints(env, current.phone, -current.points_earned, '訂單 ' + current.code + ' 取消，收回積分', id);
      await env.DB.prepare('UPDATE orders SET points_earned = 0 WHERE id = ?').bind(id).run();
      if (current.promo_code) await env.DB.prepare('UPDATE promos SET used = MAX(used - 1, 0) WHERE code = ?').bind(current.promo_code).run();
    }
    // Points are earned once, the first time the studio confirms the money arrived.
    const nowPaid = ['paid', 'shipped', 'done'].includes(status) && !['paid', 'shipped', 'done'].includes(current.status);
    const rules = await pointRules(env);
    if (nowPaid && !current.points_earned && rules.earnPer) {
      const earned = Math.floor((current.subtotal - (current.promo_discount || 0) - current.discount) / rules.earnPer);
      if (earned) {
        await addPoints(env, current.phone, earned, '訂單 ' + current.code + ' 消費回饋', id);
        await env.DB.prepare('UPDATE orders SET points_earned = ? WHERE id = ?').bind(earned, id).run();
        saved.points_earned = earned;
      }
    }
    if (status !== current.status) notifyOrder(env, ctx, 'order_status', saved);
    return [{ order: saved }, 200];
  }

  if (path === '/api/admin/customers' && request.method === 'GET') {
    await sweepExpired(env);
    const rows = await env.DB.prepare(
      `SELECT c.*,
         (SELECT COUNT(*) FROM orders o WHERE o.phone = c.phone AND o.status != 'cancelled') AS orders,
         (SELECT COALESCE(SUM(total), 0) FROM orders o WHERE o.phone = c.phone AND o.status IN ('paid', 'shipped', 'done')) AS spent,
         (SELECT COUNT(*) FROM bookings b WHERE b.phone = c.phone AND b.status != 'cancelled') AS bookings,
         (SELECT COALESCE(SUM(delta), 0) FROM points p WHERE p.phone = c.phone) AS points,
         MAX(COALESCE((SELECT MAX(substr(datetime(created_at, '+8 hours'), 1, 10)) FROM orders o WHERE o.phone = c.phone AND o.status != 'cancelled'), ''),
             COALESCE((SELECT MAX(date) FROM bookings b WHERE b.phone = c.phone AND b.status != 'cancelled' AND b.date <= ?1), '')) AS last_seen
       FROM customers c ORDER BY c.updated_at DESC LIMIT 2000`
    ).bind(taipeiToday()).all();
    return [{ customers: rows.results, points: await pointRules(env) }, 200];
  }

  // Adding someone by hand (a walk-in, an old customer from the notebook).
  if (path === '/api/admin/customers' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const [fields, problem] = customerIn(body);
    if (!fields) return [{ error: problem }, 400];
    const phone = clean(body.phone, 20).replace(/[^\d+]/g, '');
    if (phone.length < 8) return [{ error: '請填寫電話' }, 400];
    if (await env.DB.prepare('SELECT 1 FROM customers WHERE phone = ?').bind(phone).first()) return [{ error: '這個電話已經有客人資料' }, 409];
    const now = new Date().toISOString();
    await env.DB.prepare('INSERT INTO customers (name, email, line_id, note, tags, birthday, marketing, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(...fields, phone, now, now).run();
    return [{ ok: true, phone }, 201];
  }

  const customerMatch = path.match(/^\/api\/admin\/customers\/(\+?\d{6,20})$/);
  if (customerMatch && request.method === 'GET') {
    const customer = await env.DB.prepare('SELECT * FROM customers WHERE phone = ?').bind(customerMatch[1]).first();
    if (!customer) return [{ error: '找不到這位客人' }, 404];
    await sweepExpired(env);
    const orders = await env.DB.prepare('SELECT * FROM orders WHERE phone = ? ORDER BY id DESC').bind(customer.phone).all();
    const bookings = await env.DB.prepare('SELECT * FROM bookings WHERE phone = ? ORDER BY date DESC, time DESC').bind(customer.phone).all();
    const ledger = await env.DB.prepare('SELECT delta, reason, created_at FROM points WHERE phone = ? ORDER BY id DESC LIMIT 100').bind(customer.phone).all();
    return [{ customer, orders: await Promise.all(orders.results.map((o) => orderWithItems(env, o))), bookings: bookings.results,
      points: await pointsBalance(env, customer.phone), ledger: ledger.results }, 200];
  }
  if (customerMatch && request.method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    const [fields, problem] = customerIn(body);
    if (!fields) return [{ error: problem }, 400];
    const r = await env.DB.prepare('UPDATE customers SET name = ?, email = ?, line_id = ?, note = ?, tags = ?, birthday = ?, marketing = ? WHERE phone = ?')
      .bind(...fields, customerMatch[1]).run();
    return r.meta.changes ? [{ ok: true }, 200] : [{ error: '找不到這位客人' }, 404];
  }

  // Giving or taking points by hand (a class attended, a goodwill gift, a correction).
  const pointsMatch = path.match(/^\/api\/admin\/customers\/(\+?\d{6,20})\/points$/);
  if (pointsMatch && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const delta = Number(body.delta);
    if (!Number.isInteger(delta) || !delta || Math.abs(delta) > 100000) return [{ error: '積分數量不正確' }, 400];
    if (!await env.DB.prepare('SELECT 1 FROM customers WHERE phone = ?').bind(pointsMatch[1]).first()) return [{ error: '找不到這位客人' }, 404];
    const balance = await pointsBalance(env, pointsMatch[1]);
    if (balance + delta < 0) return [{ error: '積分不能扣到負數（目前 ' + balance + ' 點）' }, 400];
    await addPoints(env, pointsMatch[1], delta, clean(body.reason, 60) || '工作室調整');
    return [{ points: balance + delta }, 200];
  }

  if (path === '/api/admin/points' && request.method === 'GET') {
    await sweepExpired(env);
    const totals = await env.DB.prepare(
      `SELECT COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0) AS issued,
         COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END), 0) AS used,
         COALESCE(SUM(delta), 0) AS outstanding,
         (SELECT COUNT(*) FROM (SELECT phone FROM points GROUP BY phone HAVING SUM(delta) > 0)) AS holders
       FROM points`
    ).first();
    const ledger = await env.DB.prepare(
      'SELECT p.created_at, p.phone, p.delta, p.reason, c.name FROM points p LEFT JOIN customers c ON c.phone = p.phone ORDER BY p.id DESC LIMIT 200'
    ).all();
    const top = await env.DB.prepare(
      'SELECT p.phone, c.name, SUM(p.delta) AS points FROM points p LEFT JOIN customers c ON c.phone = p.phone GROUP BY p.phone HAVING SUM(p.delta) > 0 ORDER BY points DESC LIMIT 20'
    ).all();
    return [{ rules: await pointRules(env), totals, ledger: ledger.results, top: top.results }, 200];
  }

  if (path === '/api/admin/report' && request.method === 'GET') {
    return [await report(env), 200];
  }

  if (path === '/api/admin/settings' && request.method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    // Loyalty rules are saved on their own from the 積分管理 page.
    if (body.points) {
      const p = body.points;
      const whole = (v, max) => Number.isInteger(Number(v)) && v !== '' && v !== null && Number(v) >= 0 && Number(v) <= max;
      if (!whole(p.earnPer, 100000)) return [{ error: '「每消費多少元得 1 點」請填 0 或以上的整數（0 = 不送點）' }, 400];
      if (!whole(p.pointValue, 1000) || Number(p.pointValue) < 1) return [{ error: '「1 點折多少元」請填 1 或以上的整數' }, 400];
      if (!whole(p.classPoints, 100000)) return [{ error: '「體驗課送點」請填 0 或以上的整數' }, 400];
      const expire = p.expireMonths === undefined || p.expireMonths === '' ? 0 : p.expireMonths;
      if (!whole(expire, 120)) return [{ error: '「幾個月沒用就到期」請填 0–120 的整數（0 = 永不到期）' }, 400];
      for (const [key, value] of [['points_earn_per', p.earnPer], ['points_value', p.pointValue], ['points_class', p.classPoints], ['points_expire_months', expire]]) {
        await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, String(Number(value))).run();
      }
      return [{ ok: true, points: await pointRules(env) }, 200];
    }
    // Shop-wide choices: bank details, free shipping, whether customers get emails.
    if (body.shop) {
      const sh = body.shop;
      const over = sh.freeShipOver === '' || sh.freeShipOver === undefined ? 0 : Number(sh.freeShipOver);
      if (!Number.isInteger(over) || over < 0 || over > 9999999) return [{ error: '免運門檻請填 0 或以上的整數（0 = 不設免運）' }, 400];
      for (const [key, value] of [['bank_info', clean(sh.bankInfo, 200)], ['free_ship_over', String(over)], ['customer_emails', sh.customerEmails === false ? '0' : '1']]) {
        await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, value).run();
      }
      return [{ ok: true, shop: await shopSettings(env) }, 200];
    }
    const emails = clean(body.notify_emails, 300).split(/[\s,;，；]+/).filter(Boolean);
    if (emails.length > 5) return [{ error: '最多 5 個收件人' }, 400];
    const bad = emails.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (bad) return [{ error: 'Email 格式不正確：' + bad }, 400];
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('notify_emails', ?)").bind(emails.join(',')).run();
    return [{ ok: true, notify_emails: emails.join(',') }, 200];
  }

  if (path === '/api/admin/closures' && (request.method === 'POST' || request.method === 'DELETE')) {
    const body = await request.json().catch(() => ({}));
    if (!CONFIG.studios[body.studio] || !isDate(body.date)) return [{ error: '工作室或日期不正確' }, 400];
    if (request.method === 'POST') {
      await env.DB.prepare('INSERT OR REPLACE INTO closures (studio, date, reason) VALUES (?, ?, ?)').bind(body.studio, body.date, clean(body.reason, 40)).run();
    } else {
      await env.DB.prepare('DELETE FROM closures WHERE studio = ? AND date = ?').bind(body.studio, body.date).run();
    }
    return [{ ok: true }, 200];
  }

  return [{ error: 'Not found' }, 404];
}

export default {
  async fetch(request, env, ctx) {
    const headers = cors(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    try {
      let result;
      if (url.pathname === '/api/slots' && request.method === 'GET') {
        result = await getSlots(url, env);
      } else if (url.pathname === '/api/bookings' && request.method === 'POST') {
        result = await limited(env, request, 'book', 6, 3600) ? TOO_MANY : await createBooking(await request.json().catch(() => ({})), env, ctx);
      } else if (url.pathname === '/api/bookings/payment' && request.method === 'POST') {
        result = await limited(env, request, 'check', 30, 3600) ? TOO_MANY : await reportPayment(await request.json().catch(() => ({})), env, ctx);
      } else if (url.pathname === '/api/products' && request.method === 'GET') {
        const shop = await shopSettings(env);
        return json({ products: await listProducts(env, url.origin, false), categories: await listCategories(env), shipping: SHOP.shipping, maxQtyPerItem: SHOP.maxQtyPerItem,
          points: await pointRules(env), freeShipOver: shop.freeShipOver, bankInfo: shop.bankInfo }, 200, { ...headers, 'Cache-Control': 'public, max-age=60' });
      } else if (url.pathname === '/api/orders' && request.method === 'POST') {
        result = await limited(env, request, 'order', 6, 3600) ? TOO_MANY : await createOrder(await request.json().catch(() => ({})), env, ctx);
      } else if (url.pathname === '/api/orders/payment' && request.method === 'POST') {
        result = await limited(env, request, 'check', 30, 3600) ? TOO_MANY : await reportOrderPayment(await request.json().catch(() => ({})), env, ctx);
      } else if (url.pathname === '/api/points/balance' && request.method === 'POST') {
        result = await limited(env, request, 'check', 30, 3600) ? TOO_MANY : await checkPoints(await request.json().catch(() => ({})), env);
      } else if (url.pathname === '/api/promos/check' && request.method === 'POST') {
        result = await limited(env, request, 'check', 30, 3600) ? TOO_MANY : await checkPromo(await request.json().catch(() => ({})), env);
      } else if (url.pathname === '/api/orders/lookup' && request.method === 'POST') {
        result = await limited(env, request, 'check', 30, 3600) ? TOO_MANY : await lookupOrder(await request.json().catch(() => ({})), env);
      } else if (/^\/api\/images\/\d+$/.test(url.pathname) && request.method === 'GET') {
        return await getImage(url.pathname.split('/').pop(), env, headers);
      } else if (url.pathname.startsWith('/api/admin/')) {
        result = await admin(request, url, env, ctx);
      } else {
        result = [{ error: 'Not found' }, 404];
      }
      return json(result[0], result[1], headers);
    } catch (err) {
      console.error(err);
      return json({ error: '系統暫時無法處理，請稍後再試或以官方 LINE 聯絡我們' }, 500, headers);
    }
  },
};
