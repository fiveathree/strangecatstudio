// Runs the Worker against an in-memory SQLite database standing in for D1.
//   node --experimental-sqlite booking/test.mjs          run the checks
//   node --experimental-sqlite booking/test.mjs serve    serve the API on :8787 for trying the pages locally
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
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
    res.end(await out.text());
  }).listen(8787, () => console.log('booking API on http://localhost:8787 (admin token: test-token)'));
} else {
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
  r = await call('GET', '/api/admin/bookings', null, 'test-token');
  assert.equal(r.data.bookings.length, 2);
  const first = r.data.bookings.find((b) => b.code === code);
  assert.equal(first.status, 'reported');
  assert.equal(first.pay_last5, '12345');
  assert.equal((await call('PATCH', `/api/admin/bookings/${first.id}`, { status: 'cancelled' }, 'test-token')).status, 200);
  r = await call('GET', `/api/slots?studio=tn&from=${tn}&days=1`);
  assert.equal(r.data.days[0].slots.find((s) => s.time === '15:00').left, 2, 'cancelling frees the places');

  // Closing a day.
  assert.equal((await call('POST', '/api/admin/closures', { studio: 'tn', date: tn, reason: '國定假日' }, 'test-token')).status, 200);
  r = await call('GET', `/api/slots?studio=tn&from=${tn}&days=1`);
  assert.equal(r.data.days[0].closed, '國定假日');
  assert.equal((await call('POST', '/api/bookings', { ...person, time: '18:00' })).status, 400);

  console.log('all booking checks passed');
}
