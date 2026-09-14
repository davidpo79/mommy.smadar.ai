import pg from 'pg';
import { config } from './config.js';
import { getRevision } from './db.js';

const { Client } = pg;
const CHANNEL = 'mommy_changes';

/**
 * Fan-out hub for schedule changes.
 *
 * A dedicated PostgreSQL connection LISTENs on `mommy_changes`; the database
 * triggers NOTIFY on every caregiver/shift mutation. Every connected browser
 * holds an SSE stream and refetches when the revision it sees moves forward.
 * This keeps PostgreSQL the single source of truth and works even if more than
 * one instance of the service is running.
 */
class SyncHub {
  constructor() {
    this.clients = new Set();
    this.revision = 0;
    this.listener = null;
    this.reconnectDelay = 1000;
  }

  async start() {
    this.revision = await getRevision();
    await this.connectListener();
  }

  async connectListener() {
    const needsSsl = /sslmode=require|sslmode=verify/.test(config.databaseUrl);
    const client = new Client({
      connectionString: config.databaseUrl,
      ssl: needsSsl ? { rejectUnauthorized: false } : false,
    });

    client.on('notification', (msg) => {
      try {
        const payload = JSON.parse(msg.payload);
        this.publish(Number(payload.revision), payload);
      } catch (err) {
        console.error('[sync] bad notification payload', err.message);
      }
    });

    client.on('error', (err) => {
      console.error('[sync] listener error', err.message);
      this.scheduleReconnect(client);
    });

    client.on('end', () => this.scheduleReconnect(client));

    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    this.listener = client;
    this.reconnectDelay = 1000;
    // Notifications sent while the listener was down are lost, so re-read the
    // counter and push it if it moved.
    this.publish(await getRevision(), { entity: null, op: 'resync' });
    console.log('[sync] listening for database changes');
  }

  scheduleReconnect(deadClient) {
    if (this.listener !== deadClient && this.listener !== null) return;
    this.listener = null;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, 30_000);
    setTimeout(() => {
      this.connectListener().catch((err) =>
        console.error('[sync] reconnect failed', err.message)
      );
    }, delay).unref();
  }

  publish(revision, detail = {}) {
    // Compared for inequality rather than growth: if the database is ever
    // restored from a backup its revision moves backwards, and clients still
    // need to be told that what they are holding no longer matches.
    if (!Number.isFinite(revision) || revision === this.revision) return;
    this.revision = revision;
    const frame = `event: change\ndata: ${JSON.stringify({
      revision,
      entity: detail.entity || null,
      op: detail.op || null,
    })}\n\n`;
    for (const res of this.clients) {
      res.write(frame);
    }
  }

  addClient(res) {
    this.clients.add(res);
    res.write(`event: hello\ndata: ${JSON.stringify({ revision: this.revision })}\n\n`);
  }

  removeClient(res) {
    this.clients.delete(res);
  }

  get clientCount() {
    return this.clients.size;
  }
}

export const syncHub = new SyncHub();

// Heartbeat keeps proxies and load balancers from closing idle SSE streams.
setInterval(() => {
  for (const res of syncHub.clients) res.write(': ping\n\n');
}, 25_000).unref();
