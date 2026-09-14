import express from 'express';
import { config, isTeamGated } from './config.js';
import { pool, query, withTransaction, getRevision } from './db.js';
import {
  clearSessionCookies,
  clientIp,
  requireManager,
  requireRead,
  resetThrottle,
  safeEqual,
  setManagerCookie,
  setTeamCookie,
  throttleAuth,
} from './auth.js';
import { syncHub } from './sync.js';
import { addWeeks, currentDate, currentWeekStart, normalizeWeek, weekDates } from './week.js';
import { serializeCaregiver, serializeShift } from './serialize.js';
import {
  HttpError,
  asBool,
  asDay,
  asMinute,
  asName,
  asRate,
  asText,
  asUuid,
  asVersion,
  bad,
} from './validate.js';

export const api = express.Router();

const SHIFT_SELECT = `
  SELECT s.*, c.name AS caregiver_name
    FROM shifts s
    LEFT JOIN caregivers c ON c.id = s.caregiver_id
`;

async function loadState(week, { isManager }) {
  const [revision, caregivers, shifts] = await Promise.all([
    getRevision(),
    query(
      `SELECT * FROM caregivers WHERE active ORDER BY sort_order, created_at, name`
    ),
    query(`${SHIFT_SELECT} WHERE s.week_start = $1 ORDER BY s.day_of_week, s.start_minute`, [
      week,
    ]),
  ]);

  const current = currentWeekStart();
  return {
    revision,
    timezone: config.timezone,
    serverTime: new Date().toISOString(),
    // Today in APP_TIMEZONE, so the client never has to trust the device clock
    // to decide which day to open on.
    today: currentDate(),
    isManager,
    teamGated: isTeamGated(),
    week,
    weeks: {
      current,
      next: addWeeks(current, 1),
      previous: addWeeks(week, -1),
      requestedNext: addWeeks(week, 1),
    },
    dates: weekDates(week),
    caregivers: caregivers.rows.map((row) => serializeCaregiver(row, { isManager })),
    shifts: shifts.rows.map(serializeShift),
  };
}

function resolveWeek(value) {
  if (value === undefined || value === null || value === '') return currentWeekStart();
  const week = normalizeWeek(value);
  if (!week) throw bad('invalid_week', 'Week must be the YYYY-MM-DD date of a Sunday.');
  return week;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
api.get('/auth/session', (req, res) => {
  res.json({
    isManager: req.session.isManager,
    canRead: req.session.canRead,
    teamGated: isTeamGated(),
  });
});

api.post('/auth/manager', throttleAuth, (req, res) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (!code || !safeEqual(code, config.managerSecret)) {
    console.warn(`[auth] manager login failed ip=${clientIp(req)}`);
    return res.status(401).json({ error: 'invalid_code' });
  }
  resetThrottle(req);
  setManagerCookie(req, res);
  console.log(`[auth] manager login ok ip=${clientIp(req)}`);
  return res.json({ isManager: true });
});

api.post('/auth/team', throttleAuth, (req, res) => {
  if (!isTeamGated()) return res.json({ canRead: true, teamGated: false });
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (!code || !safeEqual(code, config.teamAccessCode)) {
    console.warn(`[auth] team login failed ip=${clientIp(req)}`);
    return res.status(401).json({ error: 'invalid_code' });
  }
  resetThrottle(req);
  setTeamCookie(req, res);
  return res.json({ canRead: true, teamGated: true });
});

