// Учёт исходящих номеров: компании + реестр исходящих писем в PostgreSQL.
// Номер выдаётся атомарно (одна SQL-транзакция со счётчиком), поэтому два
// сотрудника, нажавшие «Получить номер» одновременно, никогда не получат одинаковый.
const express = require('express');
const { ZipArchive } = require('archiver');
const { types } = require('pg');
const DEFAULT_VISA_COMPANIES = require('./public/vd-default-companies.js');

// Хранение файлов: по умолчанию 60 дней (~2 месяца), напоминание за 14 дней до удаления.
const RETENTION_DAYS = Math.max(1, Number(process.env.OUT_FILE_RETENTION_DAYS) || 60);
const WARN_DAYS = Math.max(1, Number(process.env.OUT_FILE_WARN_DAYS) || 14);
const MAX_FILE_MB = Math.max(1, Number(process.env.OUT_MAX_FILE_MB) || 25);

// DATE -> строка 'YYYY-MM-DD' (без сдвигов часовых поясов).
types.setTypeParser(1082, (v) => v);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS out_companies (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  prefix        TEXT NOT NULL DEFAULT '',
  start_number  INTEGER NOT NULL DEFAULT 1 CHECK (start_number >= 1),
  reset_yearly  BOOLEAN NOT NULL DEFAULT TRUE,
  archived      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Счётчик: период = год письма (или 0, если нумерация сквозная).
CREATE TABLE IF NOT EXISTS out_counters (
  company_id INTEGER NOT NULL REFERENCES out_companies(id) ON DELETE CASCADE,
  period     INTEGER NOT NULL,
  last_seq   INTEGER NOT NULL,
  PRIMARY KEY (company_id, period)
);

CREATE TABLE IF NOT EXISTS out_letters (
  id          BIGSERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES out_companies(id) ON DELETE RESTRICT,
  period      INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  number      TEXT NOT NULL,
  letter_date DATE NOT NULL,
  recipient   TEXT NOT NULL DEFAULT '',
  subject     TEXT NOT NULL DEFAULT '',
  author      TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, period, seq)
);
ALTER TABLE out_companies ADD COLUMN IF NOT EXISTS source_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS out_companies_source ON out_companies (source_id) WHERE source_id IS NOT NULL;

