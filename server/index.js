import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { assertRequiredConfig, config, isTeamGated } from './config.js';
import { pool, describeDatabase } from './db.js';
import { runMigrations } from './migrate.js';
import { sessionMiddleware } from './auth.js';
import { syncHub } from './sync.js';
import { api } from './api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

app.use(express.json({ limit: '128kb' }));
app.use(sessionMiddleware);

app.get('/healthz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: 'up', clients: syncHub.clientCount });
  } catch (err) {
    console.error('[health] database check failed:', err.message);
    res.status(503).json({ ok: false, database: 'down' });
  }
});

app.use('/api/mommy', api);

// Anything under /api that did not match is a client error, not the SPA.
app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

app.use(
  express.static(publicDir, {
    setHeaders(res, filePath) {
      // Hashed bundle names are safe to cache hard; index.html must not be.
      if (/\.[0-9a-f]{8,}\.(js|css)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

// Single-page app: every non-API route renders the same shell.
app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

async function main() {
  assertRequiredConfig();
  console.log('[boot] Mommy Care starting');
  console.log(`[boot] timezone=${config.timezone} team_gated=${isTeamGated()}`);
  console.log(`[boot] database=${describeDatabase()}`);

  await runMigrations();
  await syncHub.start();

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`[boot] listening on port ${config.port}`);
  });
  // SSE streams must not be cut off by the default header timeout.
  server.headersTimeout = 0;
  server.requestTimeout = 0;

  const shutdown = (signal) => {
    console.log(`[shutdown] ${signal} received`);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[boot] failed to start:', err.message);
  process.exit(1);
});
