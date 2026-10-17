// Runs the Worker against an in-memory SQLite database standing in for D1.
//   node --experimental-sqlite booking/test.mjs          run the checks
//   node --experimental-sqlite booking/test.mjs serve    serve the API on :8787 for trying the pages locally
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import assert from 'node:assert/strict';
import worker, { CONFIG, slotTimes, taipeiToday } from './worker.js';

const here = new URL('.', import.meta.url);
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(new URL('schema.sql', here), 'utf8'));

// Just enough of D1's interface for the Worker: prepare().bind().all()/first()/run().
// D1 lets a numbered placeholder (?2) be reused; node:sqlite wants named ones.
const DB = {
  prepare(sql) {
    const numbered = /\?\d+/.test(sql);
    const stmt = sqlite.prepare(numbered ? sql.replace(/\?(\d+)/g, ':p$1') : sql);
    let args = [];
    const params = () => (numbered ? [Object.fromEntries(args.map((v, i) => ['p' + (i + 1), v]))] : args);
    const api = {
      bind(...values) { args = values; return api; },
      async all() { return { results: stmt.all(...params()) }; },
      async first() { return stmt.get(...params()) ?? null; },
      async run() { const r = stmt.run(...params()); return { meta: { changes: Number(r.changes) } }; },
    };
    return api;
  },
};
const env = { DB, ADMIN_TOKEN: 'test-token', ALLOWED_ORIGINS: '*' };

async function call(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await worker.fetch(new Request('http://local' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, data: await res.json() };
}

// A stand-in for a phone's passkey, built on Node's own ECDSA (which signs in DER, as browsers do) to cross-check the Worker.
const SITE = 'https://studio.example';
const devices = {};
const b64u = (data) => Buffer.from(data).toString('base64url');
/** What a browser sends back for a sign-in step: creates a passkey for `who`, or signs the challenge with theirs. */
async function device(who, step, origin = SITE, flags = 5, rp = new URL(origin).hostname) {
  const made = !!step.register;
  const clientData = Buffer.from(JSON.stringify({ type: made ? 'webauthn.create' : 'webauthn.get', challenge: (step.register || step.passkey).challenge, origin }));
  if (made) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    devices[who] = { id: b64u(randomBytes(16)), ...pair };
    return { id: devices[who].id, publicKey: b64u(pair.publicKey.export({ type: 'spki', format: 'der' })), alg: -7, clientDataJSON: b64u(clientData) };
  }
  const d = devices[who];
  const auth = Buffer.concat([createHash('sha256').update(rp).digest(), Buffer.from([flags, 0, 0, 0, 1])]);
  const signature = sign('sha256', Buffer.concat([auth, createHash('sha256').update(clientData).digest()]), d.privateKey);
  return { id: d.id, clientDataJSON: b64u(clientData), authenticatorData: b64u(auth), signature: b64u(signature) };
}

// Lets the lockout checks start at the beginning of a 15-minute block.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const nextBlock = () => { skew += 900000 - (Date.now() % 900000) + 1000; };

/** Signs in with password and passkey, creating the passkey first if the account has none yet. */
async function signIn(username, password, ip) {
  const send = async (extra) => {
    const headers = { 'Content-Type': 'application/json' };
    if (ip) headers['CF-Connecting-IP'] = ip;
    const res = await worker.fetch(new Request('http://local/api/admin/login', { method: 'POST', headers, body: JSON.stringify({ username, password, ...extra }) }), env);
    return { status: res.status, data: await res.json() };
  };
  const r = await send({});
  if (!r.data.passkey && !r.data.register) return r;
  return send({ passkey: await device(username.toLowerCase(), r.data) });
}

