// Учёт исходящих номеров: компании + реестр исходящих писем в PostgreSQL.
// Номер выдаётся атомарно (одна SQL-транзакция со счётчиком), поэтому два
// сотрудника, нажавшие «Получить номер» одновременно, никогда не получат одинаковый.
const express = require('express');
const { types } = require('pg');

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
CREATE INDEX IF NOT EXISTS out_letters_company_date ON out_letters (company_id, letter_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS out_letters_date ON out_letters (letter_date DESC, id DESC);
`;

async function initOutgoingSchema(pool) {
  await pool.query(SCHEMA);
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
             (SELECT MAX(letter_date) FROM out_letters l WHERE l.company_id = c.id) AS last_date
        FROM out_companies c
        LEFT JOIN out_counters cnt
          ON cnt.company_id = c.id AND cnt.period = CASE WHEN c.reset_yearly THEN $1::int ELSE 0 END
       ORDER BY c.archived, LOWER(c.name)`, [year]);
    return rows.map((c) => {
      const next = c.last_seq > 0 ? c.last_seq + 1 : c.start_number;
      return {
        id: c.id, name: c.name, prefix: c.prefix, start_number: c.start_number,
        reset_yearly: c.reset_yearly, archived: c.archived,
        letters_total: c.letters_total,
        last_date: c.last_date || null,
        last_number: c.last_seq > 0 ? formatNumber(c.prefix, c.last_seq) : null,
        next_number: formatNumber(c.prefix, next)
      };
    });
  }

  router.get('/companies', wrap(async (req, res) => {
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
    SELECT l.*, c.name AS company_name
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
    const head = ['Компания', 'Исх. №', 'Дата', 'Кому', 'Тема', 'Исполнитель', 'Примечание', 'Статус'];
    const lines = [head.map(csvCell).join(';')];
    for (const r of rows) {
      const l = serializeLetter(r, r.company_name);
      lines.push([l.company_name, l.number, l.letter_date, l.recipient, l.subject, l.author, l.note,
        l.status === 'void' ? 'аннулировано' : ''].map(csvCell).join(';'));
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="outgoing-letters.csv"');
    res.send('﻿' + lines.join('\r\n') + '\r\n');
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

  return router;
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
    created_at: r.created_at
  };
}

module.exports = { createOutgoingRouter, initOutgoingSchema, formatNumber };
