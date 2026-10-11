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
//   PUT   /api/admin/settings            { notify_emails }
//   GET/POST /api/admin/products, PUT/DELETE /api/admin/products/:id
//   POST  /api/admin/images              (photo bytes) -> { id, url }
//   POST  /api/admin/categories { kind, name }, PUT/DELETE /api/admin/categories/:id
//   GET   /api/admin/orders, PATCH /api/admin/orders/:id   { status, tracking, admin_note }
//   GET/POST /api/admin/customers, GET/PUT /api/admin/customers/:phone
//   POST  /api/admin/customers/:phone/points   { delta, reason }
//   GET   /api/admin/report                    sales and customer figures
// Public shop:
//   GET  /api/products, GET /api/images/:id
//   POST /api/orders                 place an order
//   POST /api/orders/payment         report transfer's last five digits
//   POST /api/orders/lookup          { code, phone } -> the customer's own order
//   POST /api/points/balance         { code, phone } -> points the customer can spend

// ---- Settings the studio is likely to change -------------------------------
export const CONFIG = {
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
  // Loyalty points: one point for every `earnPer` NT$ of goods (shipping excluded),
  // given when the studio marks the order as paid. Each point is worth `pointValue` NT$
  // off a later order. Set earnPer to 0 to switch points off.
  points: { earnPer: 100, pointValue: 1 },
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

/** Tells the studio's notifier (a Google Apps Script web app) about a change. */
function notify(env, ctx, event, booking) {
  if (!env.NOTIFY_URL || !booking) return;
  const send = getSetting(env, 'notify_emails').then((emails) => {
    const payload = {
      event, // 'booked' | 'payment' | 'status'
      booking: { ...booking, studioName: CONFIG.studios[booking.studio].name, typeName: CONFIG.types[booking.type] },
      slotMinutes: CONFIG.slotMinutes,
      emails: emails ? emails.split(',') : [], // recipients chosen on the admin page
    };
    return fetch(env.NOTIFY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  }).catch((err) => console.error('notify failed', err));
  // Let the reply to the customer go out without waiting for the notifier.
  if (ctx && ctx.waitUntil) ctx.waitUntil(send);
}

/** Tells the same notifier about a shop order. */
function notifyOrder(env, ctx, event, order) {
  if (!env.NOTIFY_URL || !order) return;
  const send = getSetting(env, 'notify_emails').then((emails) => {
    const payload = { event, order: { ...order, shipName: SHOP.shipping[order.ship_method].name }, emails: emails ? emails.split(',') : [] };
    return fetch(env.NOTIFY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  }).catch((err) => console.error('notify failed', err));
  if (ctx && ctx.waitUntil) ctx.waitUntil(send);
}

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
  return Boolean(code && phone && await env.DB.prepare('SELECT 1 FROM orders WHERE code = ? AND phone = ?').bind(code, phone).first());
}

async function checkPoints(body, env) {
  const phone = clean(body.phone, 20).replace(/[^\d+]/g, '');
  const code = clean(body.code, 12).toUpperCase();
  if (!await ownsOrder(env, phone, code)) return [{ error: '找不到這筆訂單，請確認訂單編號與手機' }, 404];
  return [{ points: await pointsBalance(env, phone), pointValue: SHOP.points.pointValue }, 200];
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
    `INSERT INTO bookings (code, studio, date, time, type, people, name, phone, line_id, note, status, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
     WHERE (SELECT COALESCE(SUM(people), 0) FROM bookings WHERE studio = ?2 AND date = ?3 AND time = ?4 AND status != 'cancelled') + ?6 <= ?13
       AND NOT EXISTS (SELECT 1 FROM bookings WHERE date = ?3 AND status != 'cancelled' AND instr(?14, ',' || studio || ',') > 0)`
  ).bind(code, studio, body.date, body.time, type, people, name, phone, clean(body.line, 40), clean(body.note, 300), status, new Date().toISOString(), CONFIG.capacity, ',' + blockers(studio).join(',') + ',').run();
  if (!result.meta.changes) {
    const elsewhere = blockers(studio).length && await env.DB.prepare(
      "SELECT 1 FROM bookings WHERE date = ? AND status != 'cancelled' AND instr(?, ',' || studio || ',') > 0"
    ).bind(body.date, ',' + blockers(studio).join(',') + ',').first();
    return [{ error: elsewhere ? '這一天' + closedForOtherStudio(studio) + '，請改選其他日期' : '這個時段剛剛額滿了，請改選其他時段' }, 409];
  }
  await rememberCustomer(env, { name, phone, line: clean(body.line, 40) });
  notify(env, ctx, 'booked', { code, studio, date: body.date, time: body.time, type, people, name, phone, line_id: clean(body.line, 40), note: clean(body.note, 300), status });

  return [{ code, studio, studioName: CONFIG.studios[studio].name, date: body.date, time: body.time, type, typeName: CONFIG.types[type], people, status, slotMinutes: CONFIG.slotMinutes }, 201];
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
function productOut(row, origin) {
  return {
    id: row.id, name: row.name, stone: row.stone, cat: row.cat, supply: row.supply, note: row.note || '',
    price: row.price, priceFrom: Boolean(row.price_from), stock: row.stock,
    // Counted stock that has run out reads as sold out without anyone changing the status.
    status: row.status === 'active' && row.stock === 0 ? 'soldout' : row.status,
    sort: row.sort, link: row.link || '',
    // Only ready-made pieces with a fixed price go in the cart; the rest are arranged with the studio.
    buyable: row.status === 'active' && row.stock !== 0 && row.supply === 'stock' && row.price !== null && !row.price_from && !row.link,
    image: row.image_id ? origin + '/api/images/' + row.image_id : row.image_url || '',
  };
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
  const items = await env.DB.prepare('SELECT product_id, name, price, qty FROM order_items WHERE order_id = ? ORDER BY rowid').bind(order.id).all();
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

  // Merge repeated lines, then read prices from the database: the browser's numbers are never trusted.
  const wanted = new Map();
  for (const it of Array.isArray(body.items) ? body.items.slice(0, 30) : []) {
    const id = Number(it && it.id);
    const qty = Number(it && it.qty);
    if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1) return [{ error: '購物車內容不正確' }, 400];
    wanted.set(id, (wanted.get(id) || 0) + qty);
  }
  if (!wanted.size) return [{ error: '購物車是空的' }, 400];
  const lines = [];
  for (const [id, qty] of wanted) {
    const row = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
    const p = row && productOut(row, '');
    if (!p || !p.buyable) return [{ error: (row ? '「' + row.name + '」' : '其中一件貨品') + '目前無法線上訂購，請從購物車移除', productId: id }, 409];
    if (qty > SHOP.maxQtyPerItem) return [{ error: '「' + p.name + '」每張訂單最多 ' + SHOP.maxQtyPerItem + ' 件', productId: id }, 400];
    lines.push({ product_id: id, name: p.name, price: p.price, qty });
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
  const shipFee = SHOP.shipping[method].fee;

  // Spending points: never more than the goods are worth, and only with a past order's code as proof.
  let pointsUsed = 0;
  const wantPoints = Number(body.pointsUse) || 0;
  if (wantPoints) {
    const fail = async (error, status) => { await putBackStock(env, taken); return [{ error }, status]; };
    if (!Number.isInteger(wantPoints) || wantPoints < 0) return fail('積分數量不正確', 400);
    if (!await ownsOrder(env, phone, clean(body.pointsCode, 12).toUpperCase())) return fail('積分驗證失敗：請確認過往訂單編號與手機', 400);
    pointsUsed = Math.min(wantPoints, Math.floor(subtotal / SHOP.points.pointValue));
    // The balance check lives inside the INSERT, so the same points can't be spent twice at once.
    const spent = await env.DB.prepare(
      `INSERT INTO points (phone, delta, reason, order_id, created_at)
       SELECT ?1, -?2, '訂單折抵', NULL, ?3 WHERE (SELECT COALESCE(SUM(delta), 0) FROM points WHERE phone = ?1) >= ?2`
    ).bind(phone, pointsUsed, new Date().toISOString()).run();
    if (!spent.meta.changes) return fail('積分不足，請調整使用數量', 409);
  }
  const discount = pointsUsed * SHOP.points.pointValue;

  const order = {
    code: newCode(), name, phone, email, line_id: clean(body.line, 40), ship_method: method, ship_to: shipTo,
    note: clean(body.note, 300), subtotal, discount, points_used: pointsUsed, ship_fee: shipFee, total: subtotal - discount + shipFee,
    status: 'pending', created_at: new Date().toISOString(),
  };
  let saved;
  try {
    saved = await env.DB.prepare(
      `INSERT INTO orders (code, name, phone, email, line_id, ship_method, ship_to, note, subtotal, discount, points_used, ship_fee, total, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).bind(order.code, name, phone, email, order.line_id, method, shipTo, order.note, subtotal, discount, pointsUsed, shipFee, order.total, 'pending', order.created_at).first();
    for (const l of lines) {
      await env.DB.prepare('INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES (?, ?, ?, ?, ?)').bind(saved.id, l.product_id, l.name, l.price, l.qty).run();
    }
  } catch (err) {
    await putBackStock(env, taken);
    await addPoints(env, phone, pointsUsed, '訂單未成立，退回積分');
    throw err;
  }
  await rememberCustomer(env, { name, phone, email, line: order.line_id, marketing: Boolean(body.marketing) });
  notifyOrder(env, ctx, 'order', { ...order, items: lines });
  const willEarn = SHOP.points.earnPer ? Math.floor((subtotal - discount) / SHOP.points.earnPer) : 0;
  return [{ code: order.code, items: lines, subtotal, discount, pointsUsed, shipFee, total: order.total, shipName: SHOP.shipping[method].name, status: 'pending', willEarn }, 201];
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
  const o = await orderWithItems(env, row);
  return [{ code: o.code, status: o.status, items: o.items, subtotal: o.subtotal, discount: o.discount, shipFee: o.ship_fee, total: o.total,
    points: await pointsBalance(env, phone),
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

function isAdmin(request, env) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  return Boolean(env.ADMIN_TOKEN) && token === env.ADMIN_TOKEN;
}

async function admin(request, url, env, ctx) {
  if (!isAdmin(request, env)) return [{ error: '未授權' }, 401];
  const path = url.pathname;

  if (path === '/api/admin/bookings' && request.method === 'GET') {
    const from = isDate(url.searchParams.get('from')) ? url.searchParams.get('from') : taipeiToday();
    const rows = await env.DB.prepare('SELECT * FROM bookings WHERE date >= ? ORDER BY date, time, studio, id').bind(from).all();
    const closed = await env.DB.prepare('SELECT * FROM closures WHERE date >= ? ORDER BY date, studio').bind(from).all();
    return [{ bookings: rows.results, closures: closed.results, config: CONFIG, settings: { notify_emails: await getSetting(env, 'notify_emails') } }, 200];
  }

  const match = path.match(/^\/api\/admin\/bookings\/(\d+)$/);
  if (match && request.method === 'PATCH') {
    const body = await request.json().catch(() => ({}));
    if (!STATUSES.includes(body.status)) return [{ error: '狀態不正確' }, 400];
    const result = await env.DB.prepare('UPDATE bookings SET status = ? WHERE id = ?').bind(body.status, Number(match[1])).run();
    if (!result.meta.changes) return [{ error: '找不到這筆預約' }, 404];
    notify(env, ctx, 'status', await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(Number(match[1])).first());
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
    if (request.method === 'POST' && !productMatch[1]) {
      const saved = await env.DB.prepare(
        `INSERT INTO products (name, stone, cat, supply, note, price, price_from, stock, status, sort, link, image_id, image_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?) RETURNING *`
      ).bind(...fields, new Date().toISOString()).first();
      return [{ product: productOut(saved, url.origin) }, 201];
    }
    if (request.method === 'PUT' && productMatch[1]) {
      // A product keeps its current photo unless a new one was uploaded with this save.
      const before = await env.DB.prepare('SELECT image_id FROM products WHERE id = ?').bind(Number(productMatch[1])).first();
      const saved = await env.DB.prepare(
        `UPDATE products SET name = ?, stone = ?, cat = ?, supply = ?, note = ?, price = ?, price_from = ?, stock = ?, status = ?, sort = ?, link = ?,
           image_id = COALESCE(?, image_id) WHERE id = ? RETURNING *`
      ).bind(...fields, Number(productMatch[1])).first();
      if (!saved) return [{ error: '找不到這件貨品' }, 404];
      // The photo it replaced is no longer used by anything.
      if (before && before.image_id && before.image_id !== saved.image_id) await env.DB.prepare('DELETE FROM images WHERE id = ?').bind(before.image_id).run();
      return [{ product: productOut(saved, url.origin) }, 200];
    }
  }
  if (productMatch && productMatch[1] && request.method === 'DELETE') {
    const gone = await env.DB.prepare('DELETE FROM products WHERE id = ? RETURNING image_id').bind(Number(productMatch[1])).first();
    if (!gone) return [{ error: '找不到這件貨品' }, 404];
    if (gone.image_id) await env.DB.prepare('DELETE FROM images WHERE id = ?').bind(gone.image_id).run();
    return [{ ok: true }, 200];
  }

  if (path === '/api/admin/orders' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 300').all();
    const items = await env.DB.prepare('SELECT order_id, product_id, name, price, qty FROM order_items WHERE order_id IN (SELECT id FROM orders ORDER BY id DESC LIMIT 300)').all();
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
    }
    // Points are earned once, the first time the studio confirms the money arrived.
    const nowPaid = ['paid', 'shipped', 'done'].includes(status) && !['paid', 'shipped', 'done'].includes(current.status);
    if (nowPaid && !current.points_earned && SHOP.points.earnPer) {
      const earned = Math.floor((current.subtotal - current.discount) / SHOP.points.earnPer);
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
    return [{ customers: rows.results, points: SHOP.points }, 200];
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

  if (path === '/api/admin/report' && request.method === 'GET') {
    return [await report(env), 200];
  }

  if (path === '/api/admin/settings' && request.method === 'PUT') {
    const body = await request.json().catch(() => ({}));
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
        result = await createBooking(await request.json().catch(() => ({})), env, ctx);
      } else if (url.pathname === '/api/bookings/payment' && request.method === 'POST') {
        result = await reportPayment(await request.json().catch(() => ({})), env, ctx);
      } else if (url.pathname === '/api/products' && request.method === 'GET') {
        return json({ products: await listProducts(env, url.origin, false), categories: await listCategories(env), shipping: SHOP.shipping, maxQtyPerItem: SHOP.maxQtyPerItem, points: SHOP.points }, 200, { ...headers, 'Cache-Control': 'public, max-age=60' });
      } else if (url.pathname === '/api/orders' && request.method === 'POST') {
        result = await createOrder(await request.json().catch(() => ({})), env, ctx);
      } else if (url.pathname === '/api/orders/payment' && request.method === 'POST') {
        result = await reportOrderPayment(await request.json().catch(() => ({})), env, ctx);
      } else if (url.pathname === '/api/points/balance' && request.method === 'POST') {
        result = await checkPoints(await request.json().catch(() => ({})), env);
      } else if (url.pathname === '/api/orders/lookup' && request.method === 'POST') {
        result = await lookupOrder(await request.json().catch(() => ({})), env);
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