function nextDate(studio, offset = 2) {
  const d = new Date(taipeiToday() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + offset);
  while (!CONFIG.studios[studio].weekdays.includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

if (process.argv[2] === 'serve') {
  createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request('http://localhost:8787' + req.url, {
      method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const out = await worker.fetch(request, env);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  }).listen(8787, () => console.log('booking API on http://localhost:8787 (master password: test-token, then set up 2FA)'));
} else {
  const ADMIN = (await signIn('', 'test-token')).data.token;
  assert.ok(ADMIN, 'the master password signs in with 2FA');
  assert.deepEqual(slotTimes('tn'), ['13:30', '15:00', '16:30', '18:00', '19:30']);
  assert.deepEqual(slotTimes('kh'), ['13:30', '15:00', '16:30', '18:00']);

  const tn = nextDate('tn');
  const person = { studio: 'tn', date: tn, time: '15:00', type: 'class', people: 2, name: '測試', phone: '0912345678' };

  let r = await call('GET', `/api/slots?studio=tn&from=${tn}&days=3`);
  assert.equal(r.status, 200);
  assert.equal(r.data.days[0].slots.find((s) => s.time === '15:00').left, CONFIG.capacity);

  r = await call('POST', '/api/bookings', person);
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'pending');
  const code = r.data.code;

  // Fill the slot exactly, then one more must be refused.
  r = await call('POST', '/api/bookings', { ...person, people: CONFIG.capacity - 2, type: 'visit' });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'confirmed', 'visits need no payment');
  r = await call('POST', '/api/bookings', { ...person, people: 1 });
  assert.equal(r.status, 409, 'a full slot refuses another booking');
  r = await call('GET', `/api/slots?studio=tn&from=${tn}&days=1`);
  assert.equal(r.data.days[0].slots.find((s) => s.time === '15:00').left, 0);

  // Studios keep separate calendars.
  r = await call('GET', `/api/slots?studio=kh&from=${tn}&days=7`);
  assert.ok(r.data.days.filter((d) => !d.closed).every((d) => d.slots.every((s) => s.left === CONFIG.capacity)));
  assert.ok(r.data.days.some((d) => d.closed), 'Kaohsiung is closed on Sunday and Monday');

  // Bad input.
  assert.equal((await call('POST', '/api/bookings', { ...person, time: '14:00' })).status, 400);
  assert.equal((await call('POST', '/api/bookings', { ...person, date: taipeiToday() })).status, 400, 'no same-day bookings');
  assert.equal((await call('POST', '/api/bookings', { ...person, name: '' })).status, 400);

  // Payment report needs the matching phone.
  assert.equal((await call('POST', '/api/bookings/payment', { code, phone: '0900000000', last5: '12345' })).status, 404);
  assert.equal((await call('POST', '/api/bookings/payment', { code, phone: person.phone, last5: '1234' })).status, 400);
  assert.equal((await call('POST', '/api/bookings/payment', { code, phone: person.phone, last5: '12345' })).status, 200);

  // Admin.
  assert.equal((await call('GET', '/api/admin/bookings')).status, 401);
  r = await call('GET', '/api/admin/bookings', null, ADMIN);
  assert.equal(r.data.bookings.length, 2);
  const first = r.data.bookings.find((b) => b.code === code);
  assert.equal(first.status, 'reported');
  assert.equal(first.pay_last5, '12345');
  assert.equal((await call('PATCH', `/api/admin/bookings/${first.id}`, { status: 'cancelled' }, ADMIN)).status, 200);
  r = await call('GET', `/api/slots?studio=tn&from=${tn}&days=1`);
  assert.equal(r.data.days[0].slots.find((s) => s.time === '15:00').left, 2, 'cancelling frees the places');

  // Closing a day.
  assert.equal((await call('POST', '/api/admin/closures', { studio: 'tn', date: tn, reason: '國定假日' }, ADMIN)).status, 200);
  r = await call('GET', `/api/slots?studio=tn&from=${tn}&days=1`);
  assert.equal(r.data.days[0].closed, '國定假日');
  assert.equal((await call('POST', '/api/bookings', { ...person, time: '18:00' })).status, 400);

  // One city a day: a Kaohsiung booking closes Tainan that date, and the reverse.
  const kh = nextDate('kh', 9);
  const guest = { studio: 'kh', date: kh, time: '13:30', type: 'visit', people: 1, name: '高雄客', phone: '0987654321' };
  assert.equal((await call('POST', '/api/bookings', guest)).status, 201);
  r = await call('GET', `/api/slots?studio=tn&from=${kh}&days=1`);
  assert.equal(r.data.days[0].closed, '當日於高雄工作室服務');
  r = await call('POST', '/api/bookings', { ...person, date: kh, time: '18:00' });
  assert.equal(r.status, 409, 'Tainan is closed once Kaohsiung is booked that day');
  assert.match(r.data.error, /高雄工作室/);
  const tnOnly = nextDate('kh', 16);
  assert.equal((await call('POST', '/api/bookings', { ...person, date: tnOnly, time: '13:30' })).status, 201);
  assert.equal((await call('POST', '/api/bookings', { ...guest, date: tnOnly })).status, 409, 'and Kaohsiung once Tainan is booked');
  // Cancelling the Kaohsiung booking reopens Tainan.
  r = await call('GET', '/api/admin/bookings', null, ADMIN);
  const khBooking = r.data.bookings.find((b) => b.studio === 'kh');
  await call('PATCH', `/api/admin/bookings/${khBooking.id}`, { status: 'cancelled' }, ADMIN);
  r = await call('GET', `/api/slots?studio=tn&from=${kh}&days=1`);
  assert.equal(r.data.days[0].closed, null);

  // Notification recipients.
  assert.equal((await call('PUT', '/api/admin/settings', { notify_emails: 'a@b.co' })).status, 401);
  assert.equal((await call('PUT', '/api/admin/settings', { notify_emails: 'not-an-email' }, ADMIN)).status, 400);
  r = await call('PUT', '/api/admin/settings', { notify_emails: 'boss@example.com， staff@example.com' }, ADMIN);
  assert.equal(r.data.notify_emails, 'boss@example.com,staff@example.com');
  r = await call('GET', '/api/admin/bookings', null, ADMIN);
  assert.equal(r.data.settings.notify_emails, 'boss@example.com,staff@example.com');

  // ---- Shop catalogue ----
  const item = { name: '玻璃鑽石戒指', stone: 'glass', cat: 'ring', supply: 'stock', note: '6–7mm', price: 2980, priceFrom: false, stock: 2, status: 'active', sort: 1, link: '' };
  assert.equal((await call('POST', '/api/admin/products', item)).status, 401);
  assert.equal((await call('POST', '/api/admin/products', { ...item, stone: 'gold' }, ADMIN)).status, 400);
  assert.equal((await call('POST', '/api/admin/products', { ...item, link: 'javascript:alert(1)' }, ADMIN)).status, 400);
  r = await call('POST', '/api/admin/products', item, ADMIN);
  assert.equal(r.status, 201);
  const pid = r.data.product.id;
  await call('POST', '/api/admin/products', { ...item, name: '隱藏款', status: 'hidden' }, ADMIN);
  r = await call('GET', '/api/products');
  assert.deepEqual(r.data.products.map((p) => p.name), ['玻璃鑽石戒指'], 'hidden products stay out of the shop');
  assert.equal((await call('GET', '/api/admin/products', null, ADMIN)).data.products.length, 2);

  // A photo upload, then attach it; a later save without a new photo keeps it.
  const photo = await worker.fetch(new Request('http://local/api/admin/images', { method: 'POST', headers: { 'Content-Type': 'image/jpeg', Authorization: 'Bearer ' + ADMIN }, body: new Uint8Array([255, 216, 255, 1, 2, 3]) }), env);
  assert.equal(photo.status, 201);
  const photoId = (await photo.json()).id;
  r = await call('PUT', `/api/admin/products/${pid}`, { ...item, imageId: photoId }, ADMIN);
  assert.match(r.data.product.image, /\/api\/images\/\d+$/);
  r = await call('PUT', `/api/admin/products/${pid}`, { ...item, stock: 0 }, ADMIN);
  assert.match(r.data.product.image, /\/api\/images\/\d+$/, 'photo kept');
  assert.equal(r.data.product.status, 'soldout', 'no stock left reads as sold out');
  const served = await worker.fetch(new Request('http://local/api/images/' + photoId), env);
  assert.equal(served.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(new Uint8Array(await served.arrayBuffer()).length, 6);
  const text = await worker.fetch(new Request('http://local/api/admin/images', { method: 'POST', headers: { 'Content-Type': 'text/html', Authorization: 'Bearer ' + ADMIN }, body: '<b>' }), env);
  assert.equal(text.status, 400);
  assert.equal((await call('DELETE', `/api/admin/products/${pid}`, null, ADMIN)).status, 200);
  assert.equal((await worker.fetch(new Request('http://local/api/images/' + photoId), env)).status, 404, 'its photo goes with it');

  // ---- Categories ----
  r = await call('GET', '/api/products');
  assert.deepEqual(r.data.categories.cat.map((c) => c.slug), ['ring', 'necklace', 'earrings', 'bracelet', 'other']);
  assert.equal((await call('POST', '/api/admin/categories', { kind: 'cat', name: '戒指' }, ADMIN)).status, 409);
  r = await call('POST', '/api/admin/categories', { kind: 'cat', name: '胸針' }, ADMIN);
  assert.equal(r.status, 201);
  const brooch = r.data.categories.cat.find((c) => c.name === '胸針');
  r = await call('POST', '/api/admin/products', { ...item, name: '貓胸針', cat: brooch.slug }, ADMIN);
  assert.equal(r.status, 201, 'a new category can be used straight away');
  assert.equal((await call('DELETE', `/api/admin/categories/${brooch.id}`, null, ADMIN)).status, 409, 'still in use');
  r = await call('PUT', `/api/admin/categories/${brooch.id}`, { name: '別針', sort: 5 }, ADMIN);
  assert.equal(r.data.categories.cat[0].name, '別針', 'renamed and moved to the front');
  await call('DELETE', `/api/admin/products/${r.data && (await call('GET', '/api/admin/products', null, ADMIN)).data.products.find((p) => p.name === '貓胸針').id}`, null, ADMIN);
  assert.equal((await call('DELETE', `/api/admin/categories/${brooch.id}`, null, ADMIN)).status, 200);

  // ---- Orders ----
  const mk = async (over) => (await call('POST', '/api/admin/products', { ...item, ...over }, ADMIN)).data.product;
  const ring = await mk({ name: '現貨戒指', stock: 2, price: 1000 });
  const loose = await mk({ name: '不計庫存', stock: '', price: 500 });
  const bespoke = await mk({ name: '訂製款', supply: 'made', stock: '' });
  assert.equal(ring.buyable, true);
  assert.equal(bespoke.buyable, false, 'made-to-order pieces are arranged with the studio');
  const buyer = { name: '買家', phone: '0911-222-333', email: 'b@example.com', shipMethod: 'store', shipTo: '成大門市', items: [{ id: ring.id, qty: 2 }, { id: loose.id, qty: 1 }] };
  assert.equal((await call('POST', '/api/orders', { ...buyer, items: [] })).status, 400);
  assert.equal((await call('POST', '/api/orders', { ...buyer, shipTo: '' })).status, 400, 'a store order needs the store');
  assert.equal((await call('POST', '/api/orders', { ...buyer, items: [{ id: bespoke.id, qty: 1 }] })).status, 409);
  // Not enough of the second item: the first item's stock must come back.
  r = await call('POST', '/api/orders', { ...buyer, items: [{ id: loose.id, qty: 1 }, { id: ring.id, qty: 3 }] });
  assert.equal(r.status, 409);
  r = await call('POST', '/api/orders', { ...buyer, items: [{ id: ring.id, qty: 1, price: 1 }, { id: ring.id, qty: 1 }, { id: loose.id, qty: 1 }] });
  assert.equal(r.status, 201);
  assert.equal(r.data.total, 2 * 1000 + 500 + 60, 'server prices plus the store fee');
  const orderCode = r.data.code;
  r = await call('GET', '/api/products');
  assert.equal(r.data.products.find((p) => p.id === ring.id).status, 'soldout', 'the last pieces are gone');
  assert.equal(r.data.shipping.store.fee, 60);
  assert.equal((await call('POST', '/api/orders', { ...buyer, shipMethod: 'tn', shipTo: '', items: [{ id: ring.id, qty: 1 }] })).status, 409);

  assert.equal((await call('POST', '/api/orders/lookup', { code: orderCode, phone: '0900000000' })).status, 404);
  assert.equal((await call('POST', '/api/orders/payment', { code: orderCode, phone: '0911222333', last5: '54321' })).status, 200);
  r = await call('POST', '/api/orders/lookup', { code: orderCode, phone: '0911222333' });
  assert.equal(r.data.status, 'reported');
  assert.equal(r.data.items.length, 2);

  assert.equal((await call('GET', '/api/admin/orders')).status, 401);
  r = await call('GET', '/api/admin/orders', null, ADMIN);
  const ord = r.data.orders[0];
  assert.equal(ord.pay_last5, '54321');
  r = await call('PATCH', `/api/admin/orders/${ord.id}`, { status: 'shipped', tracking: 'A123456789' }, ADMIN);
  assert.equal(r.data.order.tracking, 'A123456789');
  assert.equal((await call('POST', '/api/orders/lookup', { code: orderCode, phone: '0911222333' })).data.tracking, 'A123456789');

  // Customers: one record per phone, with what they have ordered and booked.
  r = await call('GET', '/api/admin/customers', null, ADMIN);
  const cust = r.data.customers.find((c) => c.phone === '0911222333');
  assert.equal(cust.orders, 1);
  assert.equal(cust.spent, 2560);
  assert.ok(r.data.customers.find((c) => c.phone === person.phone).bookings >= 1, 'bookings create customers too');
  assert.equal((await call('PUT', '/api/admin/customers/0911222333', { name: '買家', note: '喜歡藍色', tags: 'VIP， 寵物紀念,VIP', birthday: '03-15' }, ADMIN)).status, 200);
  assert.equal((await call('PUT', '/api/admin/customers/0911222333', { name: '買家', birthday: '13-40' }, ADMIN)).status, 400);
  r = await call('GET', '/api/admin/customers/0911222333', null, ADMIN);
  assert.equal(r.data.customer.note, '喜歡藍色');
  assert.equal(r.data.customer.tags, 'VIP,寵物紀念');
  assert.equal(r.data.points, 25, 'NT$2,500 of goods paid for earns 25 points');
  assert.equal(r.data.orders[0].items.length, 2);

  // Cancelling gives the stock back, once, and is final.
  r = await call('PATCH', `/api/admin/orders/${ord.id}`, { status: 'cancelled' }, ADMIN);
  await call('PATCH', `/api/admin/orders/${ord.id}`, { status: 'cancelled' }, ADMIN);
  r = await call('GET', '/api/admin/products', null, ADMIN);
  assert.equal(r.data.products.find((p) => p.id === ring.id).stock, 2);
  assert.equal(r.data.products.find((p) => p.id === loose.id).stock, null);
  assert.equal((await call('PATCH', `/api/admin/orders/${ord.id}`, { status: 'paid' }, ADMIN)).status, 400);

  // ---- Points ----
  r = await call('GET', '/api/admin/customers/0911222333', null, ADMIN);
  assert.equal(r.data.points, 0, 'a cancelled order takes its points back');
  await call('POST', '/api/admin/customers/0911222333/points', { delta: 300, reason: '體驗課回饋' }, ADMIN);
  assert.equal((await call('POST', '/api/admin/customers/0911222333/points', { delta: -999 }, ADMIN)).status, 400, 'never below zero');
  assert.equal((await call('POST', '/api/points/balance', { phone: '0911222333', code: 'WRONG1' })).status, 404);
  assert.equal((await call('POST', '/api/points/balance', { phone: '0911222333', code: orderCode })).data.points, 300);
  const spend = { ...buyer, shipMethod: 'tn', shipTo: '', items: [{ id: loose.id, qty: 1 }], marketing: true };
  assert.equal((await call('POST', '/api/orders', { ...spend, pointsUse: 100, pointsCode: 'WRONG1' })).status, 400, 'points need proof');
  assert.equal((await call('POST', '/api/orders', { ...spend, items: [{ id: ring.id, qty: 1 }], pointsUse: 5000, pointsCode: orderCode })).status, 409, 'not that many points');
  r = await call('GET', '/api/admin/products', null, ADMIN);
  assert.equal(r.data.products.find((p) => p.id === ring.id).stock, 2, 'a refused order leaves the stock alone');
  r = await call('POST', '/api/orders', { ...spend, pointsUse: 300, pointsCode: orderCode });
  assert.equal(r.status, 201);
  assert.equal(r.data.discount, 300);
  assert.equal(r.data.total, 200);
  assert.equal(r.data.willEarn, 2);
  r = await call('GET', '/api/admin/orders', null, ADMIN);
  const second = r.data.orders[0];
  r = await call('PATCH', `/api/admin/orders/${second.id}`, { status: 'paid' }, ADMIN);
  assert.equal(r.data.order.points_earned, 2);
  await call('PATCH', `/api/admin/orders/${second.id}`, { status: 'shipped' }, ADMIN);
  r = await call('GET', '/api/admin/customers/0911222333', null, ADMIN);
  assert.equal(r.data.points, 2, 'spent 300, earned 2, and only once');
  assert.equal(r.data.customer.marketing, 1);
  await call('PATCH', `/api/admin/orders/${second.id}`, { status: 'cancelled' }, ADMIN);
  assert.equal((await call('GET', '/api/admin/customers/0911222333', null, ADMIN)).data.points, 300, 'cancelling gives the spent points back');

  // Adding a customer by hand, and the report.
  assert.equal((await call('POST', '/api/admin/customers', { name: '現場客', phone: '0955-000-111', tags: '台南' }, ADMIN)).status, 201);
  assert.equal((await call('POST', '/api/admin/customers', { name: '現場客', phone: '0955000111' }, ADMIN)).status, 409);
  assert.equal((await call('GET', '/api/admin/report')).status, 401);
  const third = (await call('POST', '/api/orders', { ...spend, items: [{ id: ring.id, qty: 1 }] })).data;
  r = await call('GET', '/api/admin/orders', null, ADMIN);
  await call('PATCH', `/api/admin/orders/${r.data.orders[0].id}`, { status: 'paid' }, ADMIN);
  r = await call('GET', '/api/admin/report', null, ADMIN);
  assert.equal(r.data.totals.revenue, third.total);
  assert.equal(r.data.totals.paid_orders, 1);
  assert.equal(r.data.top[0].name, '現貨戒指');
  // Bookings can fall in next month, so look up this month rather than the newest one.
  assert.equal(r.data.months.find((m) => m.month === taipeiToday().slice(0, 7)).revenue, third.total);
  assert.ok(r.data.months.some((m) => m.bookings > 0));

  // ---- Points rules and class points ----
  assert.equal((await call('PUT', '/api/admin/settings', { points: { earnPer: 50, pointValue: 0, classPoints: 30 } }, ADMIN)).status, 400);
  r = await call('PUT', '/api/admin/settings', { points: { earnPer: 50, pointValue: 2, classPoints: 30 } }, ADMIN);
  assert.deepEqual(r.data.points, { earnPer: 50, pointValue: 2, classPoints: 30, expireMonths: 0 });
  assert.equal((await call('GET', '/api/products')).data.points.earnPer, 50);
  assert.equal((await call('GET', '/api/admin/bookings', null, ADMIN)).data.settings.notify_emails, 'boss@example.com,staff@example.com', 'saving rules leaves the recipients alone');
  const classDay = nextDate('tn', 30);
  r = await call('POST', '/api/bookings', { ...person, date: classDay, time: '13:30', phone: '0977000111', name: '學員' });
  const classCode = r.data.code;
  r = await call('GET', '/api/admin/bookings', null, ADMIN);
  const classBooking = r.data.bookings.find((b) => b.code === classCode);
  await call('PATCH', `/api/admin/bookings/${classBooking.id}`, { status: 'confirmed' }, ADMIN);
  await call('PATCH', `/api/admin/bookings/${classBooking.id}`, { status: 'confirmed' }, ADMIN);
  assert.equal((await call('POST', '/api/points/balance', { phone: '0977000111', code: classCode })).data.points, 30, 'class points once, and a booking code proves who you are');
  await call('PATCH', `/api/admin/bookings/${classBooking.id}`, { status: 'cancelled' }, ADMIN);
  assert.equal((await call('GET', '/api/admin/customers/0977000111', null, ADMIN)).data.points, 0);
  assert.equal((await call('GET', '/api/admin/points')).status, 401);
  r = await call('GET', '/api/admin/points', null, ADMIN);
  assert.equal(r.data.totals.outstanding, r.data.totals.issued - r.data.totals.used);
  assert.ok(r.data.ledger.length > 5 && r.data.ledger[0].name);
  assert.equal(r.data.top[0].phone, '0911222333');

  // ---- Accounts, roles and the activity log ----
  const as = async (method, path, body, token, ip) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (ip) headers['CF-Connecting-IP'] = ip;
    const res = await worker.fetch(new Request('http://local' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
    return { status: res.status, data: await res.json() };
  };
  assert.equal((await call('POST', '/api/admin/login', { username: '', password: 'wrong' })).status, 401);
  r = await signIn('', 'test-token');
  assert.equal(r.data.role, 'owner');
  const ownerToken = r.data.token;
  assert.equal((await call('GET', '/api/admin/me', null, ownerToken)).data.master, true);
  assert.equal((await call('POST', '/api/admin/staff', { username: 'mei', name: '小美', role: 'staff', password: 'short' }, ownerToken)).status, 400);
  assert.equal((await call('POST', '/api/admin/staff', { username: 'mei', name: '小美', role: 'staff', password: 'correct-horse' }, ownerToken)).status, 201);
  assert.equal((await call('POST', '/api/admin/staff', { username: 'mei', name: '另一位', role: 'staff', password: 'correct-horse' }, ownerToken)).status, 409);
  assert.equal((await call('POST', '/api/admin/login', { username: 'mei', password: 'nope-nope' })).status, 401);
  r = await signIn('Mei', 'correct-horse');
  const staffToken = r.data.token;
  assert.equal(r.data.role, 'staff');
  assert.equal((await call('GET', '/api/admin/orders', null, staffToken)).status, 200, 'staff run the day-to-day pages');
  for (const path of ['/api/admin/staff', '/api/admin/report', '/api/admin/audit', '/api/admin/backup', '/api/admin/promos']) {
    assert.equal((await call('GET', path, null, staffToken)).status, 403, path + ' is for the owner');
  }
  assert.equal((await call('PUT', '/api/admin/settings', { notify_emails: '' }, staffToken)).status, 403);
  assert.equal((await call('PUT', '/api/admin/password', { current: 'wrong', next: 'new-password-1' }, staffToken)).status, 400);
  assert.equal((await call('PUT', '/api/admin/password', { current: 'correct-horse', next: 'new-password-1' }, staffToken)).status, 200);
  assert.equal((await signIn('mei', 'new-password-1')).status, 200);
  await call('POST', '/api/admin/closures', { studio: 'kh', date: nextDate('kh', 40), reason: '進修' }, staffToken);
  r = await call('GET', '/api/admin/audit', null, ownerToken);
  assert.equal(r.data.audit[0].action, '新增休息日');
  assert.equal(r.data.audit[0].staff_name, '小美');
  assert.ok(!JSON.stringify(r.data.audit).includes('new-password-1'), 'passwords never reach the log');
  const mei = (await call('GET', '/api/admin/staff', null, ownerToken)).data.staff[0];
  assert.ok(!('hash' in mei));
  await call('PUT', `/api/admin/staff/${mei.id}`, { username: 'mei', name: '小美', role: 'staff', active: false }, ownerToken);
  assert.equal((await call('GET', '/api/admin/orders', null, staffToken)).status, 401, 'a switched-off account is signed out');
  await call('POST', '/api/admin/logout', null, ownerToken);
  assert.equal((await call('GET', '/api/admin/me', null, ownerToken)).status, 401);

  // ---- Two-step sign-in with a passkey ----
  env.ALLOWED_ORIGINS = SITE; // passkeys made on any other site must be refused
  assert.equal((await call('GET', '/api/admin/orders', null, 'test-token')).status, 401, 'the master password is no longer an API key');
  await call('POST', '/api/admin/staff', { username: 'kai', name: '阿凱', role: 'staff', password: 'kai-password' }, ADMIN);
  const kai = (extra) => call('POST', '/api/admin/login', { username: 'kai', password: 'kai-password', ...extra });
  nextBlock();
  r = await kai({});
  assert.ok(r.status === 401 && !r.data.token && r.data.register.challenge, 'a password alone only starts the set-up');
  const made = await device('kai', r.data);
  const madeElsewhere = JSON.parse(Buffer.from(made.clientDataJSON, 'base64url'));
  assert.equal((await kai({ passkey: { ...made, clientDataJSON: b64u(JSON.stringify({ ...madeElsewhere, challenge: 'old' })) } })).status, 401, 'a passkey made for another challenge is refused');
  r = await kai({ passkey: made });
  assert.equal(r.status, 200);
  assert.equal(r.data.backupCodes.length, 10);
  const kaiBackup = r.data.backupCodes;
  r = await kai({});
  assert.ok(r.status === 401 && !r.data.token && r.data.passkey.ids[0] === made.id, 'once set up, the password alone is not enough');
  const signed = await device('kai', r.data);
  assert.equal((await kai({ passkey: signed })).status, 200);
  assert.equal((await kai({ passkey: signed })).status, 401, 'a signed challenge works once');
  nextBlock();
  r = await kai({});
  assert.equal((await kai({ passkey: await device('kai', r.data, 'https://fake-studio.example') })).status, 401, 'a look-alike site gets nothing');
  assert.equal((await kai({ passkey: { ...(await device('kai', r.data)), signature: signed.signature } })).status, 401, 'a wrong signature is refused');
  assert.equal((await kai({ passkey: await device('kai', r.data, SITE, 1) })).status, 401, 'the passkey must be unlocked with a fingerprint, face or PIN');
  assert.equal((await kai({ passkey: await device('kai', r.data, SITE, 5, 'fake-studio.example') })).status, 401, 'a passkey for another site is refused');
  assert.equal((await kai({ passkey: await device('kai', r.data) })).status, 200);
  nextBlock();
  assert.equal((await kai({ code: kaiBackup[0].toLowerCase() })).status, 200, 'a backup code stands in for the passkey');
  assert.equal((await kai({ code: kaiBackup[0] })).status, 401, 'a backup code works once');
  r = await call('GET', '/api/admin/audit', null, ADMIN);
  assert.equal(r.data.audit.find((a) => a.staff_name === '阿凱').detail, '使用備用碼');
  // Five failures in one 15-minute block lock the account, right passkey or not.
  nextBlock();
  r = await kai({});
  for (let i = 0; i < 5; i++) assert.equal((await kai({ passkey: { ...(await device('kai', r.data)), signature: signed.signature } })).status, 401);
  assert.equal((await kai({ passkey: await device('kai', r.data) })).status, 429);
  nextBlock();
  r = await kai({});
  r = await kai({ passkey: await device('kai', r.data) });
  assert.equal(r.status, 200, 'the lock lifts after 15 minutes');
  const kaiToken = r.data.token;
  // The owner resets someone's passkey (a new phone): signed out, and set up again next time.
  const kaiRow = (await call('GET', '/api/admin/staff', null, ADMIN)).data.staff.find((m) => m.username === 'kai');
  assert.ok(!('mfa' in kaiRow), 'the 2FA record is never sent out');
  assert.equal((await call('PUT', `/api/admin/staff/${kaiRow.id}`, { username: 'kai', name: '阿凱', role: 'staff', resetMfa: true }, ADMIN)).status, 200);
  assert.equal((await call('GET', '/api/admin/me', null, kaiToken)).status, 401);
  assert.ok((await kai({})).data.register);
  const backup = JSON.stringify((await call('GET', '/api/admin/backup', null, ADMIN)).data);
  assert.ok(!backup.includes('master_mfa') && !backup.includes(devices[''].id), 'the master passkey stays out of backups');
  env.ALLOWED_ORIGINS = '*';

  // ---- Too many attempts from one address ----
  let last;
  for (let i = 0; i < 20; i++) assert.equal((await as('POST', '/api/admin/login', { username: 'x', password: 'y' }, null, '203.0.113.9')).status, 401, '20 tries leave room for 2FA sign-ins');
  last = await as('POST', '/api/admin/login', { username: 'x', password: 'y' }, null, '203.0.113.9');
  assert.equal(last.status, 429);
  assert.equal((await signIn('', 'test-token', '203.0.113.10')).status, 200, 'other visitors are unaffected');

  // ---- Options, sale price, promo codes, free shipping ----
  await call('PUT', '/api/admin/settings', { points: { earnPer: 100, pointValue: 1, classPoints: 0 } }, ADMIN);
  assert.equal((await call('POST', '/api/admin/products', { ...item, name: '特價戒', price: 2000, salePrice: 2500 }, ADMIN)).status, 400);
  const sized = (await call('POST', '/api/admin/products', { ...item, name: '特價戒', price: 2000, salePrice: 1500, stock: 5, description: '手工拋光',
    options: [{ name: '戒圍', values: ['10', '11', '12'] }] }, ADMIN)).data.product;
  assert.equal(sized.priceNow, 1500);
  assert.deepEqual(sized.options, [{ name: '戒圍', values: ['10', '11', '12'] }]);
  const shopper = { name: '新客', phone: '0933000111', email: 'new@example.com', shipMethod: 'store', shipTo: '成大門市' };
  assert.equal((await call('POST', '/api/orders', { ...shopper, items: [{ id: sized.id, qty: 1 }] })).status, 400, 'a size must be chosen');
  assert.equal((await call('POST', '/api/orders', { ...shopper, items: [{ id: sized.id, qty: 1, options: { 戒圍: '99' } }] })).status, 400);
  assert.equal((await call('POST', '/api/admin/promos', { code: 'hi', kind: 'percent', value: 10 }, ADMIN)).status, 400);
  assert.equal((await call('POST', '/api/admin/promos', { code: 'open10', kind: 'percent', value: 10, minSpend: 2000, maxUses: 1 }, ADMIN)).status, 201);
  assert.equal((await call('POST', '/api/promos/check', { code: 'OPEN10', subtotal: 1500 })).status, 404, 'below the minimum spend');
  assert.equal((await call('POST', '/api/promos/check', { code: 'open10', subtotal: 3000 })).data.discount, 300);
  await call('PUT', '/api/admin/settings', { shop: { bankInfo: '測試銀行 123', freeShipOver: 2500, customerEmails: true } }, ADMIN);
  r = await call('GET', '/api/products');
  assert.equal(r.data.freeShipOver, 2500);
  assert.equal(r.data.bankInfo, '測試銀行 123');

  // The notifier is replaced by a recorder so the emails customers would get can be read.
  const sentMail = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sentMail.push(JSON.parse(init.body)); return new Response('{}'); };
  env.NOTIFY_URL = 'https://notify.example/hook';
  env.SITE_URL = 'https://shop.example/';
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const post = async (method, path, body, token) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await worker.fetch(new Request('http://local' + path, { method, headers, body: JSON.stringify(body) }), env, ctx);
    await Promise.all(waits.splice(0));
    return { status: res.status, data: await res.json() };
  };
  r = await post('POST', '/api/orders', { ...shopper, promo: 'open10', items: [{ id: sized.id, qty: 1, options: { 戒圍: '11' } }, { id: sized.id, qty: 1, options: { 戒圍: '12' } }] });
  assert.equal(r.status, 201);
  assert.equal(r.data.items.length, 2, 'two sizes are two lines');
  assert.equal(r.data.subtotal, 3000, 'the sale price is what is charged');
  assert.equal(r.data.promoDiscount, 300);
  assert.equal(r.data.shipFee, 0, 'over the free-shipping line after the discount');
  assert.equal(r.data.total, 2700);
  assert.equal(r.data.willEarn, 27);
  let mail = sentMail.pop();
  assert.equal(mail.customer.to, 'new@example.com');
  assert.match(mail.customer.body, /戒圍:11/);
  assert.match(mail.customer.body, /測試銀行 123/);
  assert.match(mail.customer.body, /https:\/\/shop\.example\/cart\.html#lookup/);
  assert.equal((await post('POST', '/api/orders', { ...shopper, promo: 'OPEN10', items: [{ id: sized.id, qty: 2, options: { 戒圍: '10' } }] })).status, 400, 'the code had one use');
  r = await call('GET', '/api/admin/products', null, ADMIN);
  assert.equal(r.data.products.find((p) => p.id === sized.id).stock, 3, 'a refused order leaves stock alone');
  r = await call('GET', '/api/admin/orders', null, ADMIN);
  const promoOrder = r.data.orders[0];
  assert.equal(promoOrder.items[0].options, '戒圍:11');
  sentMail.length = 0;
  await post('PATCH', `/api/admin/orders/${promoOrder.id}`, { status: 'shipped', tracking: 'Z999' }, ADMIN);
  mail = sentMail.pop();
  assert.match(mail.customer.subject, /已出貨/);
  assert.match(mail.customer.body, /Z999/);
  await post('PATCH', `/api/admin/orders/${promoOrder.id}`, { status: 'cancelled' }, ADMIN);
  assert.equal((await call('GET', '/api/admin/promos', null, ADMIN)).data.promos[0].used, 0, 'cancelling frees the code');
  // Customers can be left alone: no customer email once the owner switches them off.
  await call('PUT', '/api/admin/settings', { shop: { bankInfo: '', freeShipOver: 0, customerEmails: false } }, ADMIN);
  sentMail.length = 0;
  await post('POST', '/api/orders', { ...shopper, shipMethod: 'tn', shipTo: '', items: [{ id: sized.id, qty: 1, options: { 戒圍: '10' } }] });
  assert.equal(sentMail.pop().customer, undefined);
  // Booking confirmations go to the email given with the booking.
  await call('PUT', '/api/admin/settings', { shop: { bankInfo: '', freeShipOver: 0, customerEmails: true } }, ADMIN);
  sentMail.length = 0;
  await post('POST', '/api/bookings', { ...person, date: nextDate('tn', 44), time: '13:30', type: 'visit', email: 'guest@example.com' });
  mail = sentMail.pop();
  assert.equal(mail.customer.to, 'guest@example.com');
  assert.match(mail.customer.subject, /預約已確認/);
  globalThis.fetch = realFetch;
  delete env.NOTIFY_URL;

  // One phone can only keep a few unpaid orders waiting.
  for (let i = 0; i < 2; i++) await call('POST', '/api/orders', { ...shopper, shipMethod: 'tn', shipTo: '', items: [{ id: loose.id, qty: 1 }] });
  assert.equal((await call('POST', '/api/orders', { ...shopper, shipMethod: 'tn', shipTo: '', items: [{ id: loose.id, qty: 1 }] })).status, 429);

  // ---- Points that run out ----
  sqlite.prepare("UPDATE points SET created_at = '2020-01-01T00:00:00.000Z' WHERE phone = '0911222333'").run();
  await call('PUT', '/api/admin/settings', { points: { earnPer: 100, pointValue: 1, classPoints: 0, expireMonths: 12 } }, ADMIN);
  r = await call('GET', '/api/admin/customers/0911222333', null, ADMIN);
  assert.equal(r.data.points, 0);
  assert.match(r.data.ledger[0].reason, /積分到期/);

  // ---- Backup ----
  r = await call('GET', '/api/admin/backup', null, ADMIN);
  assert.ok(r.data.tables.orders.length > 3 && r.data.tables.customers.length > 2);
  assert.equal(r.data.tables.staff, undefined, 'sign-in data stays out of the backup');

  console.log('all booking checks passed');
}
