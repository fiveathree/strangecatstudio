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
// -----------------------------------------------------------------------------

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const STATUSES = ['pending', 'reported', 'confirmed', 'cancelled'];

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

/** Tells the studio's notifier (a Google Apps Script web app) about a change. */
function notify(env, ctx, event, booking) {
  if (!env.NOTIFY_URL || !booking) return;
  const payload = {
    event, // 'booked' | 'payment' | 'status'
    booking: { ...booking, studioName: CONFIG.studios[booking.studio].name, typeName: CONFIG.types[booking.type] },
    slotMinutes: CONFIG.slotMinutes,
  };
  const send = fetch(env.NOTIFY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    .catch((err) => console.error('notify failed', err));
  // Let the reply to the customer go out without waiting for the notifier.
  if (ctx && ctx.waitUntil) ctx.waitUntil(send);
}

function cors(env, request) {
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
  const origin = request.headers.get('Origin') || '';
  const allow = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
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
    return [{ bookings: rows.results, closures: closed.results, config: CONFIG }, 200];
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