api.post('/auth/logout', (req, res) => {
  clearSessionCookies(req, res);
  res.json({ isManager: false });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
api.get('/state', requireRead, async (req, res, next) => {
  try {
    const week = resolveWeek(req.query.week);
    res.json(await loadState(week, { isManager: req.session.isManager }));
  } catch (err) {
    next(err);
  }
});

api.get('/weeks/:week', requireRead, async (req, res, next) => {
  try {
    const week = resolveWeek(req.params.week);
    res.json(await loadState(week, { isManager: req.session.isManager }));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Caregivers (manager only)
// ---------------------------------------------------------------------------
api.post('/caregivers', requireManager, async (req, res, next) => {
  try {
    const name = asName(req.body?.name);
    const paid = asBool(req.body?.paid, true);
    const rate = asRate(req.body?.rate, paid ? 50 : 0);
    const { rows } = await query(
      `INSERT INTO caregivers (name, paid, hourly_rate, sort_order)
       VALUES ($1, $2, $3, COALESCE((SELECT MAX(sort_order) + 1 FROM caregivers), 0))
       RETURNING *`,
      [name, paid, paid ? rate : 0]
    );
    console.log(`[mutation] caregiver created id=${rows[0].id}`);
    res.status(201).json(serializeCaregiver(rows[0], { isManager: true }));
  } catch (err) {
    next(err);
  }
});

api.patch('/caregivers/:id', requireManager, async (req, res, next) => {
  try {
    const id = asUuid(req.params.id);
    const expectedVersion = asVersion(req.body?.version);

    const existing = await query('SELECT * FROM caregivers WHERE id = $1', [id]);
    if (!existing.rows.length) throw new HttpError(404, 'caregiver_not_found');
    const row = existing.rows[0];

    if (expectedVersion !== null && expectedVersion !== row.version) {
      return res.status(409).json({
        error: 'stale_version',
        current: serializeCaregiver(row, { isManager: true }),
      });
    }

    const name = asName(req.body?.name, { required: false }) ?? row.name;
    const paid = asBool(req.body?.paid, row.paid);
    const active = asBool(req.body?.active, row.active);
    const rate = paid ? asRate(req.body?.rate, Number(row.hourly_rate) || 50) : 0;

    const { rows } = await query(
      `UPDATE caregivers
          SET name = $2, paid = $3, hourly_rate = $4, active = $5
        WHERE id = $1
        RETURNING *`,
      [id, name, paid, rate, active]
    );
    console.log(`[mutation] caregiver updated id=${id}`);
    res.json(serializeCaregiver(rows[0], { isManager: true }));
  } catch (err) {
    next(err);
  }
});

/**
 * Deleting a caregiver who already appears in the schedule would silently
 * orphan shifts, so that case deactivates instead: history stays intact and
 * the caregiver disappears from the roster. Unused caregivers are removed.
 */
api.delete('/caregivers/:id', requireManager, async (req, res, next) => {
  try {
    const id = asUuid(req.params.id);
    const result = await withTransaction(async (client) => {
      const existing = await client.query('SELECT * FROM caregivers WHERE id = $1', [id]);
      if (!existing.rows.length) throw new HttpError(404, 'caregiver_not_found');

      const used = await client.query(
        'SELECT 1 FROM shifts WHERE caregiver_id = $1 LIMIT 1',
        [id]
      );
      if (used.rows.length) {
        const { rows } = await client.query(
          'UPDATE caregivers SET active = false WHERE id = $1 RETURNING *',
          [id]
        );
        return { mode: 'deactivated', caregiver: rows[0] };
      }
      await client.query('DELETE FROM caregivers WHERE id = $1', [id]);
      return { mode: 'deleted', caregiver: existing.rows[0] };
    });

    console.log(`[mutation] caregiver ${result.mode} id=${id}`);
    res.json({
      mode: result.mode,
      caregiver: serializeCaregiver(result.caregiver, { isManager: true }),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Shifts (manager only)
// ---------------------------------------------------------------------------
function readShiftBody(body, base = {}) {
  const week = resolveWeek(body?.week ?? base.week_start);
  return {
    week,
    day: body?.day === undefined ? base.day_of_week : asDay(body.day),
    start: body?.start === undefined ? base.start_minute : asMinute(body.start, 'start'),
    end: body?.end === undefined ? base.end_minute : asMinute(body.end, 'end'),
    caregiverId:
      body?.caregiverId === undefined
        ? base.caregiver_id ?? null
        : asUuid(body.caregiverId, { nullable: true }),
    note: asText(body?.note, base.note ?? ''),
    msg: asText(body?.msg, base.message ?? ''),
    confirmed: asBool(body?.confirmed, base.confirmed ?? false),
  };
}

async function assertCaregiverExists(caregiverId) {
  if (!caregiverId) return;
  const { rows } = await query('SELECT 1 FROM caregivers WHERE id = $1', [caregiverId]);
  if (!rows.length) throw new HttpError(404, 'caregiver_not_found');
}

api.post('/shifts', requireManager, async (req, res, next) => {
  try {
    const input = readShiftBody(req.body);
    if (input.day === undefined) throw bad('invalid_day');
    if (input.start === undefined || input.end === undefined) throw bad('invalid_time');
    await assertCaregiverExists(input.caregiverId);

    const { rows } = await query(
      `INSERT INTO shifts
         (caregiver_id, week_start, day_of_week, start_minute, end_minute, note, message, confirmed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        input.caregiverId,
        input.week,
        input.day,
        input.start,
        input.end,
        input.note,
        input.msg,
        input.confirmed,
      ]
    );
    const created = await query(`${SHIFT_SELECT} WHERE s.id = $1`, [rows[0].id]);
    console.log(`[mutation] shift created id=${rows[0].id} week=${input.week}`);
    res.status(201).json(serializeShift(created.rows[0]));
  } catch (err) {
    next(err);
  }
});

api.patch('/shifts/:id', requireManager, async (req, res, next) => {
  try {
    const id = asUuid(req.params.id);
    const expectedVersion = asVersion(req.body?.version);

    const existing = await query(`${SHIFT_SELECT} WHERE s.id = $1`, [id]);
    if (!existing.rows.length) throw new HttpError(404, 'shift_not_found');
    const row = existing.rows[0];

    if (expectedVersion !== null && expectedVersion !== row.version) {
      return res
        .status(409)
        .json({ error: 'stale_version', current: serializeShift(row) });
    }

    const input = readShiftBody(req.body, row);
    await assertCaregiverExists(input.caregiverId);

    await query(
      `UPDATE shifts
          SET caregiver_id = $2, week_start = $3, day_of_week = $4,
              start_minute = $5, end_minute = $6, note = $7, message = $8, confirmed = $9
        WHERE id = $1`,
      [
        id,
        input.caregiverId,
        input.week,
        input.day,
        input.start,
        input.end,
        input.note,
        input.msg,
        input.confirmed,
      ]
    );
    const updated = await query(`${SHIFT_SELECT} WHERE s.id = $1`, [id]);
    console.log(`[mutation] shift updated id=${id}`);
    res.json(serializeShift(updated.rows[0]));
  } catch (err) {
    next(err);
  }
});

api.delete('/shifts/:id', requireManager, async (req, res, next) => {
  try {
    const id = asUuid(req.params.id);
    const { rowCount } = await query('DELETE FROM shifts WHERE id = $1', [id]);
    if (!rowCount) throw new HttpError(404, 'shift_not_found');
    console.log(`[mutation] shift deleted id=${id}`);
    res.json({ deleted: id });
  } catch (err) {
    next(err);
  }
});

/**
 * Replaces the target week with a copy of the week before it. Runs in one
 * transaction so other devices never observe a half-copied week.
 */
api.post('/weeks/:week/copy-previous', requireManager, async (req, res, next) => {
  try {
    const week = resolveWeek(req.params.week);
    const source = addWeeks(week, -1);

    const copied = await withTransaction(async (client) => {
      const src = await client.query(
        'SELECT COUNT(*)::int AS n FROM shifts WHERE week_start = $1',
        [source]
      );
      if (src.rows[0].n === 0) return 0;

      await client.query('DELETE FROM shifts WHERE week_start = $1', [week]);
      const { rowCount } = await client.query(
        `INSERT INTO shifts
           (caregiver_id, week_start, day_of_week, start_minute, end_minute, note, message, confirmed)
         SELECT caregiver_id, $2::date, day_of_week, start_minute, end_minute, note, message, false
           FROM shifts
          WHERE week_start = $1`,
        [source, week]
      );
      return rowCount;
    });

    console.log(`[mutation] copied ${copied} shift(s) ${source} -> ${week}`);
    const state = await loadState(week, { isManager: true });
    res.json({ copied, source, ...state });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Realtime synchronization
// ---------------------------------------------------------------------------
api.get('/events', requireRead, async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  syncHub.addClient(res);
  req.on('close', () => syncHub.removeClient(res));
});

api.get('/revision', requireRead, async (_req, res, next) => {
  try {
    res.json({ revision: await getRevision() });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
api.use((err, req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.code, details: err.details });
  }
  // Unique violation - the dedupe index caught a repeated/duplicated shift.
  if (err.code === '23505') {
    return res.status(409).json({ error: 'duplicate', details: err.constraint });
  }
  if (err.code === '23514') {
    return res.status(400).json({ error: 'constraint_violation', details: err.constraint });
  }
  if (err.code === '23503') {
    return res.status(400).json({ error: 'foreign_key_violation', details: err.constraint });
  }
  console.error(`[api] ${req.method} ${req.originalUrl} failed:`, err.message);
  return res.status(500).json({ error: 'internal_error' });
});

export { pool };
