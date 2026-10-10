const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createOutgoingRouter, initOutgoingSchema, purgeExpiredFiles } = require('./outgoing');
const { createClientsRouter, initClientsSchema } = require('./clients');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const ROOT = __dirname;
const MAX_BODY = '2mb';

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30000 })
  : null;

async function initDb() {
  if (!pool) {
    console.warn('DATABASE_URL is not set. Running without PostgreSQL.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_storage (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await initOutgoingSchema(pool);
  await initClientsSchema(pool);
  console.log('PostgreSQL connected, app_storage and outgoing-letters and clients tables are ready.');
}

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(ROOT, 'views'));
app.disable('x-powered-by');

// ---------- /pdf -> Stirling-PDF (separate Railway service) ----------
// Must stay before express.json() so uploaded files are streamed through untouched.
// Stirling-PDF must run with SYSTEM_ROOTURIPATH=/pdf so its links include the prefix.
const STIRLING_URL = process.env.STIRLING_URL;
if (STIRLING_URL) {
  app.use(createProxyMiddleware({
    target: STIRLING_URL,
    pathFilter: '/pdf',
    changeOrigin: true,
    proxyTimeout: 10 * 60 * 1000,
    timeout: 10 * 60 * 1000,
    on: {
      proxyRes(proxyRes) {
        // Allow embedding in our own iframe (same origin) only.
        delete proxyRes.headers['x-frame-options'];
        proxyRes.headers['content-security-policy'] = "frame-ancestors 'self'";
      },
      error(err, req, res) {
        console.error('Stirling-PDF proxy error:', err.message);
        if (res && typeof res.writeHead === 'function' && !res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('PDF-сервис недоступен');
        }
      }
    }
  }));
} else {
  console.warn('STIRLING_URL is not set. /pdf is disabled.');
}

// ---------- Agentation (визуальные комментарии для ИИ-агента) ----------
// Только по явному включению: AGENTATION=1. В обычном продакшене скрипт не подключается.
if (process.env.AGENTATION === '1') {
  const TAG = '<script src="/vendor/agentation.js" defer></script>';
  app.use((req, res, next) => {
    const render = res.render.bind(res);
    res.render = (view, options) => render(view, options, (err, html) => {
      if (err) return next(err);
      res.send(html.replace(/<\/body>/i, TAG + '</body>'));
    });
    next();
  });
  console.log('Agentation toolbar is enabled.');
}

app.use(express.json({ limit: MAX_BODY }));

// Static assets: bsp-theme.css, railway-sync.js, assets/img/*, etc.
app.use(express.static(path.join(ROOT, 'public'), { cacheControl: false }));

app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true });
});

// ---------- /api/storage (Postgres-backed key/value store used by Marginalia) ----------

app.get('/api/storage', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!pool) return res.status(503).json({ error: 'DATABASE_URL is not configured' });

  try {
    const keys = String(req.query.keys || '').split(',').map(s => s.trim()).filter(Boolean);
    const prefixes = String(req.query.prefixes || '').split(',').map(s => s.trim()).filter(Boolean);
    const clauses = [];
    const params = [];
    if (keys.length) {
      params.push(keys);
      clauses.push(`key = ANY($${params.length}::text[])`);
    }
    for (const prefix of prefixes) {
      params.push(prefix + '%');
      clauses.push(`key LIKE $${params.length}`);
    }
    if (!clauses.length) return res.json({});
    const result = await pool.query(`SELECT key, value FROM app_storage WHERE ${clauses.join(' OR ')}`, params);
    const out = {};
    for (const row of result.rows) out[row.key] = row.value;
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/storage', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!pool) return res.status(503).json({ error: 'DATABASE_URL is not configured' });

  try {
    const body = req.body || {};
    if (typeof body.key !== 'string' || body.key.length > 200) return res.status(400).json({ error: 'Invalid key' });
    const value = typeof body.value === 'string' ? body.value : JSON.stringify(body.value ?? '');
    if (Buffer.byteLength(value, 'utf8') > 2 * 1024 * 1024) return res.status(413).json({ error: 'Value too large' });
    await pool.query(`
      INSERT INTO app_storage(key, value, updated_at) VALUES($1, $2, NOW())
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
    `, [body.key, value]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.delete('/api/storage', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!pool) return res.status(503).json({ error: 'DATABASE_URL is not configured' });

  try {
    const body = req.body || {};
    if (body.all === true) {
      await pool.query('TRUNCATE app_storage');
    } else if (typeof body.key === 'string') {
      await pool.query('DELETE FROM app_storage WHERE key=$1', [body.key]);
    } else {
      return res.status(400).json({ error: 'Invalid key' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ---------- /api/outgoing (учёт исходящих номеров) ----------
app.use('/api/outgoing', createOutgoingRouter(pool));

// ---------- /api/clients (база клиентов: компании и клиенты) ----------
app.use('/api/clients', createClientsRouter(pool));

// ---------- Page routes (EJS views, same public URLs as before) ----------

app.get('/', (req, res) => res.render('index'));
app.get('/akt.html', (req, res) => res.render('akt'));
app.get('/visa.html', (req, res) => res.render('visa'));
app.get('/kadr.html', (req, res) => res.render('kadr'));
app.get('/marginalia.html', (req, res) => res.render('marginalia'));
app.get('/outgoing.html', (req, res) => res.render('outgoing'));
app.get('/clients.html', (req, res) => res.render('clients'));

app.use((req, res) => {
  res.status(404).type('text/plain; charset=utf-8').send('Not found');
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error' });
});

function listenOnPort(port) {
  const server = app.listen(port, HOST, () => {
    console.log(`Server listening on http://${HOST}:${port}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < 65535) {
      const nextPort = port + 1;
      console.warn(`Port ${port} is busy, trying ${nextPort} instead...`);
      server.close(() => listenOnPort(nextPort));
      return;
    }

    console.error('Server failed to start:', err);
    process.exit(1);
  });
}

initDb()
  .then(() => {
    if (pool) {
      // Раз в 6 часов удаляем файлы исходящих писем, у которых истёк срок хранения.
      const purge = () => purgeExpiredFiles(pool).catch((err) => console.error('Purge failed:', err.message));
      purge();
      setInterval(purge, 6 * 60 * 60 * 1000).unref();
    }
    listenOnPort(PORT);
  })
  .catch(err => {
    console.error('Database initialization failed:', err);
    process.exit(1);
  });
