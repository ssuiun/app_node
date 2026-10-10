// База «Клиенты»: две таблицы — компании и клиенты (физические лица), клиент может быть привязан к компании.
const express = require('express');
const DEFAULT_VISA_COMPANIES = require('./public/vd-default-companies.js');

const MAX_FILE_MB = Math.max(1, Number(process.env.CL_MAX_FILE_MB) || 25);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cl_companies (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  full_name  TEXT NOT NULL DEFAULT '',
  inn        TEXT NOT NULL DEFAULT '',
  okpo       TEXT NOT NULL DEFAULT '',
  director   TEXT NOT NULL DEFAULT '',
  address    TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  activity   TEXT NOT NULL DEFAULT '',
  info       TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  source_id  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS cl_companies_source ON cl_companies (source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cl_companies_name ON cl_companies (LOWER(name));

CREATE TABLE IF NOT EXISTS cl_clients (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  company_id  INTEGER REFERENCES cl_companies(id) ON DELETE SET NULL,
  position    TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  citizenship TEXT NOT NULL DEFAULT '',
  passport    TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Файлы лежат прямо в PostgreSQL и хранятся без срока (в отличие от исходящих писем).
CREATE TABLE IF NOT EXISTS cl_files (
  id         BIGSERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES cl_companies(id) ON DELETE CASCADE,
  client_id  INTEGER REFERENCES cl_clients(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  data       BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((company_id IS NULL) <> (client_id IS NULL))
);
CREATE INDEX IF NOT EXISTS cl_files_company ON cl_files (company_id);
CREATE INDEX IF NOT EXISTS cl_files_client ON cl_files (client_id);
CREATE INDEX IF NOT EXISTS cl_clients_company ON cl_clients (company_id);
CREATE INDEX IF NOT EXISTS cl_clients_name ON cl_clients (LOWER(name));
`;

async function initClientsSchema(pool) {
  await pool.query(SCHEMA);
}

// Поля, которые можно менять, и максимальная длина каждого.
const COMPANY_FIELDS = { name: 200, full_name: 400, inn: 50, okpo: 50, director: 200, address: 400, phone: 100, email: 200, activity: 400, info: 1000, notes: 2000 };
const CLIENT_FIELDS = { name: 200, position: 200, phone: 100, email: 200, citizenship: 100, passport: 100, notes: 2000 };

const str = (v, max) => String(v ?? '').trim().slice(0, max);

// Имя файла без путей и служебных символов.
function safeName(v) {
  const t = String(v ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 200);
  return t || 'file';
}

function pick(body, fields) {
  const out = {};
  for (const [k, max] of Object.entries(fields)) if (body[k] !== undefined) out[k] = str(body[k], max);
  return out;
}

function likeParam(q) {
  const t = str(q, 100);
  return t ? '%' + t.replace(/[\\%_]/g, (m) => '\\' + m) + '%' : null;
}

function pageParams(q) {
  return {
    limit: Math.min(Math.max(Number.parseInt(q.limit, 10) || 60, 1), 500),
    offset: Math.max(Number.parseInt(q.offset, 10) || 0, 0)
  };
}

function createClientsRouter(pool) {
  const router = express.Router();

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!pool) return res.status(503).json({ error: 'DATABASE_URL не настроен' });
    next();
  });

  const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  });

  // ---------- Компании ----------

  const COMPANY_SELECT = `
    SELECT c.*, (SELECT COUNT(*)::int FROM cl_clients k WHERE k.company_id = c.id) AS clients_count,
           (SELECT COUNT(*)::int FROM cl_files f WHERE f.company_id = c.id) AS files_count
      FROM cl_companies c`;

  router.get('/companies', wrap(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const like = likeParam(req.query.q);
    const vals = [];
    let where = '';
    if (like) {
      vals.push(like);
      where = `WHERE (c.name ILIKE $1 OR c.full_name ILIKE $1 OR c.inn ILIKE $1 OR c.okpo ILIKE $1 OR c.director ILIKE $1
                 OR c.address ILIKE $1 OR c.phone ILIKE $1 OR c.email ILIKE $1 OR c.notes ILIKE $1)`;
    }
    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM cl_companies c ${where}`, vals);
    const { rows } = await pool.query(
      `${COMPANY_SELECT} ${where} ORDER BY LOWER(c.name), c.id LIMIT ${limit} OFFSET ${offset}`, vals);
    res.json({ total: total.rows[0].n, items: rows });
  }));

  // Короткий список для выпадающих списков.
  router.get('/companies/options', wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT id, name FROM cl_companies ORDER BY LOWER(name), id');
    res.json(rows);
  }));

  router.post('/companies', wrap(async (req, res) => {
    const data = pick(req.body || {}, COMPANY_FIELDS);
    if (!data.name) return res.status(400).json({ error: 'Укажите название компании' });
    const cols = Object.keys(data);
    const { rows } = await pool.query(
      `INSERT INTO cl_companies(${cols.join(',')}) VALUES(${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`,
      cols.map((c) => data[c]));
    const r = await pool.query(`${COMPANY_SELECT} WHERE c.id = $1`, [rows[0].id]);
    res.status(201).json(r.rows[0]);
  }));

  router.patch('/companies/:id(\\d+)', wrap(async (req, res) => {
    const data = pick(req.body || {}, COMPANY_FIELDS);
    if (data.name !== undefined && !data.name) return res.status(400).json({ error: 'Название не может быть пустым' });
    const cols = Object.keys(data);
    if (!cols.length) return res.status(400).json({ error: 'Нечего менять' });
    const vals = cols.map((c) => data[c]);
    vals.push(Number(req.params.id));
    const u = await pool.query(
      `UPDATE cl_companies SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = NOW() WHERE id = $${vals.length} RETURNING id`, vals);
    if (!u.rowCount) return res.status(404).json({ error: 'Компания не найдена' });
    const r = await pool.query(`${COMPANY_SELECT} WHERE c.id = $1`, [u.rows[0].id]);
    res.json(r.rows[0]);
  }));

  // Клиенты удаляемой компании остаются в базе, просто без привязки.
  router.delete('/companies/:id(\\d+)', wrap(async (req, res) => {
    const r = await pool.query('DELETE FROM cl_companies WHERE id = $1', [Number(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ error: 'Компания не найдена' });
    res.json({ ok: true });
  }));

  // Разовый импорт компаний из «Визы и договоры» (ключ vd_db3 в app_storage, иначе список по умолчанию).
  // Уже импортированные не трогаем и не перезаписываем.
  router.post('/companies/import-visa', wrap(async (req, res) => {
    let raw = null;
    try {
      const r = await pool.query("SELECT value FROM app_storage WHERE key = 'vd_db3'");
      raw = r.rows[0] ? r.rows[0].value : null;
    } catch (err) {
      if (err.code !== '42P01') throw err;
    }
    let list = DEFAULT_VISA_COMPANIES;
    if (raw) { try { const j = JSON.parse(raw); if (Array.isArray(j)) list = j; } catch (_) { /* битый JSON — по умолчанию */ } }

    let added = 0;
    for (const c of list) {
      const name = str(c && c.name, COMPANY_FIELDS.name);
      const sid = str(c && c.id, 50);
      if (!name || !sid) continue;
      const info = [c.info, c.reg_date && !c.info ? 'зарегистрировано ' + c.reg_date : ''].filter(Boolean).join(' ');
      const r = await pool.query(
        `INSERT INTO cl_companies(name, full_name, inn, okpo, director, address, activity, info, source_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (source_id) WHERE source_id IS NOT NULL DO NOTHING`,
        [name, str(c.full_name, COMPANY_FIELDS.full_name), str(c.inn, 50), str(c.okpo, 50), str(c.director, 200),
          str(c.address, 400), str(c.activity, 400), str(info, 1000), sid]);
      added += r.rowCount;
    }
    res.json({ added, total: list.length });
  }));

  // ---------- Клиенты ----------

  const CLIENT_SELECT = `
    SELECT k.*, c.name AS company_name,
           (SELECT COUNT(*)::int FROM cl_files f WHERE f.client_id = k.id) AS files_count
      FROM cl_clients k LEFT JOIN cl_companies c ON c.id = k.company_id`;

  router.get('/clients', wrap(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const where = [];
    const vals = [];
    if (req.query.company_id === 'none') where.push('k.company_id IS NULL');
    else if (req.query.company_id) { vals.push(Number.parseInt(req.query.company_id, 10) || 0); where.push(`k.company_id = $${vals.length}`); }
    const like = likeParam(req.query.q);
    if (like) {
      vals.push(like);
      const p = `$${vals.length}`;
      where.push(`(k.name ILIKE ${p} OR k.phone ILIKE ${p} OR k.email ILIKE ${p} OR k.position ILIKE ${p}
                   OR k.passport ILIKE ${p} OR k.citizenship ILIKE ${p} OR k.notes ILIKE ${p} OR c.name ILIKE ${p})`);
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = await pool.query(
      `SELECT COUNT(*)::int AS n FROM cl_clients k LEFT JOIN cl_companies c ON c.id = k.company_id ${w}`, vals);
    const { rows } = await pool.query(
      `${CLIENT_SELECT} ${w} ORDER BY LOWER(k.name), k.id LIMIT ${limit} OFFSET ${offset}`, vals);
    res.json({ total: total.rows[0].n, items: rows });
  }));

  // company_id: число — привязать, пусто/null — без компании. Несуществующая компания — 400.
  async function companyIdOf(body) {
    if (body.company_id === undefined) return { skip: true };
    if (body.company_id === null || body.company_id === '') return { value: null };
    const id = Number.parseInt(body.company_id, 10);
    const ok = id >= 1 && (await pool.query('SELECT 1 FROM cl_companies WHERE id = $1', [id])).rowCount > 0;
    return ok ? { value: id } : { error: 'Компания не найдена' };
  }

  router.post('/clients', wrap(async (req, res) => {
    const body = req.body || {};
    const data = pick(body, CLIENT_FIELDS);
    if (!data.name) return res.status(400).json({ error: 'Укажите ФИО клиента' });
    const co = await companyIdOf(body);
    if (co.error) return res.status(400).json({ error: co.error });
    if (!co.skip) data.company_id = co.value;
    const cols = Object.keys(data);
    const { rows } = await pool.query(
      `INSERT INTO cl_clients(${cols.join(',')}) VALUES(${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`,
      cols.map((c) => data[c]));
    const r = await pool.query(`${CLIENT_SELECT} WHERE k.id = $1`, [rows[0].id]);
    res.status(201).json(r.rows[0]);
  }));

  router.patch('/clients/:id(\\d+)', wrap(async (req, res) => {
    const body = req.body || {};
    const data = pick(body, CLIENT_FIELDS);
    if (data.name !== undefined && !data.name) return res.status(400).json({ error: 'ФИО не может быть пустым' });
    const co = await companyIdOf(body);
    if (co.error) return res.status(400).json({ error: co.error });
    if (!co.skip) data.company_id = co.value;
    const cols = Object.keys(data);
    if (!cols.length) return res.status(400).json({ error: 'Нечего менять' });
    const vals = cols.map((c) => data[c]);
    vals.push(Number(req.params.id));
    const u = await pool.query(
      `UPDATE cl_clients SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = NOW() WHERE id = $${vals.length} RETURNING id`, vals);
    if (!u.rowCount) return res.status(404).json({ error: 'Клиент не найден' });
    const r = await pool.query(`${CLIENT_SELECT} WHERE k.id = $1`, [u.rows[0].id]);
    res.json(r.rows[0]);
  }));

  router.delete('/clients/:id(\\d+)', wrap(async (req, res) => {
    const r = await pool.query('DELETE FROM cl_clients WHERE id = $1', [Number(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ error: 'Клиент не найден' });
    res.json({ ok: true });
  }));

  router.get('/stats', wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM cl_companies) AS companies, (SELECT COUNT(*)::int FROM cl_clients) AS clients,
              (SELECT COUNT(*)::int FROM cl_files) AS files, (SELECT COALESCE(SUM(size),0)::bigint FROM cl_files) AS bytes`);
    res.json({ ...rows[0], bytes: Number(rows[0].bytes), max_file_mb: MAX_FILE_MB });
  }));

  // ---------- Файлы (к компаниям и клиентам) ----------

  const FILE_COLS = 'id, name, size, created_at';

  for (const [path, col] of [['companies', 'company_id'], ['clients', 'client_id']]) {
    router.get(`/${path}/:id(\\d+)/files`, wrap(async (req, res) => {
      const { rows } = await pool.query(`SELECT ${FILE_COLS} FROM cl_files WHERE ${col} = $1 ORDER BY id`, [Number(req.params.id)]);
      res.json(rows);
    }));

    // Загрузка: тело запроса = сам файл, имя в ?name=
    router.post(`/${path}/:id(\\d+)/files`,
      express.raw({ type: () => true, limit: MAX_FILE_MB + 'mb' }),
      wrap(async (req, res) => {
        const body = req.body;
        if (!Buffer.isBuffer(body) || !body.length) return res.status(400).json({ error: 'Файл пустой' });
        try {
          const { rows } = await pool.query(
            `INSERT INTO cl_files(${col}, name, size, data) VALUES($1,$2,$3,$4) RETURNING ${FILE_COLS}`,
            [Number(req.params.id), safeName(req.query.name), body.length, body]);
          res.status(201).json(rows[0]);
        } catch (err) {
          if (err.code === '23503') return res.status(404).json({ error: path === 'companies' ? 'Компания не найдена' : 'Клиент не найден' });
          throw err;
        }
      }));
  }

  router.get('/files/:id(\\d+)', wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT name, data FROM cl_files WHERE id = $1', [Number(req.params.id)]);
    if (!rows[0]) return res.status(404).json({ error: 'Файл не найден' });
    res.set('Content-Type', 'application/octet-stream');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(rows[0].name)}`);
    res.send(rows[0].data);
  }));

  router.delete('/files/:id(\\d+)', wrap(async (req, res) => {
    const r = await pool.query('DELETE FROM cl_files WHERE id = $1', [Number(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ error: 'Файл не найден' });
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { createClientsRouter, initClientsSchema };
