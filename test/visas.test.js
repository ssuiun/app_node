// Интеграционный тест учёта виз. Нужен PostgreSQL:
//   DATABASE_URL=postgres://... node --test test/visas.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { Pool } = require('pg');
const { createVisasRouter, initVisasSchema, migrateVisasFromStorage } = require('../visas');

const url = process.env.DATABASE_URL;
const opts = { skip: url ? false : 'DATABASE_URL is not set' };
let pool, server, base;
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json(), headers: r.headers };
};

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url, max: 20 });
  await pool.query('DROP TABLE IF EXISTS visa_records, app_storage CASCADE');
  await pool.query('CREATE TABLE app_storage (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  await initVisasSchema(pool);
  const app = express();
  app.use(express.json());
  app.use('/api/visas', createVisasRouter(pool));
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}/api/visas`;
});
after(async () => { if (server) server.close(); if (pool) await pool.end(); });

test('старый список из app_storage переносится один раз, порядок сохраняется', opts, async () => {
  const old = [
    { id: 'v1700000003000', company: 'Три', fio: 'C', num: '3', status: 'Новая заявка', type: 'Бизнес виза', submit: '2026-10-03', review: '2026-10-05', exec: 'Адиля', synced: true },
    { id: 'v1700000002000', company: 'Два', fio: 'B', num: '2', status: 'Одобрена', type: 'Рабочая виза', submit: '2026-10-02', review: '', exec: 'Алтын', synced: false },
    { id: 'v1700000001000', company: 'Один', fio: 'A', num: '1', status: 'Новая заявка', type: 'Продление', submit: 'мусор', review: '', exec: 'Суйунбек' }
  ];
  await pool.query("INSERT INTO app_storage(key, value) VALUES('vd_visas', $1)", [JSON.stringify(old)]);
  assert.equal(await migrateVisasFromStorage(pool), 3);
  const list = (await call('GET', '/')).body;
  assert.deepEqual(list.map((r) => r.company), ['Три', 'Два', 'Один']); // новые сверху, как раньше
  assert.equal(list[0].synced, true);
  assert.equal(list[2].submit, '');                                     // некорректная дата очищена
  // повторный запуск (рестарт сервера) ничего не делает и не воскрешает удалённое
  await call('DELETE', '/v1700000002000');
  assert.equal(await migrateVisasFromStorage(pool), 0);
  assert.equal((await call('GET', '/')).body.length, 2);
  const bk = await pool.query("SELECT 1 FROM app_storage WHERE key = 'vd_visas_backup'");
  assert.equal(bk.rowCount, 1);
});

test('создание, правка, удаление и валидация', opts, async () => {
  assert.equal((await call('POST', '/', { company: '', fio: 'X' })).status, 400);
  const v = (await call('POST', '/', { company: 'ОсОО Тест', fio: 'ZHENG', num: 'ER1', status: 'Новая заявка', type: 'Бизнес виза', submit: '2026-10-10', review: '2026-10-12', exec: 'Адиля' })).body;
  assert.ok(v.id && v.synced === false);
  assert.equal((await call('PATCH', `/${v.id}`, { status: 'Одобрена', synced: true })).body.status, 'Одобрена');
  assert.equal((await call('PATCH', `/${v.id}`, { fio: '' })).status, 400);
  assert.equal((await call('PATCH', `/${v.id}`, {})).status, 400);
  assert.equal((await call('PATCH', '/nope', { fio: 'x' })).status, 404);
  assert.equal((await call('DELETE', `/${v.id}`)).status, 200);
  assert.equal((await call('DELETE', `/${v.id}`)).status, 404);
});

test('одновременные записи разных сотрудников не затирают друг друга', opts, async () => {
  const before = (await call('GET', '/')).body.length;
  const execs = ['Суйунбек', 'Адиля', 'Алтын'];
  const res = await Promise.all(Array.from({ length: 30 }, (_, i) =>
    call('POST', '/', { company: 'Гонка', fio: 'P' + i, exec: execs[i % 3], submit: '2026-10-10' })));
  assert.ok(res.every((r) => r.status === 201));
  const list = (await call('GET', '/')).body;
  assert.equal(list.length, before + 30);
  assert.equal(new Set(list.map((r) => r.id)).size, list.length);
});

test('GET отдаёт ETag: без изменений — 304 (так же делает браузер)', opts, async () => {
  const http = require('node:http');
  // встроенный fetch Node сам добавляет Cache-Control: no-cache к условным запросам, браузер — нет; шлём «как браузер»
  const get = (headers) => new Promise((resolve, reject) => {
    http.get(base + '/', { headers }, (res) => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject);
  });
  const r1 = await get({});
  const etag = r1.headers.etag;
  assert.ok(etag);
  assert.equal(r1.headers['cache-control'], 'no-cache');
  assert.equal((await get({ 'If-None-Match': etag })).statusCode, 304);
  await call('POST', '/', { company: 'Новая', fio: 'N' });
  assert.equal((await get({ 'If-None-Match': etag })).statusCode, 200);
});

test('import из браузера: дубли по id пропускаются', opts, async () => {
  const recs = [{ id: 'vimp-1', company: 'Имп', fio: 'I1' }, { id: 'vimp-2', company: 'Имп', fio: 'I2' }];
  assert.equal((await call('POST', '/import', { records: recs })).body.added, 2);
  assert.equal((await call('POST', '/import', { records: recs })).body.added, 0);
  assert.equal((await call('POST', '/import', { nope: 1 })).status, 400);
});
