// Учёт виз: каждая виза — отдельная строка в PostgreSQL, поэтому записи разных сотрудников
// не затирают друг друга (раньше весь список хранился одним JSON-значением и перезаписывался целиком).
const express = require('express');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS visa_records (
  id         TEXT PRIMARY KEY,
  company    TEXT NOT NULL DEFAULT '',
  fio        TEXT NOT NULL DEFAULT '',
  num        TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT '',
  type       TEXT NOT NULL DEFAULT '',
  submit     TEXT NOT NULL DEFAULT '',
  review     TEXT NOT NULL DEFAULT '',
  exec       TEXT NOT NULL DEFAULT '',
  synced     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS visa_records_created ON visa_records (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS visa_records_submit ON visa_records (submit);
`;

async function initVisasSchema(pool) {
  await pool.query(SCHEMA);
}

const FIELDS = { company: 300, fio: 300, num: 100, status: 100, type: 100, exec: 100 };
const DATE_FIELDS = ['submit', 'review'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const date = (v) => (DATE_RE.test(String(v ?? '').trim()) ? String(v).trim() : '');

function pickFields(body) {
  const out = {};
  for (const [k, max] of Object.entries(FIELDS)) if (body[k] !== undefined) out[k] = str(body[k], max);
  for (const k of DATE_FIELDS) if (body[k] !== undefined) out[k] = date(body[k]);
  if (body.synced !== undefined) out.synced = body.synced === true;
  return out;
}

// У старых записей id вида «v1728562345123» — по нему восстанавливаем время создания, чтобы порядок сохранился.
function createdAtFromId(id, fallbackMs) {
  const m = /^v(\d{12,14})/.exec(String(id));
  const ms = m ? Number(m[1]) : fallbackMs;
  return new Date(Number.isFinite(ms) ? ms : fallbackMs);
}

function newId() {
  return 'v' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
}

const INSERT_SQL = `
  INSERT INTO visa_records(id, company, fio, num, status, type, submit, review, exec, synced, created_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`;

async function insertLegacy(client, list) {
  const base = Date.now();
  let added = 0;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!r || typeof r !== 'object') continue;
    const id = str(r.id, 100) || newId();
    const f = pickFields(r);
    // Исходный список хранился «новые сверху»: чем меньше индекс, тем позже создана запись.
    const created = createdAtFromId(id, base - i);
    const res = await client.query(INSERT_SQL, [id, f.company || '', f.fio || '', f.num || '', f.status || '', f.type || '',
      f.submit || '', f.review || '', f.exec || '', f.synced === true, created]);
    added += res.rowCount;
  }
  return added;
}

// Разовый перенос старого списка из app_storage (ключ vd_visas) в таблицу.
// После переноса исходное значение сохраняется под ключом vd_visas_backup, чтобы не переносить повторно.
async function migrateVisasFromStorage(pool) {
  let raw;
  try {
    const r = await pool.query("SELECT value FROM app_storage WHERE key = 'vd_visas'");
    raw = r.rows[0] ? r.rows[0].value : null;
  } catch (err) {
    if (err.code === '42P01') return 0; // таблицы app_storage ещё нет
    throw err;
  }
  if (raw === null) return 0;
  let list = [];
  try { const j = JSON.parse(raw); if (Array.isArray(j)) list = j; } catch (_) { /* битый JSON: сохраним в бэкап и пойдём дальше */ }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const added = await insertLegacy(client, list);
    await client.query(
      `INSERT INTO app_storage(key, value, updated_at) VALUES('vd_visas_backup', $1, NOW())
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [raw]);
    await client.query("DELETE FROM app_storage WHERE key = 'vd_visas'");
    await client.query('COMMIT');
    if (added) console.log(`Visas: migrated ${added} record(s) from app_storage.`);
    return added;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function createVisasRouter(pool) {
  const router = express.Router();

  router.use((req, res, next) => {
    // no-cache: браузер каждый раз спрашивает сервер, но по ETag получает 304, если список не менялся.
    res.set('Cache-Control', 'no-cache');
    if (!pool) return res.status(503).json({ error: 'DATABASE_URL не настроен' });
    next();
  });

  const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  });

  const COLS = 'id, company, fio, num, status, type, submit, review, exec, synced, created_at';

  router.get('/', wrap(async (req, res) => {
    const { rows } = await pool.query(`SELECT ${COLS} FROM visa_records ORDER BY created_at DESC, id DESC`);
    res.json(rows);
  }));

  router.post('/', wrap(async (req, res) => {
    const f = pickFields(req.body || {});
    if (!f.company || !f.fio) return res.status(400).json({ error: 'Укажите компанию и ФИО' });
    const { rows } = await pool.query(
      `INSERT INTO visa_records(id, company, fio, num, status, type, submit, review, exec, synced)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${COLS}`,
      [newId(), f.company, f.fio, f.num || '', f.status || '', f.type || '', f.submit || '', f.review || '', f.exec || '', f.synced === true]);
    res.status(201).json(rows[0]);
  }));

  router.patch('/:id', wrap(async (req, res) => {
    const f = pickFields(req.body || {});
    if (f.company !== undefined && !f.company) return res.status(400).json({ error: 'Компания не может быть пустой' });
    if (f.fio !== undefined && !f.fio) return res.status(400).json({ error: 'ФИО не может быть пустым' });
    const cols = Object.keys(f);
    if (!cols.length) return res.status(400).json({ error: 'Нечего менять' });
    const vals = cols.map((c) => f[c]);
    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE visa_records SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = NOW()
        WHERE id = $${vals.length} RETURNING ${COLS}`, vals);
    if (!rows[0]) return res.status(404).json({ error: 'Запись не найдена (возможно, её удалили)' });
    res.json(rows[0]);
  }));

  router.delete('/:id', wrap(async (req, res) => {
    const r = await pool.query('DELETE FROM visa_records WHERE id = $1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Запись не найдена' });
    res.json({ ok: true });
  }));

  // Однократный перенос того, что лежало у сотрудника в браузере (записи с уже существующим id не трогаются).
  router.post('/import', wrap(async (req, res) => {
    const list = Array.isArray(req.body && req.body.records) ? req.body.records.slice(0, 20000) : null;
    if (!list) return res.status(400).json({ error: 'Ожидается список records' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const added = await insertLegacy(client, list);
      await client.query('COMMIT');
      res.json({ added, total: list.length });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

  return router;
}

module.exports = { createVisasRouter, initVisasSchema, migrateVisasFromStorage };
