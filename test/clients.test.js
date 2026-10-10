// Интеграционный тест базы «Клиенты». Нужен PostgreSQL:
//   DATABASE_URL=postgres://... node --test test/clients.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { Pool } = require('pg');
const { createClientsRouter, initClientsSchema } = require('../clients');

const url = process.env.DATABASE_URL;
const opts = { skip: url ? false : 'DATABASE_URL is not set' };
let pool, server, base;
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await pool.query('DROP TABLE IF EXISTS cl_files, cl_clients, cl_companies, app_storage CASCADE');
  await initClientsSchema(pool);
  const app = express();
  app.use(express.json());
  app.use('/api', createClientsRouter(pool));
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { if (server) server.close(); if (pool) await pool.end(); });

test('компании: создание, правка, поиск, валидация', opts, async () => {
  assert.equal((await call('POST', '/companies', { name: '  ' })).status, 400);
  const c = (await call('POST', '/companies', { name: 'Ромашка', inn: '123', director: 'Иванов', address: 'Бишкек' })).body;
  assert.equal(c.clients_count, 0);
  const u = (await call('PATCH', `/companies/${c.id}`, { phone: '+996 555', name: 'Ромашка ОсОО' })).body;
  assert.equal(u.phone, '+996 555');
  assert.equal((await call('PATCH', `/companies/${c.id}`, { name: '' })).status, 400);
  assert.equal((await call('PATCH', `/companies/${c.id}`, {})).status, 400);
  assert.equal((await call('PATCH', '/companies/99999', { name: 'x' })).status, 404);
  assert.equal((await call('GET', '/companies?q=' + encodeURIComponent('иванов'))).body.total, 1);
  assert.equal((await call('GET', '/companies?q=' + encodeURIComponent('100%'))).body.total, 0);
});

test('клиенты: привязка к компании, фильтры, удаление компании не удаляет клиента', opts, async () => {
  const c = (await call('POST', '/companies', { name: 'Тюльпан' })).body;
  assert.equal((await call('POST', '/clients', { name: '' })).status, 400);
  assert.equal((await call('POST', '/clients', { name: 'Без компании' })).body.company_id, null);
  assert.equal((await call('POST', '/clients', { name: 'X', company_id: 99999 })).status, 400);
  const k = (await call('POST', '/clients', { name: 'Петров Пётр', company_id: c.id, phone: '555', passport: 'AN123' })).body;
  assert.equal(k.company_name, 'Тюльпан');
  assert.equal((await call('GET', '/clients?company_id=' + c.id)).body.total, 1);
  assert.equal((await call('GET', '/clients?company_id=none')).body.items.every((x) => x.company_id === null), true);
  assert.equal((await call('GET', '/clients?q=an123')).body.total, 1);
  assert.equal((await call('GET', '/clients?q=' + encodeURIComponent('тюльпан'))).body.total, 1); // поиск по названию компании
  assert.equal((await call('GET', '/companies?q=Тюльпан')).body.items[0].clients_count, 1);

  assert.equal((await call('PATCH', `/clients/${k.id}`, { company_id: null })).body.company_id, null);
  await call('PATCH', `/clients/${k.id}`, { company_id: c.id });
  assert.equal((await call('DELETE', `/companies/${c.id}`)).status, 200);
  const after = (await call('GET', '/clients?q=Петров')).body.items[0];
  assert.equal(after.company_id, null);
  assert.equal((await call('DELETE', `/clients/${k.id}`)).status, 200);
  assert.equal((await call('DELETE', `/clients/${k.id}`)).status, 404);
});

test('импорт из «Визы и договоры» не дублирует и не затирает правки', opts, async () => {
  const r1 = (await call('POST', '/companies/import-visa')).body;
  assert.ok(r1.added >= 20 && r1.added === r1.total);
  const van = (await call('GET', '/companies?q=' + encodeURIComponent('Ван тай'))).body.items[0];
  assert.ok(van.inn || van.address);
  await call('PATCH', `/companies/${van.id}`, { notes: 'моя заметка' });
  assert.equal((await call('POST', '/companies/import-visa')).body.added, 0);
  assert.equal((await call('GET', '/companies?q=' + encodeURIComponent('Ван тай'))).body.items[0].notes, 'моя заметка');

  // если в визах сохранили свой список — берём его
  await pool.query('CREATE TABLE IF NOT EXISTS app_storage (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  await pool.query("INSERT INTO app_storage(key, value) VALUES('vd_db3', $1)", [JSON.stringify([{ id: 'zz1', name: 'Новая из виз', inn: '777' }])]);
  assert.equal((await call('POST', '/companies/import-visa')).body.added, 1);
  assert.deepEqual((await call('GET', '/stats')).body.companies > 20, true);
});

test('файлы к компаниям и клиентам: загрузка, скачивание, удаление, каскад', opts, async () => {
  const c = (await call('POST', '/companies', { name: 'Файловая' })).body;
  const k = (await call('POST', '/clients', { name: 'Файлов Файл', company_id: c.id })).body;
  const up = async (path, id, name, content) => {
    const r = await fetch(`${base}/${path}/${id}/files?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: content });
    return { status: r.status, body: await r.json() };
  };
  const f1 = await up('companies', c.id, 'Устав ОсОО.pdf', Buffer.from('%PDF-устав'));
  assert.equal(f1.status, 201);
  const f2 = await up('clients', k.id, '../../паспорт.jpg', Buffer.from('jpegdata'));
  assert.equal(f2.status, 201);
  assert.equal(f2.body.name.includes('/'), false);
  assert.equal((await up('companies', c.id, 'пусто', Buffer.alloc(0))).status, 400);
  assert.equal((await up('companies', 99999, 'x', Buffer.from('x'))).status, 404);
  assert.equal((await up('clients', 99999, 'x', Buffer.from('x'))).status, 404);

  assert.equal((await call('GET', '/companies?q=Файловая')).body.items[0].files_count, 1);
  assert.equal((await call('GET', '/clients?q=Файлов')).body.items[0].files_count, 1);
  assert.equal((await call('GET', `/companies/${c.id}/files`)).body.length, 1);
  assert.ok((await call('GET', `/clients/${k.id}/files`)).body[0].name.endsWith('паспорт.jpg'));

  const dl = await fetch(`${base}/files/${f1.body.id}`);
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
  assert.ok(dl.headers.get('content-disposition').includes(encodeURIComponent('Устав ОсОО.pdf')));
  assert.equal(Buffer.from(await dl.arrayBuffer()).toString(), '%PDF-устав');
  assert.equal((await call('GET', '/stats')).body.files >= 2, true);

  assert.equal((await call('DELETE', `/files/${f2.body.id}`)).status, 200);
  assert.equal((await call('DELETE', `/files/${f2.body.id}`)).status, 404);

  // удаление компании удаляет её файлы, но не клиента
  await call('DELETE', `/companies/${c.id}`);
  assert.equal((await fetch(`${base}/files/${f1.body.id}`)).status, 404);
  assert.equal((await call('GET', '/clients?q=Файлов')).body.total, 1);
  // удаление клиента удаляет его файлы
  const f3 = await up('clients', k.id, 'a.txt', Buffer.from('a'));
  await call('DELETE', `/clients/${k.id}`);
  assert.equal((await fetch(`${base}/files/${f3.body.id}`)).status, 404);
});
