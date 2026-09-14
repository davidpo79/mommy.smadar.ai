import express from 'express';
import { config, isTeamGated } from './config.js';
import { pool, query, withTransaction, getRevision } from './db.js';
import {
  clearSessionCookies,
  clientIp,
  requireManager,
  requireRead,
  throttlePublicWrites,
  resetThrottle,
  safeEqual,
  setManagerCookie,
  setTeamCookie,
  throttleAuth,
} from './auth.js';
import { syncHub } from './sync.js';
import { addWeeks, currentDate, currentWeekStart, normalizeWeek, weekDates } from './week.js';
import { serializeCaregiver, serializeChecklistItem, serializeShift } from './serialize.js';
import {
  HttpError,
  asBool,
  asChecklistText,
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

const CHECKLIST_SELECT = `
  SELECT i.*,
         c.name AS created_by_name,
         d.name AS done_by_name
    FROM checklist_items i
    LEFT JOIN caregivers c ON c.id = i.created_by
    LEFT JOIN caregivers d ON d.id = i.done_by
`;

// Open tasks first in the order they were added, then the most recently
// completed - a handover reads top to bottom.
const CHECKLIST_ORDER = `
  ORDER BY i.done, i.position, i.created_at, i.done_at DESC
`;

const SHIFT_SELECT = `
  SELECT s.*, c.name AS caregiver_name, pb.name AS proposed_by_name
    FROM shifts s
    LEFT JOIN caregivers c ON c.id = s.caregiver_id
    LEFT JOIN caregivers pb ON pb.id = s.proposed_by
`;

async function loadState(week, { isManager }) {
  const [revision, caregivers, shifts, checklist] = await Promise.all([
    getRevision(),
    query(
      `SELECT * FROM caregivers WHERE active ORDER BY sort_order, created_at, name`
    ),
    query(`${SHIFT_SELECT} WHERE s.week_start = $1 ORDER BY s.day_of_week, s.start_minute`, [
      week,
    ]),
    query(`${CHECKLIST_SELECT} ${CHECKLIST_ORDER}`),
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
    checklist: checklist.rows.map(serializeChecklistItem),
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

/**
 * Creating a shift is open to anyone who can read the board, so a caregiver can
 * put herself down for a slot. What she creates is a *request*: the server
 * forces it unconfirmed and strips the manager's message field, and only a
 * manager can confirm it. The board already draws unconfirmed shifts striped,
 * so a request reads as pending to everyone until it is approved.
 */
api.post('/shifts', requireRead, throttlePublicWrites, async (req, res, next) => {
  try {
    const input = readShiftBody(req.body);
    if (input.day === undefined) throw bad('invalid_day');
    if (input.start === undefined || input.end === undefined) throw bad('invalid_time');

    if (!req.session.isManager) {
      // A request has to say who it is for - an unassigned pending block would
      // be nobody's to approve.
      if (!input.caregiverId) throw bad('caregiver_required');
      input.confirmed = false;
      input.msg = '';
    }
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
    console.log(
      `[mutation] shift ${req.session.isManager ? 'created' : 'requested'} id=${rows[0].id} week=${input.week}`
    );
    res.status(201).json(serializeShift(created.rows[0]));
  } catch (err) {
    next(err);
  }
});

api.patch('/shifts/:id', requireRead, throttlePublicWrites, async (req, res, next) => {
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

    // Nobody has committed to a pending request yet, so its owner can still
    // edit it outright. An approved shift is a different matter: changing it
    // goes through /proposal so the manager decides.
    if (!req.session.isManager) {
      if (row.confirmed) throw new HttpError(401, 'manager_required');
      const claimed = asUuid(req.body?.as, { nullable: true });
      if (!claimed || claimed !== row.caregiver_id) {
        throw new HttpError(401, 'not_your_request');
      }
      // She may move the hours and change the note, nothing else.
      req.body = {
        ...req.body,
        caregiverId: row.caregiver_id,
        week: undefined,
        day: req.body?.day,
        msg: undefined,
        confirmed: false,
      };
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
    console.log(
      `[mutation] shift ${req.session.isManager ? 'updated' : 'request edited'} id=${id}`
    );
    res.json(serializeShift(updated.rows[0]));
  } catch (err) {
    next(err);
  }
});

/**
 * Managers delete anything. Anyone else may withdraw a request that has not been
 * approved yet, and only their own: `as` names the caregiver withdrawing it, so
 * a mistaken tap cannot cancel somebody else's pending slot. Once a shift is
 * confirmed it is the manager's to remove.
 */
api.delete('/shifts/:id', requireRead, async (req, res, next) => {
  try {
    const id = asUuid(req.params.id);

    if (!req.session.isManager) {
      const existing = await query('SELECT * FROM shifts WHERE id = $1', [id]);
      if (!existing.rows.length) throw new HttpError(404, 'shift_not_found');
      const shift = existing.rows[0];
      if (shift.confirmed) throw new HttpError(401, 'manager_required');
      const claimed = asUuid(req.query.as, { nullable: true });
      if (!claimed || claimed !== shift.caregiver_id) {
        throw new HttpError(401, 'not_your_request');
      }
    }

    const { rowCount } = await query('DELETE FROM shifts WHERE id = $1', [id]);
    if (!rowCount) throw new HttpError(404, 'shift_not_found');
    console.log(
      `[mutation] shift ${req.session.isManager ? 'deleted' : 'request withdrawn'} id=${id}`
    );
    res.json({ deleted: id });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Proposed changes to an approved shift
//
// The live shift is left exactly as approved; the proposal rides alongside it
// until the manager accepts or rejects. That way the board never quietly shows
// hours nobody agreed to.
// ---------------------------------------------------------------------------
async function loadShift(id) {
  const { rows } = await query(`${SHIFT_SELECT} WHERE s.id = $1`, [id]);
  if (!rows.length) throw new HttpError(404, 'shift_not_found');
  return rows[0];
}

api.post('/shifts/:id/proposal', requireRead, throttlePublicWrites, async (req, res, next) => {
  try {
    const id = asUuid(req.params.id);
    const shift = await loadShift(id);

    if (!req.session.isManager) {
      const claimed = asUuid(req.body?.as, { nullable: true });
      if (!claimed || claimed !== shift.caregiver_id) {
        throw new HttpError(401, 'not_your_shift');
      }
    }
    // An unapproved shift needs no ceremony - its owner edits it directly.
    if (!shift.confirmed) throw bad('edit_directly');

    const kind = req.body?.kind;
    if (kind !== 'change' && kind !== 'cancel') throw bad('invalid_proposal_kind');

    const start = kind === 'change' ? asMinute(req.body?.start, 'start') : null;
    const end = kind === 'change' ? asMinute(req.body?.end, 'end') : null;
    const note =
      req.body?.note === undefined || req.body?.note === null
        ? null
        : asText(req.body.note);

    const proposedBy = req.session.isManager
      ? asUuid(req.body?.as, { nullable: true })
      : asUuid(req.body.as);

    await query(
      `UPDATE shifts
          SET proposal_kind = $2, proposed_start_minute = $3, proposed_end_minute = $4,
              proposed_note = $5, proposed_by = $6, proposed_at = now()
        WHERE id = $1`,
      [id, kind, start, end, note, proposedBy]
    );
    console.log(`[mutation] ${kind} proposed for shift id=${id}`);
    res.status(201).json(serializeShift(await loadShift(id)));
  } catch (err) {
    next(err);
  }
});

const CLEAR_PROPOSAL = `
  proposal_kind = NULL, proposed_start_minute = NULL, proposed_end_minute = NULL,
  proposed_note = NULL, proposed_by = NULL, proposed_at = NULL
`;

/** The manager rejects a proposal; the caregiver withdraws her own. */
api.delete('/shifts/:id/proposal', requireRead, async (req, res, next) => {
  try {
    const id = asUuid(req.params.id);
    const shift = await loadShift(id);
    if (!shift.proposal_kind) throw new HttpError(404, 'no_proposal');

    if (!req.session.isManager) {
      const claimed = asUuid(req.query.as, { nullable: true });
      if (!claimed || claimed !== shift.proposed_by) {
        throw new HttpError(401, 'not_your_proposal');
      }
    }

    await query(`UPDATE shifts SET ${CLEAR_PROPOSAL} WHERE id = $1`, [id]);
    console.log(
      `[mutation] proposal ${req.session.isManager ? 'rejected' : 'withdrawn'} shift=${id}`
    );
    res.json(serializeShift(await loadShift(id)));
  } catch (err) {
    next(err);
  }
});

/** Manager accepts: a change is applied to the shift, a cancellation removes it. */
api.post('/shifts/:id/proposal/accept', requireManager, async (req, res, next) => {
  try {
    const id = asUuid(req.params.id);
    const shift = await loadShift(id);
    if (!shift.proposal_kind) throw new HttpError(404, 'no_proposal');

    if (shift.proposal_kind === 'cancel') {
      await query('DELETE FROM shifts WHERE id = $1', [id]);
      console.log(`[mutation] cancellation accepted, shift deleted id=${id}`);
      return res.json({ accepted: 'cancel', deleted: id });
    }

    await query(
      `UPDATE shifts
          SET start_minute = $2,
              end_minute = $3,
              note = COALESCE($4, note),
              ${CLEAR_PROPOSAL}
        WHERE id = $1`,
      [id, shift.proposed_start_minute, shift.proposed_end_minute, shift.proposed_note]
    );
    console.log(`[mutation] change accepted for shift id=${id}`);
    res.json({ accepted: 'change', shift: serializeShift(await loadShift(id)) });
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
// Shared checklist
//
// Adding a task and ticking one off are open to anyone who can read the board,
// so a caregiver on shift does not need the manager code to hand work over.
// Editing the wording and removing items stay manager-only: additive changes
// from an anonymous writer are recoverable, destructive ones are not.
// ---------------------------------------------------------------------------
const MAX_CHECKLIST_ITEMS = 300;

async function loadChecklistItem(id) {
  const { rows } = await query(`${CHECKLIST_SELECT} WHERE i.id = $1`, [id]);
  if (!rows.length) throw new HttpError(404, 'item_not_found');
  return rows[0];
}

api.get('/checklist', requireRead, async (_req, res, next) => {
  try {
    const { rows } = await query(`${CHECKLIST_SELECT} ${CHECKLIST_ORDER}`);
    res.json({ checklist: rows.map(serializeChecklistItem) });
  } catch (err) {
    next(err);
  }
});

api.post('/checklist', requireRead, throttlePublicWrites, async (req, res, next) => {
  try {
    const text = asChecklistText(req.body?.text);
    const caregiverId = asUuid(req.body?.caregiverId, { nullable: true });
    await assertCaregiverExists(caregiverId);

    const { rows: counted } = await query('SELECT COUNT(*)::int AS n FROM checklist_items');
    if (counted[0].n >= MAX_CHECKLIST_ITEMS) {
      throw new HttpError(409, 'checklist_full');
    }

    const { rows } = await query(
      `INSERT INTO checklist_items (body, created_by, position)
       VALUES ($1, $2, COALESCE((SELECT MAX(position) + 1 FROM checklist_items), 0))
       RETURNING id`,
      [text, caregiverId]
    );
    console.log(`[mutation] checklist item created id=${rows[0].id}`);
    res.status(201).json(serializeChecklistItem(await loadChecklistItem(rows[0].id)));
  } catch (err) {
    next(err);
  }
});

api.patch('/checklist/:id', requireRead, throttlePublicWrites, async (req, res, next) => {
  try {
    const id = asUuid(req.params.id);
    const expectedVersion = asVersion(req.body?.version);
    const row = await loadChecklistItem(id);

    if (expectedVersion !== null && expectedVersion !== row.version) {
      return res
        .status(409)
        .json({ error: 'stale_version', current: serializeChecklistItem(row) });
    }

    // Rewording an existing task is a manager action; ticking it is not.
    if (req.body?.text !== undefined && !req.session.isManager) {
      throw new HttpError(401, 'manager_required');
    }

    const text = req.body?.text === undefined ? row.body : asChecklistText(req.body.text);
    const done = asBool(req.body?.done, row.done);
    const caregiverId = asUuid(req.body?.caregiverId, { nullable: true });
    if (caregiverId) await assertCaregiverExists(caregiverId);

    // Who ticked it and when are recorded on the transition, and cleared when
    // an item is reopened so the card never shows a stale signature.
    const doneBy = done ? (row.done ? row.done_by : caregiverId) : null;
    const doneAt = done ? (row.done ? row.done_at : new Date()) : null;

    await query(
      `UPDATE checklist_items
          SET body = $2, done = $3, done_by = $4, done_at = $5
        WHERE id = $1`,
      [id, text, done, doneBy, doneAt]
    );
    console.log(`[mutation] checklist item ${done ? 'checked' : 'unchecked'} id=${id}`);
    res.json(serializeChecklistItem(await loadChecklistItem(id)));
  } catch (err) {
    next(err);
  }
});

api.delete('/checklist/:id', requireManager, async (req, res, next) => {
  try {
    const id = asUuid(req.params.id);
    const { rowCount } = await query('DELETE FROM checklist_items WHERE id = $1', [id]);
    if (!rowCount) throw new HttpError(404, 'item_not_found');
    console.log(`[mutation] checklist item deleted id=${id}`);
    res.json({ deleted: id });
  } catch (err) {
    next(err);
  }
});

api.post('/checklist/clear-done', requireManager, async (_req, res, next) => {
  try {
    const { rowCount } = await query('DELETE FROM checklist_items WHERE done');
    console.log(`[mutation] cleared ${rowCount} completed checklist item(s)`);
    res.json({ cleared: rowCount });
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
