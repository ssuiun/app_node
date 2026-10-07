// Интеграционный тест выдачи исходящих номеров. Нужен PostgreSQL:
//   DATABASE_URL=postgres://... node --test test/outgoing.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { Pool } = require('pg');
const { createOutgoingRouter, initOutgoingSchema, purgeExpiredFiles } = require('../outgoing');

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
  await pool.query('DROP TABLE IF EXISTS out_files, out_letters, out_counters, out_companies, app_storage CASCADE');
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
  assert.equal(list.find((c) => c.id === b.id).next_number, 'ИСХ-42');
  assert.ok(list.find((c) => c.name === 'Ван тай' && c.from_visa), 'компании из виз по умолчанию подтянулись');
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

test('удаление письма: последний номер освобождается, средний — нет', opts, async () => {
  const c = (await call('POST', '/companies', { name: 'Дзета', start_number: 10 })).body;
  const mk = async () => (await call('POST', '/letters', { company_id: c.id, letter_date: '2026-05-01' })).body;
  const [a, b, d] = [await mk(), await mk(), await mk()]; // 10, 11, 12
  assert.equal((await call('DELETE', `/letters/${b.id}`)).body.number_released, false);
  assert.equal((await call('DELETE', `/letters/${d.id}`)).body.number_released, true);
  assert.equal((await mk()).number, '11'); // после удаления 12 счётчик опускается до 10
  assert.equal((await call('DELETE', `/letters/999999`)).status, 404);
  // удалили всё — снова начинаем со стартового номера
  for (const l of (await call('GET', `/letters?company_id=${c.id}`)).body.items) await call('DELETE', `/letters/${l.id}`);
  const co = (await call('GET', '/companies')).body.find((x) => x.id === c.id);
  assert.equal(co.next_number, '10');
  assert.equal(co.last_number, null);
  assert.ok(a);
});

test('файлы: загрузка, скачивание, срок хранения, продление, очистка, архив', opts, async () => {
  const c = (await call('POST', '/companies', { name: 'Эта' })).body;
  const l = (await call('POST', '/letters', { company_id: c.id, letter_date: '2026-06-01' })).body;
  const up = async (name, content) => {
    const r = await fetch(`${base}/letters/${l.id}/files?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: content });
    return { status: r.status, body: await r.json() };
  };
  const f1 = await up('Письмо №1.pdf', Buffer.from('%PDF-test'));
  assert.equal(f1.status, 201);
  assert.ok(f1.body.days_left >= 59 && f1.body.days_left <= 60);
  const f2 = await up('../../evil/name.txt', Buffer.from('hello'));
  assert.equal(f2.body.name.includes('/'), false);

  const dl = await fetch(`${base}/files/${f1.body.id}`);
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
  assert.ok(dl.headers.get('content-disposition').includes(encodeURIComponent('Письмо №1.pdf')));
  assert.equal(Buffer.from(await dl.arrayBuffer()).toString(), '%PDF-test');

  assert.equal((await call('GET', '/letters?company_id=' + c.id)).body.items[0].files_count, 2);
  assert.equal((await call('GET', `/letters/${l.id}/files`)).body.length, 2);
  assert.equal((await call('POST', `/letters/999999/files`, undefined)).status, 400);

  // архив содержит журнал и файл в папке компании
  const z = Buffer.from(await (await fetch(`${base}/archive.zip?company_id=${c.id}`)).arrayBuffer());
  assert.equal(z.slice(0, 2).toString(), 'PK', z.slice(0, 300).toString());
  assert.ok(z.includes(Buffer.from('Журнал.csv')));
  assert.ok(z.includes(Buffer.from('Эта/№ 1/Письмо №1.pdf')));

  // напоминание: файл, до удаления которого осталось 5 дней
  assert.equal((await call('GET', '/stats')).body.expiring, 0);
  await pool.query("UPDATE out_files SET expires_at = NOW() + interval '5 days' WHERE id = $1", [f1.body.id]);
  const st = (await call('GET', '/stats')).body;
  assert.equal(st.expiring, 1);
  assert.equal(st.nearest_days, 5);
  const zExp = Buffer.from(await (await fetch(`${base}/archive.zip?expiring=1`)).arrayBuffer());
  assert.ok(zExp.includes(Buffer.from('Письмо №1.pdf')) && !zExp.includes(Buffer.from('name.txt')));

  // продление
  assert.ok((await call('POST', `/files/${f1.body.id}/extend`)).body.days_left >= 59);
  assert.equal((await call('GET', '/stats')).body.expiring, 0);

  // просроченные файлы удаляются, письмо остаётся
  await pool.query("UPDATE out_files SET expires_at = NOW() - interval '1 day' WHERE id = $1", [f2.body.id]);
  assert.equal(await purgeExpiredFiles(pool), 1);
  assert.equal((await fetch(`${base}/files/${f2.body.id}`)).status, 404);
  assert.equal((await call('GET', '/letters?company_id=' + c.id)).body.total, 1);

  // удаление письма удаляет и его файлы
  await call('DELETE', `/letters/${l.id}`);
  assert.equal((await fetch(`${base}/files/${f1.body.id}`)).status, 404);
});

test('компании подтягиваются из «Визы и договоры» и переименовываются вместе с ними', opts, async () => {
  await pool.query('CREATE TABLE IF NOT EXISTS app_storage (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const put = (arr) => pool.query(
    `INSERT INTO app_storage(key, value) VALUES('vd_db3', $1) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(arr)]);
  await put([{ id: 'v1', name: 'Визовая Тета' }, { id: 'v2', name: 'Альфа' }]); // «Альфа» уже заведена вручную
  let list = (await call('GET', '/companies')).body;
  assert.ok(list.find((x) => x.name === 'Визовая Тета' && x.from_visa));
  assert.equal(list.filter((x) => x.name === 'Альфа').length, 1);
  assert.ok(list.find((x) => x.name === 'Альфа').from_visa);
  await put([{ id: 'v1', name: 'Визовая Тета-2' }, { id: 'v2', name: 'Альфа' }]);
  list = (await call('GET', '/companies')).body;
  assert.ok(list.find((x) => x.name === 'Визовая Тета-2'));
  assert.equal(list.find((x) => x.name === 'Визовая Тета'), undefined);
});
