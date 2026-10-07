// Интеграционный тест выдачи исходящих номеров. Нужен PostgreSQL:
//   DATABASE_URL=postgres://... node --test test/outgoing.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { Pool } = require('pg');
const { createOutgoingRouter, initOutgoingSchema } = require('../outgoing');

const url = process.env.DATABASE_URL;
const opts = { skip: url ? false : 'DATABASE_URL is not set' };

let pool, server, base;
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
};

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url, max: 20 });
  await pool.query('DROP TABLE IF EXISTS out_letters, out_counters, out_companies CASCADE');
  await initOutgoingSchema(pool);
  const app = express();
  app.use(express.json());
  app.use('/api/outgoing', createOutgoingRouter(pool));
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}/api/outgoing`;
});

after(async () => {
  if (server) server.close();
  if (pool) await pool.end();
});

test('номера идут по порядку и отдельно для каждой компании', opts, async () => {
  const a = (await call('POST', '/companies', { name: 'Альфа' })).body;
  const b = (await call('POST', '/companies', { name: 'Бета', prefix: 'ИСХ-', start_number: 40 })).body;
  assert.equal(a.next_number, '1');
  assert.equal(b.next_number, 'ИСХ-40');

  const n = async (id) => (await call('POST', '/letters', { company_id: id, letter_date: '2026-03-05' })).body.number;
  assert.deepEqual([await n(a.id), await n(a.id), await n(b.id), await n(a.id), await n(b.id)], ['1', '2', 'ИСХ-40', '3', 'ИСХ-41']);

  const list = (await call('GET', '/companies')).body;
  assert.equal(list.find((c) => c.id === b.id).next_number.length > 0, true);
});

test('параллельные запросы не дают дубликатов', opts, async () => {
  const c = (await call('POST', '/companies', { name: 'Гамма', reset_yearly: false })).body;
  const res = await Promise.all(Array.from({ length: 60 }, () => call('POST', '/letters', { company_id: c.id, letter_date: '2026-01-10' })));
  assert.ok(res.every((r) => r.status === 201));
  const nums = res.map((r) => Number(r.body.number)).sort((x, y) => x - y);
  assert.deepEqual(nums, Array.from({ length: 60 }, (_, i) => i + 1));
});

test('нумерация сбрасывается в новом году, если так настроено', opts, async () => {
  const c = (await call('POST', '/companies', { name: 'Дельта' })).body;
  const mk = async (d) => (await call('POST', '/letters', { company_id: c.id, letter_date: d })).body.number;
  assert.deepEqual([await mk('2025-12-30'), await mk('2025-12-31'), await mk('2026-01-12')], ['1', '2', '1']);
});

test('валидация, аннулирование и поиск', opts, async () => {
  assert.equal((await call('POST', '/companies', { name: 'Альфа' })).status, 409);
  assert.equal((await call('POST', '/companies', { name: ' ' })).status, 400);
  assert.equal((await call('POST', '/letters', { company_id: 99999 })).status, 404);
  const c = (await call('POST', '/companies', { name: 'Эпсилон' })).body;
  assert.equal((await call('POST', '/letters', { company_id: c.id, letter_date: '2026-02-30' })).status, 400);

  const l = (await call('POST', '/letters', { company_id: c.id, letter_date: '2026-04-01', recipient: '100%_Клиент', subject: 'Тест' })).body;
  assert.equal(l.letter_date, '2026-04-01');
  const v = (await call('PATCH', `/letters/${l.id}`, { status: 'void' })).body;
  assert.equal(v.status, 'void');
  // аннулированный номер повторно не выдаётся
  assert.equal((await call('POST', '/letters', { company_id: c.id, letter_date: '2026-04-02' })).body.number, '2');

  assert.equal((await call('GET', '/letters?q=' + encodeURIComponent('100%_'))).body.total, 1);
  assert.equal((await call('GET', '/letters?q=' + encodeURIComponent('%'))).body.total, 1);
  assert.equal((await call('GET', `/letters?company_id=${c.id}&year=2026&status=void`)).body.total, 1);
  assert.equal((await call('GET', `/letters?company_id=${c.id}&year=2025`)).body.total, 0);

  await call('PATCH', `/companies/${c.id}`, { archived: true });
  assert.equal((await call('POST', '/letters', { company_id: c.id })).status, 409);

  const csv = await call('GET', `/letters.csv?company_id=${c.id}`);
  assert.equal(csv.status, 200);
  assert.ok(csv.body.replace(/^\uFEFF/, '').startsWith('Компания;Исх. №;Дата')); // fetch сам отрезает BOM при декодировании
  assert.ok(csv.body.includes('аннулировано'));
});