-- Файлы писем лежат прямо в PostgreSQL (не нужен отдельный диск на Railway).
CREATE TABLE IF NOT EXISTS out_files (
  id         BIGSERIAL PRIMARY KEY,
  letter_id  BIGINT NOT NULL REFERENCES out_letters(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  data       BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS out_files_letter ON out_files (letter_id);
CREATE INDEX IF NOT EXISTS out_files_expires ON out_files (expires_at);
CREATE INDEX IF NOT EXISTS out_letters_company_date ON out_letters (company_id, letter_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS out_letters_date ON out_letters (letter_date DESC, id DESC);
`;

async function initOutgoingSchema(pool) {
  await pool.query(SCHEMA);
}

// Список компаний берётся из раздела «Визы и договоры» (ключ vd_db3 в app_storage);
// пока там ничего не сохраняли — из списка по умолчанию. Название обновляется, если его поменяли в визах.
let lastSyncedRaw; // undefined = ещё ни разу не синхронизировали
async function syncVisaCompanies(pool) {
  let raw = null;
  try {
    const r = await pool.query("SELECT value FROM app_storage WHERE key = 'vd_db3'");
    raw = r.rows[0] ? r.rows[0].value : null;
  } catch (err) {
    if (err.code !== '42P01') throw err; // нет таблицы app_storage — берём список по умолчанию
  }
  if (raw === lastSyncedRaw) return;
  let list = DEFAULT_VISA_COMPANIES;
  if (raw) {
    try { const j = JSON.parse(raw); if (Array.isArray(j)) list = j; } catch (_) { /* битый JSON — по умолчанию */ }
  }
  for (const c of list) {
    const name = str(c && c.name, 200);
    const sid = str(c && c.id, 50);
    if (!name || !sid) continue;
    const bySource = await pool.query('SELECT id, name FROM out_companies WHERE source_id = $1', [sid]);
    if (bySource.rows[0]) {
      if (bySource.rows[0].name !== name) {
        await pool.query('UPDATE out_companies SET name = $1 WHERE id = $2', [name, bySource.rows[0].id])
          .catch((e) => { if (e.code !== '23505') throw e; });
      }
      continue;
    }
    // Такая компания уже заведена вручную — привязываем к визам, а не дублируем.
    const adopted = await pool.query(
      'UPDATE out_companies SET source_id = $1 WHERE name = $2 AND source_id IS NULL RETURNING id', [sid, name]);
    if (adopted.rowCount) continue;
    await pool.query('INSERT INTO out_companies(name, source_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [name, sid]);
  }
  lastSyncedRaw = raw;
}

// Удаляет файлы, у которых истёк срок хранения. Письма в журнале остаются.
async function purgeExpiredFiles(pool) {
  const r = await pool.query('DELETE FROM out_files WHERE expires_at < NOW()');
  if (r.rowCount) console.log(`Outgoing: deleted ${r.rowCount} expired file(s).`);
  return r.rowCount;
}

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function periodFor(company, dateISO) {
  return company.reset_yearly ? Number(dateISO.slice(0, 4)) : 0;
}

function formatNumber(prefix, seq) {
  return `${prefix || ''}${seq}`;
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function createOutgoingRouter(pool) {
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

  // Список компаний + последний выданный номер (за текущий период) + что будет следующим.
  async function companiesWithState() {
    const year = new Date().getUTCFullYear();
    const { rows } = await pool.query(`
      SELECT c.*,
             COALESCE(cnt.last_seq, 0) AS last_seq,
             (SELECT COUNT(*)::int FROM out_letters l WHERE l.company_id = c.id) AS letters_total,
             (SELECT MAX(letter_date) FROM out_letters l WHERE l.company_id = c.id) AS last_date,
             (SELECT COUNT(*)::int FROM out_files f JOIN out_letters l ON l.id = f.letter_id WHERE l.company_id = c.id) AS files_total
        FROM out_companies c
        LEFT JOIN out_counters cnt
          ON cnt.company_id = c.id AND cnt.period = CASE WHEN c.reset_yearly THEN $1::int ELSE 0 END
       ORDER BY c.archived, LOWER(c.name)`, [year]);
    return rows.map((c) => {
      const next = c.last_seq > 0 ? c.last_seq + 1 : c.start_number;
      return {
        id: c.id, name: c.name, prefix: c.prefix, start_number: c.start_number,
        reset_yearly: c.reset_yearly, archived: c.archived,
        letters_total: c.letters_total, files_total: c.files_total, from_visa: c.source_id !== null,
        last_date: c.last_date || null,
        last_number: c.last_seq > 0 ? formatNumber(c.prefix, c.last_seq) : null,
        next_number: formatNumber(c.prefix, next)
      };
    });
  }

  router.get('/companies', wrap(async (req, res) => {
    await syncVisaCompanies(pool);
    res.json(await companiesWithState());
  }));

  router.post('/companies', wrap(async (req, res) => {
    const b = req.body || {};
    const name = str(b.name, 200);
    if (!name) return res.status(400).json({ error: 'Укажите название компании' });
    const start = Number.parseInt(b.start_number, 10);
    if (b.start_number !== undefined && b.start_number !== '' && !(start >= 1 && start < 1e9)) {
      return res.status(400).json({ error: 'Начальный номер должен быть целым числом от 1' });
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO out_companies(name, prefix, start_number, reset_yearly)
         VALUES($1,$2,$3,$4) RETURNING id`,
        [name, str(b.prefix, 20), start >= 1 ? start : 1, b.reset_yearly !== false]);
      const all = await companiesWithState();
      res.status(201).json(all.find((c) => c.id === rows[0].id));
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'Компания с таким названием уже есть' });
      throw err;
    }
  }));

  router.patch('/companies/:id(\\d+)', wrap(async (req, res) => {
    const b = req.body || {};
    const sets = [];
    const vals = [];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.name !== undefined) {
      const name = str(b.name, 200);
      if (!name) return res.status(400).json({ error: 'Название не может быть пустым' });
      add('name', name);
    }
    if (b.reset_yearly !== undefined) {
      const used = await pool.query('SELECT 1 FROM out_letters WHERE company_id = $1 LIMIT 1', [Number(req.params.id)]);
      if (used.rowCount) return res.status(409).json({ error: 'Режим нумерации нельзя менять, когда уже есть письма' });
      add('reset_yearly', !!b.reset_yearly);
    }
    if (b.prefix !== undefined) add('prefix', str(b.prefix, 20));
    if (b.archived !== undefined) add('archived', !!b.archived);
    if (b.start_number !== undefined) {
      const n = Number.parseInt(b.start_number, 10);
      if (!(n >= 1 && n < 1e9)) return res.status(400).json({ error: 'Начальный номер должен быть целым числом от 1' });
      add('start_number', n);
    }
    if (!sets.length) return res.status(400).json({ error: 'Нечего менять' });
    vals.push(Number(req.params.id));
    try {
      const r = await pool.query(`UPDATE out_companies SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
      if (!r.rowCount) return res.status(404).json({ error: 'Компания не найдена' });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'Компания с таким названием уже есть' });
      throw err;
    }
    const all = await companiesWithState();
    res.json(all.find((c) => c.id === Number(req.params.id)));
  }));

  // ---------- Письма ----------

  // Выдать следующий номер и сразу записать письмо в реестр.
  router.post('/letters', wrap(async (req, res) => {
    const b = req.body || {};
    const companyId = Number.parseInt(b.company_id, 10);
    if (!(companyId >= 1)) return res.status(400).json({ error: 'Выберите компанию' });
    const letterDate = b.letter_date ? String(b.letter_date) : todayISO();
    if (!validDate(letterDate)) return res.status(400).json({ error: 'Некорректная дата' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Блокируем строку компании: выдача номеров для одной компании идёт строго по очереди.
      const cr = await client.query('SELECT * FROM out_companies WHERE id = $1 FOR UPDATE', [companyId]);
      const company = cr.rows[0];
      if (!company) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Компания не найдена' }); }
      if (company.archived) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Компания в архиве' }); }

      const period = periodFor(company, letterDate);
      const upd = await client.query(
        `INSERT INTO out_counters(company_id, period, last_seq) VALUES($1,$2,$3)
         ON CONFLICT (company_id, period) DO UPDATE SET last_seq = out_counters.last_seq + 1
         RETURNING last_seq`,
        [companyId, period, company.start_number]);
      const seq = upd.rows[0].last_seq;
      const number = formatNumber(company.prefix, seq);

      const ins = await client.query(
        `INSERT INTO out_letters(company_id, period, seq, number, letter_date, recipient, subject, author, note)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [companyId, period, seq, number, letterDate,
          str(b.recipient, 300), str(b.subject, 1000), str(b.author, 200), str(b.note, 2000)]);
      await client.query('COMMIT');
      res.status(201).json(serializeLetter(ins.rows[0], company.name));
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

  function buildLetterFilter(q) {
    const where = [];
    const vals = [];
    const add = (sql, v) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };
    if (q.company_id) add('l.company_id = ?', Number.parseInt(q.company_id, 10) || 0);
    if (q.status === 'active' || q.status === 'void') add('l.status = ?', q.status);
    if (q.year && /^\d{4}$/.test(String(q.year))) {
      vals.push(Number(q.year));
      where.push(`l.letter_date >= make_date($${vals.length}::int, 1, 1) AND l.letter_date < make_date($${vals.length}::int + 1, 1, 1)`);
    }
    const text = str(q.q, 100);
    if (text) {
      const like = '%' + text.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
      vals.push(like);
      const p = `$${vals.length}`;
      where.push(`(l.number ILIKE ${p} OR l.recipient ILIKE ${p} OR l.subject ILIKE ${p} OR l.author ILIKE ${p} OR l.note ILIKE ${p} OR c.name ILIKE ${p})`);
    }
    return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', vals };
  }

  const LETTER_SELECT = `
    SELECT l.*, c.name AS company_name,
           (SELECT COUNT(*)::int FROM out_files f WHERE f.letter_id = l.id) AS files_count,
           (SELECT MIN(expires_at) FROM out_files f WHERE f.letter_id = l.id) AS files_expire_at
      FROM out_letters l JOIN out_companies c ON c.id = l.company_id`;

  router.get('/letters', wrap(async (req, res) => {
    const f = buildLetterFilter(req.query);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const total = await pool.query(
      `SELECT COUNT(*)::int AS n FROM out_letters l JOIN out_companies c ON c.id = l.company_id ${f.sql}`, f.vals);
    const { rows } = await pool.query(
      `${LETTER_SELECT} ${f.sql} ORDER BY l.letter_date DESC, l.id DESC LIMIT ${limit} OFFSET ${offset}`, f.vals);
    res.json({ total: total.rows[0].n, items: rows.map((r) => serializeLetter(r, r.company_name)) });
  }));

  // Экспорт в CSV (открывается в Excel: разделитель «;», UTF-8 с BOM).
  router.get('/letters.csv', wrap(async (req, res) => {
    const f = buildLetterFilter(req.query);
    const { rows } = await pool.query(
      `${LETTER_SELECT} ${f.sql} ORDER BY c.name, l.letter_date, l.id`, f.vals);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="outgoing-letters.csv"');
    res.send(lettersCsv(rows));
  }));

  // Правка реквизитов письма / аннулирование. Номер и дата не меняются, чтобы нумерация не «плыла».
  // Аннулированный номер остаётся в реестре (виден в журнале), заново он не выдаётся.
  router.patch('/letters/:id(\\d+)', wrap(async (req, res) => {
    const b = req.body || {};
    const sets = ['updated_at = NOW()'];
    const vals = [];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.recipient !== undefined) add('recipient', str(b.recipient, 300));
    if (b.subject !== undefined) add('subject', str(b.subject, 1000));
    if (b.author !== undefined) add('author', str(b.author, 200));
    if (b.note !== undefined) add('note', str(b.note, 2000));
    if (b.status !== undefined) {
      if (b.status !== 'active' && b.status !== 'void') return res.status(400).json({ error: 'Некорректный статус' });
      add('status', b.status);
    }
    vals.push(Number(req.params.id));
    const r = await pool.query(`UPDATE out_letters SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id`, vals);
    if (!r.rowCount) return res.status(404).json({ error: 'Письмо не найдено' });
    const { rows } = await pool.query(`${LETTER_SELECT} WHERE l.id = $1`, [r.rows[0].id]);
    res.json(serializeLetter(rows[0], rows[0].company_name));
  }));

  // Удаление письма вместе с файлами. Если это самый последний номер счётчика — номер снова свободен.
  router.delete('/letters/:id(\\d+)', wrap(async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const del = await client.query(
        'DELETE FROM out_letters WHERE id = $1 RETURNING company_id, period, seq', [Number(req.params.id)]);
      if (!del.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Письмо не найдено' }); }
      const { company_id, period, seq } = del.rows[0];
      // Счётчик опускается до самого большого оставшегося номера периода (или сбрасывается, если писем не осталось).
      const mx = await client.query(
        'SELECT MAX(seq) AS m FROM out_letters WHERE company_id = $1 AND period = $2', [company_id, period]);
      let released = false;
      if (mx.rows[0].m === null) {
        released = (await client.query('DELETE FROM out_counters WHERE company_id = $1 AND period = $2', [company_id, period])).rowCount > 0
          && seq >= 1;
      } else {
        released = (await client.query(
          'UPDATE out_counters SET last_seq = $3 WHERE company_id = $1 AND period = $2 AND last_seq > $3',
          [company_id, period, mx.rows[0].m])).rowCount > 0;
      }
      await client.query('COMMIT');
      res.json({ ok: true, number_released: released });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

  // ---------- Файлы ----------

  const serializeFile = (f) => ({
    id: Number(f.id), letter_id: Number(f.letter_id), name: f.name, size: f.size,
    created_at: f.created_at, expires_at: f.expires_at,
    days_left: Math.ceil((new Date(f.expires_at) - Date.now()) / 86400000)
  });

  router.get('/letters/:id(\\d+)/files', wrap(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT id, letter_id, name, size, created_at, expires_at FROM out_files WHERE letter_id = $1 ORDER BY id', [Number(req.params.id)]);
    res.json(rows.map(serializeFile));
  }));

  // Загрузка: тело запроса = сам файл, имя в ?name=
  router.post('/letters/:id(\\d+)/files',
    express.raw({ type: () => true, limit: MAX_FILE_MB + 'mb' }),
    wrap(async (req, res) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || !body.length) return res.status(400).json({ error: 'Файл пустой' });
      const name = safeName(req.query.name, 'file');
      try {
        const { rows } = await pool.query(
          `INSERT INTO out_files(letter_id, name, size, data, expires_at)
           VALUES($1,$2,$3,$4, NOW() + make_interval(days => $5::int))
           RETURNING id, letter_id, name, size, created_at, expires_at`,
          [Number(req.params.id), name, body.length, body, RETENTION_DAYS]);
        res.status(201).json(serializeFile(rows[0]));
      } catch (err) {
        if (err.code === '23503') return res.status(404).json({ error: 'Письмо не найдено' });
        throw err;
      }
    }));

  router.get('/files/:id(\\d+)', wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT name, data FROM out_files WHERE id = $1', [Number(req.params.id)]);
    if (!rows[0]) return res.status(404).json({ error: 'Файл не найден (возможно, срок хранения истёк)' });
    res.set('Content-Type', 'application/octet-stream');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(rows[0].name)}`);
    res.send(rows[0].data);
  }));

  router.delete('/files/:id(\\d+)', wrap(async (req, res) => {
    const r = await pool.query('DELETE FROM out_files WHERE id = $1', [Number(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ error: 'Файл не найден' });
    res.json({ ok: true });
  }));

  // Продлить срок хранения ещё на полный период.
  router.post('/files/:id(\\d+)/extend', wrap(async (req, res) => {
    const r = await pool.query(
      `UPDATE out_files SET expires_at = NOW() + make_interval(days => $2::int) WHERE id = $1
       RETURNING id, letter_id, name, size, created_at, expires_at`, [Number(req.params.id), RETENTION_DAYS]);
    if (!r.rowCount) return res.status(404).json({ error: 'Файл не найден' });
    res.json(serializeFile(r.rows[0]));
  }));

  router.post('/files/extend-expiring', wrap(async (req, res) => {
    const r = await pool.query(
      `UPDATE out_files SET expires_at = NOW() + make_interval(days => $1::int)
        WHERE expires_at < NOW() + make_interval(days => $2::int)`, [RETENTION_DAYS, WARN_DAYS]);
    res.json({ extended: r.rowCount });
  }));

  // Сводка для напоминания: сколько файлов скоро удалятся.
  router.get('/stats', wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS files, COALESCE(SUM(size),0)::bigint AS bytes,
              COUNT(*) FILTER (WHERE expires_at < NOW() + make_interval(days => $1::int))::int AS expiring,
              MIN(expires_at) AS nearest
         FROM out_files`, [WARN_DAYS]);
    const r = rows[0];
    res.json({
      files: r.files, bytes: Number(r.bytes), expiring: r.expiring,
      nearest_days: r.nearest ? Math.max(0, Math.ceil((new Date(r.nearest) - Date.now()) / 86400000)) : null,
      retention_days: RETENTION_DAYS, warn_days: WARN_DAYS, max_file_mb: MAX_FILE_MB
    });
  }));

  // Архив: журнал (Журнал.csv) + все файлы по папкам «Компания / № письма».
  // Фильтры те же, что у журнала (company_id, year, status, q); expiring=1 — только файлы, которые скоро удалятся.
  router.get('/archive.zip', wrap(async (req, res) => {
    const f = buildLetterFilter(req.query);
    const expiring = req.query.expiring === '1';
    const cond = expiring ? `f.expires_at < NOW() + make_interval(days => ${WARN_DAYS})` : '';
    const where = (extra) => (extra ? (f.sql ? f.sql + ' AND ' + extra : 'WHERE ' + extra) : f.sql);

    const letters = await pool.query(
      `${LETTER_SELECT} ${where(expiring ? `EXISTS (SELECT 1 FROM out_files f WHERE f.letter_id = l.id AND ${cond})` : '')}
        ORDER BY c.name, l.letter_date, l.id`, f.vals);
    const files = await pool.query(
      `SELECT f.id, f.name, l.number, c.name AS company
         FROM out_files f JOIN out_letters l ON l.id = f.letter_id JOIN out_companies c ON c.id = l.company_id
         ${where(cond)} ORDER BY c.name, l.letter_date, l.id, f.id`, f.vals);

    const stamp = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('исходящие-' + stamp + '.zip')}`);
    const zip = new ZipArchive({ zlib: { level: 6 } });
    zip.on('error', (err) => { console.error(err); res.destroy(err); });
    res.on('close', () => { if (!res.writableFinished) zip.abort(); });
    zip.pipe(res);

    zip.append(lettersCsv(letters.rows), { name: 'Журнал.csv' });
    const used = new Set();
    for (const file of files.rows) {
      const data = await pool.query('SELECT data FROM out_files WHERE id = $1', [file.id]);
      if (!data.rows[0]) continue; // удалён, пока строился архив
      let name = `${safeName(file.company, 'компания')}/${safeName('№ ' + file.number, 'письмо')}/${safeName(file.name, 'file')}`;
      if (used.has(name)) name = name.replace(/([^/]*)$/, `${file.id}_$1`);
      used.add(name);
      // ждём, пока запись уйдёт в поток, чтобы не копить все файлы в памяти
      await new Promise((resolve) => { zip.once('entry', resolve); zip.append(data.rows[0].data, { name }); });
    }
    await zip.finalize();
  }));

  return router;
}

function lettersCsv(rows) {
  const head = ['Компания', 'Исх. №', 'Дата', 'Кому', 'Тема', 'Файлов', 'Статус'];
  const lines = [head.map(csvCell).join(';')];
  for (const r of rows) {
    const l = serializeLetter(r, r.company_name);
    lines.push([l.company_name, l.number, l.letter_date, l.recipient, l.subject, l.files_count,
      l.status === 'void' ? 'аннулировано' : ''].map(csvCell).join(';'));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

// Имя файла/папки, безопасное для zip и ОС.
function safeName(v, fallback) {
  const t = String(v ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 120);
  return t || fallback;
}

function serializeLetter(r, companyName) {
  return {
    id: Number(r.id),
    company_id: r.company_id,
    company_name: companyName,
    number: r.number,
    seq: r.seq,
    letter_date: r.letter_date,
    recipient: r.recipient,
    subject: r.subject,
    author: r.author,
    note: r.note,
    status: r.status,
    created_at: r.created_at,
    files_count: r.files_count || 0,
    files_expire_at: r.files_expire_at || null
  };
}

module.exports = { createOutgoingRouter, initOutgoingSchema, purgeExpiredFiles, syncVisaCompanies, formatNumber };
