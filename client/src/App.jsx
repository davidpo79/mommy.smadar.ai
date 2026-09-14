import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { css } from './css.js';
import { api, ApiError } from './api.js';
import { useSync } from './useSync.js';
import { hourHeightFor, useViewport } from './useViewport.js';

const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const HOUR_PX = 34;
const ACCENT = 'oklch(0.52 0.08 232)';
const WEEK_MINUTES = 7 * 24 * 60;
// Which caregiver is using this device. A per-viewer convenience, never a
// source of truth - the schedule and the checklist live in PostgreSQL.
const ME_KEY = 'mommy:me';
// One-tap shorthands for the things caregivers most often take on. They fill
// the field rather than submitting, so anything can still be edited first.
const CONTRIBUTIONS = [
  'מביאה אוכל',
  'אוספת תרופות',
  'קניות',
  'כביסה',
  'הסעה לבדיקות',
  'ליווי לרופא',
];

function hhmm(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function shiftLen(s) {
  return s.end > s.start ? s.end - s.start : s.end + 1440 - s.start;
}

function hoursLabel(min) {
  return `${(Math.round((min / 60) * 10) / 10).toString().replace('.0', '')} ש׳`;
}

function formatStamp(iso, timeZone) {
  try {
    return new Intl.DateTimeFormat('he-IL', {
      timeZone,
      day: 'numeric',
      month: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return '';
  }
}

function dayLabel(isoDate) {
  if (!isoDate) return '';
  const [, month, day] = isoDate.split('-');
  return `${Number(day)}.${Number(month)}`;
}

function roleBtn(on) {
  return (
    'border:none;border-radius:999px;padding:7px 14px;font-size:13.5px;cursor:pointer;font-family:Heebo, sans-serif;' +
    (on
      ? 'background:#fdfcfa;color:#26221e;box-shadow:0 1px 3px rgba(38,34,30,.12);'
      : 'background:transparent;color:#7b7266;')
  );
}

function tabStyle(on) {
  return (
    'border:none;border-radius:999px;padding:8px 16px;font-size:14px;cursor:pointer;font-family:Heebo, sans-serif;' +
    (on
      ? 'background:#fdfcfa;color:#26221e;box-shadow:0 1px 3px rgba(38,34,30,.12);'
      : 'background:transparent;color:#7b7266;')
  );
}

const CHIP = 'border-radius:999px;padding:7px 13px;font-size:14px;cursor:pointer;font-family:Heebo, sans-serif;';

const NEUTRAL_TONE = { bg: '#f1ece4', border: '#cfc6b8', strong: '#8a8073' };

function toneAt(index) {
  if (index < 0) return NEUTRAL_TONE;
  const hue = (36 + index * 61) % 360;
  return {
    bg: `oklch(0.945 0.04 ${hue})`,
    border: `oklch(0.76 0.08 ${hue})`,
    strong: `oklch(0.6 0.09 ${hue})`,
  };
}

const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => ({
  value: i * 30,
  label: hhmm(i * 30),
}));


/**
 * Narrow-screen schedule. The 7x24 wall grid is unusable on a phone, so the
 * week becomes a day picker plus the selected day's shifts as cards, keeping
 * the same colours, pills and confirmation styling as the desktop board.
 * Uncovered stretches are listed explicitly, since spotting a gap by eye is
 * exactly what the grid was doing for you on a large screen.
 */
/**
 * The week board: seven day columns over a 24-hour track, shared by both
 * layouts. `compact` shrinks every dimension so the whole week and the whole
 * day fit a phone screen at once - the narrow layout deliberately keeps the
 * full grid rather than paging through days, so gaps stay visible at a glance.
 * `hourPx` is what actually scales it, and the caller derives it from the
 * viewport height.
 */
function WeekGrid({ days, canAdd, toneFor, hourPx, compact, today, trackRef, onAdd, onOpen }) {
  const trackHeight = hourPx * 24;

  const hourMarks = [];
  for (let h = 0; h <= 24; h += 2) {
    hourMarks.push({
      label: h === 24 ? '24:00' : hhmm(h * 60),
      top: h * hourPx - (compact ? 5 : 8),
    });
  }

  return (
    <div style={css(compact ? 'padding-bottom:4px;' : 'overflow-x:auto;padding-bottom:8px;')}>
      <div
        style={css(
          `${compact ? '' : 'min-width:980px;'}display:grid;` +
            `grid-template-columns:${compact ? '27px' : '62px'} repeat(7, minmax(0, 1fr));` +
            `gap:${compact ? '2px' : '6px'};`
        )}
      >
        <div />
        {days.map((day) => {
          const isToday = day.iso === today;
          return (
            <div
              key={`head-${day.dayIdx}`}
              style={css(
                `text-align:center;padding:${compact ? '4px 1px 0' : '7px 4px'};border-radius:${compact ? '7px' : '10px'};` +
                  `background:${isToday ? '#e2dacd' : '#efeae2'};overflow:hidden;`
              )}
            >
              <div style={css(`font-family:'Heebo', sans-serif;font-size:${compact ? '11px' : '15px'};font-weight:700;line-height:1.2;`)}>
                {day.name}
              </div>
              <div style={css(`font-size:${compact ? '9.5px' : '12px'};color:#8a8073;margin-top:1px;font-variant-numeric:tabular-nums;line-height:1.2;`)}>
                {day.date}
              </div>
              {/* Coverage for the day, so the week still reads at a glance. */}
              <div style={css(`height:3px;margin-top:${compact ? '3px' : '5px'};background:#ded7cc;border-radius:999px;overflow:hidden;`)}>
                <div
                  style={css(
                    `height:100%;width:${Math.round((day.covered / 1440) * 100)}%;border-radius:999px;` +
                      `background:${day.covered >= 1440 ? 'oklch(0.6 0.09 150)' : ACCENT};`
                  )}
                />
              </div>
            </div>
          );
        })}

        <div style={css(`position:relative;height:${trackHeight}px;margin-top:6px;`)}>
          {hourMarks.map((mark) => (
            <div
              key={mark.label}
              style={css(
                `position:absolute;top:${mark.top}px;left:0;right:0;text-align:left;` +
                  `font-size:${compact ? '8.5px' : '11px'};color:#a1978a;font-variant-numeric:tabular-nums;line-height:1;`
              )}
            >
              {mark.label}
            </div>
          ))}
        </div>

        {days.map((day) => (
          <div
            key={`track-${day.dayIdx}`}
            ref={day.dayIdx === 0 ? trackRef : null}
            data-day-track={day.dayIdx}
            onClick={(event) => {
              if (!canAdd || event.target !== event.currentTarget) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const hour = Math.max(
                0,
                Math.min(23, Math.floor((event.clientY - rect.top) / hourPx))
              );
              onAdd(day.dayIdx, hour);
            }}
            style={css(
              `position:relative;height:${trackHeight}px;margin-top:6px;border-radius:${compact ? '7px' : '10px'};` +
                `background:#fdfcfa;border:1px solid #e8e1d7;` +
                `background-image:repeating-linear-gradient(to bottom, #eee8df 0 1px, transparent 1px ${hourPx}px);` +
                `overflow:hidden;cursor:${canAdd ? 'copy' : 'default'};`
            )}
          >
            {day.pieces.map((piece, index) => {
              const shift = piece.shift;
              const tone = shift.caregiverId ? toneFor(shift.caregiverId) : NEUTRAL_TONE;
              const width = 100 / day.laneCount;
              const height = Math.max(
                compact ? 11 : 26,
                ((piece.to - piece.from) / 60) * hourPx - (compact ? 1 : 3)
              );
              // A phone block is only a few pixels tall, so each line of text
              // has to earn its place.
              const showTime = !compact || height >= 30;
              const showNote = shift.note && (!compact || height >= 48);
              const showMsg = shift.msg && (!compact || height >= 62);
              const msgText = shift.msg
                ? height >= 64 && !compact
                  ? `מיפעת: ${shift.msg}`
                  : 'הודעה מיפעת'
                : '';
              return (
                <button
                  key={`${shift.id}-${index}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpen(shift);
                  }}
                  title={`${hhmm(shift.start)}–${hhmm(shift.end)} ${shift.person || ''}`}
                  style={css(
                    [
                      'position:absolute',
                      `top:${(piece.from / 60) * hourPx}px`,
                      `height:${height}px`,
                      `right:${piece.lane * width}%`,
                      `width:calc(${width}% - ${compact ? 2 : 4}px)`,
                      'text-align:right',
                      `padding:${compact ? '1px 3px' : '4px 7px'}`,
                      `border-radius:${compact ? '5px' : '8px'}`,
                      'cursor:pointer',
                      'overflow:hidden',
                      'display:flex',
                      'flex-direction:column',
                      'gap:1px',
                      `background:${shift.confirmed ? tone.bg : `repeating-linear-gradient(135deg,${tone.bg} 0 7px, #fdfcfa 7px 14px)`}`,
                      `border:1px solid ${tone.border}`,
                      'color:#26221e',
                      'font-family:Assistant, sans-serif',
                    ].join(';')
                  )}
                >
                  {showTime ? (
                    <span
                      style={css(
                        `font-size:${compact ? '9px' : '11px'};color:#6f6659;font-variant-numeric:tabular-nums;` +
                          `display:block;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`
                      )}
                    >
                      {/* A phone column is ~45px wide: the full range wraps to
                          two lines, and the block's height already shows where
                          the shift ends. */}
                      {compact
                        ? (piece.cont ? '↑ ' : '') + hhmm(shift.start)
                        : (piece.cont ? 'המשך · ' : '') + hhmm(shift.start) + '–' + hhmm(shift.end)}
                    </span>
                  ) : null}
                  <span
                    style={css(
                      `font-family:'Heebo', sans-serif;font-size:${compact ? '9.5px' : '14px'};font-weight:500;display:block;` +
                        `line-height:1.15;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`
                    )}
                  >
                    {shift.person || 'ללא שם'}
                  </span>
                  {showNote ? (
                    <span
                      style={css(
                        `font-size:${compact ? '9px' : '11.5px'};color:#5f574c;display:block;line-height:1.2;overflow:hidden;` +
                          (compact ? 'white-space:nowrap;text-overflow:ellipsis;' : '')
                      )}
                    >
                      {shift.note}
                    </span>
                  ) : null}
                  {showMsg ? (
                    <span
                      style={css(
                        `display:block;margin-top:2px;font-size:${compact ? '9px' : '11.5px'};line-height:1.2;` +
                          `color:${tone.strong};border-right:2px solid ${tone.strong};padding-right:5px;overflow:hidden;`
                      )}
                    >
                      {compact ? 'הודעה' : msgText}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}


/**
 * Shared checklist.
 *
 * Anyone looking at the board can add a task or tick one off - a caregiver
 * mid-shift should not need the manager code to hand work over. Who ticked
 * something is recorded when they have said who they are; the choice is kept
 * per device in localStorage, which is a viewer preference rather than shared
 * state, so it never becomes a second source of truth.
 */
function ChecklistCard({
  items,
  caregivers,
  manager,
  meId,
  onChooseMe,
  onAdd,
  onToggle,
  onDelete,
  onClearDone,
  busy,
  isNarrow,
  timezone,
}) {
  const [text, setText] = useState('');
  const open = items.filter((item) => !item.done);
  const done = items.filter((item) => item.done);

  const submit = (event) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    onAdd(value);
    setText('');
  };

  return (
    <div
      data-checklist=""
      style={css(
        `flex:1;min-width:${isNarrow ? '0' : '300px'};background:#fdfcfa;border:1px solid #e4ddd3;` +
          `border-radius:14px;padding:16px ${isNarrow ? '14px' : '18px'};display:flex;flex-direction:column;gap:12px;`
      )}
    >
      <div style={css('display:flex;justify-content:space-between;align-items:baseline;gap:10px;')}>
        <div style={css("font-family:'Heebo', sans-serif;font-size:17px;font-weight:700;")}>צ׳קליסט משותף</div>
        <div style={css('font-size:12px;color:#8a8073;')}>
          {open.length === 0 ? 'הכול בוצע' : `${open.length} פתוחות`}
        </div>
      </div>

      {caregivers.length > 0 ? (
        <label style={css('display:flex;align-items:center;gap:7px;font-size:13px;color:#8a8073;')}>
          <span style={css('flex:none;')}>אני</span>
          <select
            value={meId}
            onChange={(event) => onChooseMe(event.target.value)}
            style={css('flex:1;min-width:0;border:1px solid #d4ccc0;background:#fff;border-radius:999px;padding:7px 11px;font-size:14px;color:#26221e;')}
          >
            <option value="">בלי לציין שם</option>
            {caregivers.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div style={css('display:flex;flex-wrap:wrap;gap:6px;')}>
        {CONTRIBUTIONS.map((label) => (
          <button
            key={label}
            type="button"
            onClick={() => setText(label)}
            style={css('border:1px solid #d4ccc0;background:#fdfcfa;color:#45403a;border-radius:999px;padding:6px 12px;font-size:13px;cursor:pointer;')}
          >
            {`+ ${label}`}
          </button>
        ))}
      </div>

      <form onSubmit={submit} style={css('display:flex;gap:8px;align-items:center;')}>
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="משימה חדשה"
          maxLength={300}
          style={css('flex:1;min-width:0;border:1px solid #d4ccc0;background:#fdfcfa;border-radius:999px;padding:8px 13px;font-size:14px;color:#26221e;')}
        />
        <button
          type="submit"
          disabled={busy}
          aria-label="הוספת משימה"
          style={css('flex:none;border:none;background:#26221e;color:#f6f3ee;border-radius:999px;padding:9px 16px;font-size:14px;cursor:pointer;')}
        >
          הוספה
        </button>
      </form>

      {items.length === 0 ? (
        <div style={css('font-size:14px;color:#8a8073;line-height:1.55;padding:4px 2px;')}>
          אין עדיין משימות. כל מלווה יכולה להוסיף כאן משימה או לסמן וי על משימה שבוצעה.
        </div>
      ) : null}

      <div style={css('display:flex;flex-direction:column;gap:6px;')}>
        {[...open, ...done].map((item) => (
          <div
            key={item.id}
            style={css(
              `display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:10px;` +
                `background:${item.done ? '#f2efe9' : '#f7f3ed'};`
            )}
          >
            <button
              onClick={() => onToggle(item)}
              disabled={busy}
              aria-label={item.done ? `ביטול סימון: ${item.text}` : `סימון כבוצע: ${item.text}`}
              style={css(
                `flex:none;width:22px;height:22px;border-radius:7px;cursor:pointer;font-size:13px;line-height:1;` +
                  (item.done
                    ? 'border:1px solid oklch(0.76 0.08 150);background:oklch(0.95 0.04 150);color:oklch(0.45 0.09 150);'
                    : 'border:1px solid #d4ccc0;background:#fff;color:transparent;')
              )}
            >
              ✓
            </button>
            <span style={css('flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;')}>
              <span
                style={css(
                  `font-size:14.5px;line-height:1.4;overflow-wrap:anywhere;` +
                    (item.done ? 'color:#8a8073;text-decoration:line-through;' : 'color:#26221e;')
                )}
              >
                {item.text}
              </span>
              <span style={css('font-size:11.5px;color:#a1978a;')}>
                {item.done
                  ? `בוצע${item.doneByName ? ` · ${item.doneByName}` : ''}${
                      item.doneAt ? ` · ${formatStamp(item.doneAt, timezone)}` : ''
                    }`
                  : item.createdByName
                    ? `הוסיפה: ${item.createdByName}`
                    : ''}
              </span>
            </span>
            {manager ? (
              <button
                onClick={() => onDelete(item)}
                disabled={busy}
                title="מחיקה"
                aria-label={`מחיקת המשימה: ${item.text}`}
                style={css('flex:none;border:none;background:transparent;color:#a1978a;font-size:15px;line-height:1;padding:2px 4px;cursor:pointer;')}
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {manager && done.length > 0 ? (
        <button
          onClick={onClearDone}
          disabled={busy}
          style={css('align-self:flex-start;border:1px solid #e4ddd3;background:transparent;color:#8a8073;padding:7px 13px;border-radius:999px;font-size:12.5px;cursor:pointer;')}
        >
          {`ניקוי ${done.length} שבוצעו`}
        </button>
      ) : null}
    </div>
  );
}

export default function App() {
  const [boot, setBoot] = useState({ status: 'loading', error: '' });
  const [data, setData] = useState(null);
  const [week, setWeek] = useState(null);
  const [previewTeam, setPreviewTeam] = useState(
    () => new URLSearchParams(window.location.search).get('view') === 'team'
  );
  const [draft, setDraft] = useState(null);
  const [draftError, setDraftError] = useState('');
  const [newName, setNewName] = useState('');
  const [newPaid, setNewPaid] = useState(true);
  const [shared, setShared] = useState(false);
  const [askPass, setAskPass] = useState(false);
  const [passInput, setPassInput] = useState('');
  const [passError, setPassError] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [meId, setMeId] = useState(() => {
    try {
      return localStorage.getItem(ME_KEY) || '';
    } catch {
      return '';
    }
  });

  const revisionRef = useRef(0);
  const weekRef = useRef(null);
  weekRef.current = week;
  const draftOpenRef = useRef(false);
  draftOpenRef.current = Boolean(draft);

  const applyState = useCallback((next) => {
    revisionRef.current = next.revision;
    setData(next);
    setWeek((current) => current || next.week);
  }, []);

  const load = useCallback(
    async (targetWeek) => {
      const next = await api.state(targetWeek);
      applyState(next);
      return next;
    },
    [applyState]
  );

  const showToast = useCallback((message) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 3600);
  }, []);

  const reportError = useCallback(
    (err) => {
      if (err instanceof ApiError && err.status === 401) {
        showToast('ההרשאה פגה. יש להתחבר מחדש.');
        load(weekRef.current).catch(() => {});
        return;
      }
      if (err instanceof ApiError && err.code === 'duplicate') {
        showToast('המשמרת הזו כבר קיימת.');
        return;
      }
      showToast('השמירה נכשלה. נסו שוב.');
      // eslint-disable-next-line no-console
      console.error(err);
    },
    [load, showToast]
  );

  // Initial load.
  useEffect(() => {
    load()
      .then(() => setBoot({ status: 'ready', error: '' }))
      .catch((err) => {
        if (err instanceof ApiError && err.code === 'access_code_required') {
          setBoot({ status: 'gated', error: '' });
        } else {
          setBoot({ status: 'error', error: 'טעינת הלוח נכשלה. רעננו את הדף.' });
        }
      });
  }, [load]);

  // Week switching.
  useEffect(() => {
    if (!week || !data || data.week === week) return;
    load(week).catch(reportError);
  }, [week, data, load, reportError]);

  const refresh = useCallback(() => {
    // Do not yank the schedule out from under an open editor; the refresh
    // happens when the editor closes instead.
    if (draftOpenRef.current) return;
    load(weekRef.current).catch(() => {});
  }, [load]);

  useSync({
    enabled: boot.status === 'ready',
    getRevision: () => revisionRef.current,
    onStale: refresh,
  });

  const viewport = useViewport();
  const isNarrow = viewport.isNarrow;
  const trackRef = useRef(null);
  const [trackTop, setTrackTop] = useState(null);
  const hourPx = hourHeightFor(viewport, isNarrow ? trackTop : null);
  const manager = Boolean(data?.isManager) && !previewTeam;

  // How much room the 24-hour track actually has is only knowable once the
  // header above it has laid out, and that changes with the manager's extra
  // button row. Measuring it keeps the whole board on one phone screen.
  useLayoutEffect(() => {
    if (!isNarrow || !trackRef.current) {
      setTrackTop(null);
      return;
    }
    const top = trackRef.current.getBoundingClientRect().top + window.scrollY;
    setTrackTop((prev) => (prev !== null && Math.abs(prev - top) < 2 ? prev : top));
  });

  const caregivers = data?.caregivers ?? [];
  const checklist = data?.checklist ?? [];
  const shifts = data?.shifts ?? [];
  // A remembered caregiver who has since left the roster is treated as unset.
  const effectiveMeId = caregivers.some((person) => person.id === meId) ? meId : '';
  // Caregivers may put themselves down for a slot; the request needs somebody
  // to attribute it to, so an empty roster leaves the board read-only.
  const canAdd = manager || caregivers.length > 0;
  const pendingCount = shifts.filter((shift) => !shift.confirmed).length;
  const dates = data?.dates ?? [];

  const toneById = useMemo(() => {
    const map = new Map();
    caregivers.forEach((person, index) => map.set(person.id, toneAt(index)));
    return map;
  }, [caregivers]);

  const toneFor = useCallback(
    (caregiverId) => toneById.get(caregiverId) || NEUTRAL_TONE,
    [toneById]
  );

  // ---------------------------------------------------------------------
  // Layout of the week grid - ported from the prototype.
  // ---------------------------------------------------------------------
  const { days, coveredMin, gapText } = useMemo(() => {
    const byDay = [[], [], [], [], [], [], []];
    shifts.forEach((s) => {
      const len = shiftLen(s);
      const firstLen = Math.min(len, 1440 - s.start);
      byDay[s.day].push({ shift: s, from: s.start, to: s.start + firstLen, cont: false });
      const rest = len - firstLen;
      if (rest > 0 && s.day < 6) byDay[s.day + 1].push({ shift: s, from: 0, to: rest, cont: true });
    });

    let covered = 0;
    const gaps = [];
    const built = DAYS.map((name, dayIdx) => {
      const raw = byDay[dayIdx].slice().sort((a, b) => a.from - b.from || a.to - b.to);
      const dayGaps = [];
      let cursor = 0;
      raw.forEach((p) => {
        if (p.from > cursor) {
          gaps.push(`${name} ${hhmm(cursor)}–${hhmm(p.from)}`);
          dayGaps.push({ from: cursor, to: p.from });
        }
        cursor = Math.max(cursor, p.to);
      });
      if (cursor < 1440) {
        gaps.push(`${name} ${hhmm(cursor)}–24:00`);
        dayGaps.push({ from: cursor, to: 1440 });
      }

      let merged = 0;
      let mEnd = 0;
      raw.forEach((p) => {
        const start = Math.max(p.from, mEnd);
        if (p.to > start) {
          merged += p.to - start;
          mEnd = p.to;
        }
      });
      covered += merged;
      const dayCovered = merged;

      const lanes = [];
      const pieces = raw.map((p) => {
        let lane = lanes.findIndex((endAt) => endAt <= p.from);
        if (lane === -1) {
          lanes.push(p.to);
          lane = lanes.length - 1;
        } else {
          lanes[lane] = p.to;
        }
        return { ...p, lane };
      });
      const laneCount = Math.max(1, lanes.length);

      return {
        name,
        dayIdx,
        date: dayLabel(dates[dayIdx]),
        iso: dates[dayIdx],
        pieces,
        laneCount,
        gaps: dayGaps,
        covered: dayCovered,
      };
    });

    return { days: built, coveredMin: covered, gapText: gaps };
  }, [shifts, dates]);

  const minutesFor = useCallback(
    (caregiverId) =>
      shifts
        .filter((s) => s.caregiverId === caregiverId)
        .reduce((total, s) => total + shiftLen(s), 0),
    [shifts]
  );

  const payRows = useMemo(() => {
    if (!manager) return [];
    return caregivers
      .slice()
      .sort((a, b) => (b.paid ? 1 : 0) - (a.paid ? 1 : 0))
      .map((person) => {
        const minutes = minutesFor(person.id);
        const sum = person.paid ? Math.round((minutes / 60) * (Number(person.rate) || 0)) : 0;
        return { person, minutes, sum, tone: toneFor(person.id) };
      });
  }, [manager, caregivers, minutesFor, toneFor]);

  const payTotal = payRows.reduce((total, row) => total + row.sum, 0);

  const missingH = Math.round((WEEK_MINUTES - coveredMin) / 60);
  const pct = Math.round((coveredMin / WEEK_MINUTES) * 100);

  const currentWeek = data?.weeks?.current;
  const nextWeek = data?.weeks?.next;
  const isCurrent = week === currentWeek;

  // ---------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------
  const run = useCallback(
    async (fn) => {
      setBusy(true);
      try {
        await fn();
        await load(weekRef.current);
      } catch (err) {
        reportError(err);
        await load(weekRef.current).catch(() => {});
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [load, reportError]
  );

  const addPersonFromEditor = async (event) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const created = await api.createCaregiver({
        name,
        paid: newPaid,
        rate: newPaid ? 50 : 0,
      });
      setNewName('');
      patchDraft({ caregiverId: created.id });
      await load(weekRef.current);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  const addPerson = async (event) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      await run(() => api.createCaregiver({ name, paid: newPaid, rate: newPaid ? 50 : 0 }));
      setNewName('');
    } catch {
      /* reported by run */
    }
  };

  const toggleRole = (person) => {
    if (!manager) return;
    run(() => api.updateCaregiver(person.id, { paid: !person.paid })).catch(() => {});
  };

  const rateTimers = useRef(new Map());
  const [rateDrafts, setRateDrafts] = useState({});

  const onRateChange = (person, value) => {
    const cleaned = value.replace(/[^\d.]/g, '');
    setRateDrafts((prev) => ({ ...prev, [person.id]: cleaned }));
    const timers = rateTimers.current;
    clearTimeout(timers.get(person.id));
    timers.set(
      person.id,
      window.setTimeout(() => {
        setRateDrafts((prev) => {
          const next = { ...prev };
          delete next[person.id];
          return next;
        });
        run(() => api.updateCaregiver(person.id, { rate: cleaned === '' ? 0 : Number(cleaned) })).catch(
          () => {}
        );
      }, 700)
    );
  };

  const removePerson = (person) => {
    if (!manager) return;
    if (!window.confirm(`להסיר את ${person.name} מרשימת המלווים?`)) return;
    run(() => api.deleteCaregiver(person.id)).catch(() => {});
  };

  const chooseMe = (id) => {
    setMeId(id);
    try {
      if (id) localStorage.setItem(ME_KEY, id);
      else localStorage.removeItem(ME_KEY);
    } catch {
      // Private browsing or blocked storage: the choice just will not stick.
    }
  };

  const addChecklistItem = (text) => {
    run(() => api.createChecklistItem({ text, caregiverId: effectiveMeId || null })).catch(() => {});
  };

  const toggleChecklistItem = (item) => {
    // Deliberately no version check: ticking a box is not an edit worth losing
    // to a race, and two people ticking the same task agree anyway.
    run(() =>
      api.updateChecklistItem(item.id, {
        done: !item.done,
        caregiverId: effectiveMeId || null,
      })
    ).catch(() => {});
  };

  const deleteChecklistItem = (item) => {
    if (!window.confirm(`למחוק את המשימה "${item.text}"?`)) return;
    run(() => api.deleteChecklistItem(item.id)).catch(() => {});
  };

  const clearDoneChecklist = () => {
    if (!window.confirm('למחוק את כל המשימות שכבר בוצעו?')) return;
    run(() => api.clearDoneChecklist()).catch(() => {});
  };

  const copyPrev = () => {
    run(async () => {
      const result = await api.copyPreviousWeek(week);
      if (!result.copied) showToast('אין משמרות בשבוע הקודם להעתקה.');
    }).catch(() => {});
  };

  const shareTeam = () => {
    const url = `${window.location.origin}${window.location.pathname}?view=team`;
    const done = () => {
      setShared(true);
      window.setTimeout(() => setShared(false), 2200);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, done);
    else done();
  };

  const closeEditor = () => {
    setDraft(null);
    setDraftError('');
    window.setTimeout(() => load(weekRef.current).catch(() => {}), 0);
  };

  const patchDraft = (patch) => setDraft((current) => ({ ...current, ...patch }));

  const saveShift = async () => {
    if (!draft) return;
    const payload = {
      week,
      day: draft.day,
      start: draft.start,
      end: draft.end,
      caregiverId: draft.caregiverId || null,
      note: draft.note || '',
      msg: draft.msg || '',
      confirmed: Boolean(draft.confirmed),
    };
    if (!manager) {
      // The server enforces this too; sending it honestly keeps the request
      // payload matching what the caregiver was shown.
      payload.confirmed = false;
      payload.msg = '';
      if (!payload.caregiverId) {
        setDraftError('בחרי מי מהמלווים לוקחת את המשמרת.');
        return;
      }
    }
    setBusy(true);
    try {
      if (draft.isNew) await api.createShift(payload);
      else await api.updateShift(draft.id, { ...payload, version: draft.version });
      setDraft(null);
      setDraftError('');
      await load(weekRef.current);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'stale_version') {
        setDraftError('המשמרת עודכנה במכשיר אחר. הנתונים עודכנו — בדקו ושמרו שוב.');
        const current = err.data?.current;
        if (current) setDraft({ ...current, isNew: false });
        await load(weekRef.current).catch(() => {});
      } else if (err instanceof ApiError && err.code === 'duplicate') {
        setDraftError('כבר קיימת משמרת זהה ליום ולשעות האלה.');
      } else {
        reportError(err);
      }
    } finally {
      setBusy(false);
    }
  };

  const deleteShift = async () => {
    if (!draft || draft.isNew) {
      setDraft(null);
      return;
    }
    setBusy(true);
    try {
      await api.deleteShift(draft.id, manager ? undefined : effectiveMeId);
      setDraft(null);
      setDraftError('');
      await load(weekRef.current);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  const submitPass = async (event) => {
    event.preventDefault();
    const code = passInput.trim();
    if (!code) return;
    try {
      await api.loginManager(code);
      setAskPass(false);
      setPassInput('');
      setPassError('');
      setPreviewTeam(false);
      setDraft(null);
      const url = new URL(window.location.href);
      url.searchParams.delete('view');
      window.history.replaceState({}, '', url.pathname + url.search);
      await load(weekRef.current);
    } catch (err) {
      setPassError(
        err instanceof ApiError && err.status === 429
          ? 'יותר מדי ניסיונות. נסי שוב עוד כמה דקות.'
          : 'סיסמה שגויה. נסי שוב.'
      );
    }
  };

  const submitTeamCode = async (event) => {
    event.preventDefault();
    const code = passInput.trim();
    if (!code) return;
    try {
      await api.loginTeam(code);
      setPassInput('');
      setPassError('');
      await load();
      setBoot({ status: 'ready', error: '' });
    } catch {
      setPassError('קוד שגוי. נסו שוב.');
    }
  };

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      // The cookie may already be gone or the network may be down; reloading
      // still drops every bit of manager state this tab is holding.
    }
    // Drop ?view=team as well, so signing out lands on a clean team board.
    window.location.replace(window.location.pathname);
  };

  const toggleView = async () => {
    if (manager) {
      setPreviewTeam(true);
      setDraft(null);
      setShared(false);
      return;
    }
    if (data?.isManager) {
      setPreviewTeam(false);
      return;
    }
    setAskPass(true);
    setPassInput('');
    setPassError('');
  };

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  if (boot.status === 'loading') {
    return (
      <div dir="rtl" style={css('min-height:100vh;display:flex;align-items:center;justify-content:center;color:#8a8073;font-size:15px;')}>
        טוען את לוח הליווי…
      </div>
    );
  }

  if (boot.status === 'gated') {
    return (
      <div dir="rtl" style={css('min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;')}>
        <form onSubmit={submitTeamCode} style={css('background:#fdfcfa;border-radius:18px;padding:22px;width:100%;max-width:330px;display:flex;flex-direction:column;gap:13px;box-shadow:0 24px 60px rgba(38,34,30,0.16);')}>
          <div style={css("font-family:'Heebo', sans-serif;font-size:19px;font-weight:700;")}>לוח הליווי השבועי</div>
          <div style={css('font-size:14px;color:#6f6659;line-height:1.5;')}>הזינו את קוד הצפייה שקיבלתם.</div>
          <input
            value={passInput}
            onChange={(e) => {
              setPassInput(e.target.value);
              setPassError('');
            }}
            type="password"
            autoComplete="current-password"
            autoFocus
            placeholder="קוד צפייה"
            style={css('border:1px solid #d4ccc0;background:#fff;border-radius:10px;padding:10px 12px;font-size:16px;color:#26221e;letter-spacing:0.2em;text-align:center;')}
          />
          <div style={css(`font-size:13px;color:#8a4a37;min-height:17px;display:${passError ? 'block' : 'none'};`)}>{passError}</div>
          <button type="submit" style={css('border:none;background:#26221e;color:#f6f3ee;padding:9px 20px;border-radius:999px;font-size:14px;cursor:pointer;')}>
            כניסה
          </button>
        </form>
      </div>
    );
  }

  if (boot.status === 'error') {
    return (
      <div dir="rtl" style={css('min-height:100vh;display:flex;align-items:center;justify-content:center;color:#8a4a37;font-size:15px;padding:20px;text-align:center;')}>
        {boot.error}
      </div>
    );
  }

  const draftView = draft || {
    start: 0,
    end: 240,
    caregiverId: null,
    note: '',
    msg: '',
    confirmed: false,
    day: 0,
  };
  const dur = draftView.end > draftView.start
    ? draftView.end - draftView.start
    : draftView.end + 1440 - draftView.start;
  const draftPersonName =
    caregivers.find((p) => p.id === draftView.caregiverId)?.name || '';

  return (
    <div dir="rtl" style={css(`min-height:100vh;padding:${isNarrow ? '12px 12px 48px' : '26px 20px 70px'};color:#26221e;`)}>
      {toast ? (
        <div style={css('position:fixed;top:14px;left:50%;transform:translateX(-50%);background:#26221e;color:#f6f3ee;padding:9px 18px;border-radius:999px;font-size:14px;z-index:60;box-shadow:0 10px 30px rgba(38,34,30,.25);')}>
          {toast}
        </div>
      ) : null}

      <div style={css(`max-width:1280px;margin:0 auto;display:flex;flex-direction:column;gap:${isNarrow ? '10px' : '18px'};`)}>
        <header style={css(`display:flex;flex-wrap:wrap;gap:${isNarrow ? '12px' : '16px'};align-items:${isNarrow ? 'flex-start' : 'flex-end'};justify-content:space-between;border-bottom:1px solid #ded7cc;padding-bottom:${isNarrow ? '10px' : '16px'};`)}>
          <div style={css('display:flex;flex-direction:column;gap:5px;')}>
            <div style={css('display:flex;gap:9px;align-items:center;')}>
              <span style={css("font-family:'Heebo', sans-serif;font-size:12px;letter-spacing:0.14em;color:#8a8073;")}>
                ליווי מסביב לשעון · בית חולים
              </span>
              <span style={css(`border-radius:999px;padding:3px 10px;font-size:12px;font-family:Heebo, sans-serif;background:${manager ? '#26221e' : '#e7e0d5'};color:${manager ? '#f6f3ee' : '#45403a'};`)}>
                {manager ? 'תצוגת יפעת' : 'תצוגת מלווים'}
              </span>
            </div>
            <h1 style={css(`margin:0;font-family:'Heebo', sans-serif;font-size:${isNarrow ? '22px' : '29px'};font-weight:700;letter-spacing:-0.01em;`)}>
              רפואה שלמה במהרה לאמא
            </h1>
            <div style={css('font-size:15px;color:#6f6659;')}>
              {`${isCurrent ? 'השבוע הנוכחי' : week === nextWeek ? 'השבוע הבא' : 'שבוע'} · ראשון ${dayLabel(dates[0])} – שבת ${dayLabel(dates[6])}`}
            </div>
          </div>
          <div style={css('display:flex;flex-wrap:wrap;gap:8px;align-items:center;')}>
            <div style={css('display:flex;gap:4px;background:#ece7df;padding:4px;border-radius:999px;')}>
              <button onClick={() => setWeek(currentWeek)} style={css(tabStyle(isCurrent))}>השבוע</button>
              <button onClick={() => setWeek(nextWeek)} style={css(tabStyle(week === nextWeek))}>השבוע הבא</button>
            </div>
            {manager ? (
              <div style={css('display:flex;flex-wrap:wrap;gap:8px;')}>
                <button
                  onClick={copyPrev}
                  disabled={busy}
                  style={css('border:1px solid #d4ccc0;background:#fdfcfa;color:#45403a;padding:9px 14px;border-radius:999px;font-size:14px;cursor:pointer;')}
                >
                  שכפול מהשבוע הקודם
                </button>
                <button
                  onClick={shareTeam}
                  style={css('border:none;background:#26221e;color:#f6f3ee;padding:9px 15px;border-radius:999px;font-size:14px;cursor:pointer;')}
                >
                  {shared ? 'הקישור הועתק ✓' : 'קישור למלווים'}
                </button>
              </div>
            ) : null}
          </div>
        </header>

        <section style={css(`display:flex;flex-wrap:wrap;gap:${isNarrow ? '10px' : '16px'};align-items:center;background:#fdfcfa;border:1px solid #e4ddd3;border-radius:14px;padding:${isNarrow ? '10px 12px' : '14px 18px'};`)}>
          <div style={css(`display:flex;flex-direction:column;gap:1px;min-width:${isNarrow ? '0' : '138px'};`)}>
            <div style={css(`font-family:'Heebo', sans-serif;font-size:${isNarrow ? '17px' : '21px'};font-weight:700;`)}>
              {missingH} שעות
            </div>
            <div style={css(`font-size:${isNarrow ? '12px' : '13px'};color:#8a8073;`)}>שעות עוד חסרות מתוך 168</div>
          </div>
          <div style={css(`flex:1;min-width:${isNarrow ? '120px' : '170px'};height:10px;background:#eae4db;border-radius:999px;overflow:hidden;`)}>
            <div style={css(`height:100%;width:${pct}%;background:${ACCENT};border-radius:999px;transition:width .3s;`)} />
          </div>
          {manager && pendingCount > 0 ? (
            <div style={css("flex:none;border-radius:999px;padding:5px 12px;font-size:13px;font-family:'Heebo', sans-serif;background:#f4ece4;border:1px solid #e0cdb8;color:#7a5a3a;")}>
              {`${pendingCount} ממתינות לאישור`}
            </div>
          ) : null}
          <div style={css(`font-size:${isNarrow ? '12.5px' : '14px'};color:#6f6659;line-height:1.45;max-width:520px;`)}>
            {gapText.length === 0
              ? 'כל היממה מכוסה לאורך כל השבוע.'
              : `החורים הקרובים: ${gapText.slice(0, isNarrow ? 2 : 4).join(' · ')}${
                  gapText.length > (isNarrow ? 2 : 4)
                    ? ` ועוד ${gapText.length - (isNarrow ? 2 : 4)}`
                    : ''
                }`}
          </div>
        </section>

        <WeekGrid
          days={days}
          canAdd={canAdd}
          toneFor={toneFor}
          hourPx={hourPx}
          compact={isNarrow}
          today={data?.today}
          trackRef={trackRef}
          onOpen={(shift) => {
            setDraftError('');
            setDraft({ ...shift, isNew: false });
          }}
          onAdd={(dayIdx, hour) => {
            setDraftError('');
            setDraft({
              isNew: true,
              week,
              day: dayIdx,
              start: hour * 60,
              end: ((hour + 4) % 24) * 60,
              caregiverId: manager ? null : effectiveMeId || null,
              note: '',
              msg: '',
              confirmed: false,
            });
          }}
        />

        <section
          style={css(
            `display:flex;flex-wrap:wrap;align-items:stretch;` +
              `flex-direction:${isNarrow ? 'column' : 'row'};gap:${isNarrow ? '12px' : '18px'};`
          )}
        >
          {manager ? (
            <div style={css(`flex:1;min-width:${isNarrow ? '0' : '330px'};background:#fdfcfa;border:1px solid #e4ddd3;border-radius:14px;padding:16px ${isNarrow ? '14px' : '18px'};display:flex;flex-direction:column;gap:12px;`)}>
              <div style={css('display:flex;justify-content:space-between;align-items:baseline;gap:10px;')}>
                <div style={css("font-family:'Heebo', sans-serif;font-size:17px;font-weight:700;")}>מעקב שעות</div>
                <div style={css('font-size:12px;color:#8a8073;')}>גלוי ליפעת בלבד</div>
              </div>
              <div style={css('display:flex;flex-direction:column;gap:8px;')}>
                {payRows.length === 0 ? (
                  <div style={css('font-size:14px;color:#8a8073;line-height:1.55;padding:4px 2px;')}>
                    אין עדיין מלווה בתשלום. בהוספת מלווה בחרי "בתשלום", והשורה שלה תופיע כאן אוטומטית.
                  </div>
                ) : null}
                {payRows.map(({ person, minutes, sum, tone }) => (
                  <div key={person.id} style={css('display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;padding:9px 12px;border-radius:10px;background:#f7f3ed;')}>
                    <span style={css(`width:10px;height:10px;border-radius:999px;background:${tone.border};display:inline-block;flex:none;`)} />
                    <span style={css('display:flex;flex-direction:column;gap:1px;flex:1;min-width:96px;')}>
                      <span style={css("font-family:'Heebo', sans-serif;font-size:15px;font-weight:500;")}>{person.name}</span>
                      <span style={css('font-size:12px;color:#8a8073;')}>{person.paid ? 'בתשלום' : 'משפחה'}</span>
                    </span>
                    <span style={css('font-size:14px;color:#45403a;font-variant-numeric:tabular-nums;min-width:66px;')}>
                      {hoursLabel(minutes)}
                    </span>
                    {person.paid ? (
                      <label style={css('display:flex;align-items:center;gap:5px;font-size:13px;color:#8a8073;')}>
                        <span>₪ לשעה</span>
                        <input
                          value={rateDrafts[person.id] ?? String(person.rate ?? '')}
                          onChange={(e) => onRateChange(person, e.target.value)}
                          inputMode="numeric"
                          style={css('width:54px;border:1px solid #d4ccc0;background:#fff;border-radius:8px;padding:5px 7px;font-size:14px;text-align:center;color:#26221e;font-variant-numeric:tabular-nums;')}
                        />
                      </label>
                    ) : (
                      <span style={css('font-size:13px;color:#a1978a;')}>ללא תשלום</span>
                    )}
                    <span style={css("font-family:'Heebo', sans-serif;font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;min-width:78px;text-align:left;")}>
                      {person.paid ? `₪${sum.toLocaleString('en-US')}` : '—'}
                    </span>
                  </div>
                ))}
              </div>
              <div style={css('display:flex;justify-content:space-between;align-items:baseline;border-top:1px solid #eae4db;padding-top:11px;')}>
                <span style={css('font-size:14px;color:#6f6659;')}>
                  {`סך הכל · ראשון ${dayLabel(dates[0])} – שבת ${dayLabel(dates[6])}`}
                </span>
                <span style={css("font-family:'Heebo', sans-serif;font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;")}>
                  {`₪${payTotal.toLocaleString('en-US')}`}
                </span>
              </div>
            </div>
          ) : null}

          <ChecklistCard
            items={checklist}
            caregivers={caregivers}
            manager={manager}
            meId={effectiveMeId}
            onChooseMe={chooseMe}
            onAdd={addChecklistItem}
            onToggle={toggleChecklistItem}
            onDelete={deleteChecklistItem}
            onClearDone={clearDoneChecklist}
            busy={busy}
            isNarrow={isNarrow}
            timezone={data?.timezone}
          />

          <div style={css(`flex:1;min-width:${isNarrow ? '0' : '300px'};display:flex;flex-direction:column;gap:12px;`)}>
            <div style={css('font-size:13px;color:#8a8073;')}>מלווים</div>
            <div style={css('display:flex;flex-wrap:wrap;gap:8px;align-items:center;')}>
              {caregivers.map((person) => {
                const t = toneFor(person.id);
                const minutes = minutesFor(person.id);
                return (
                  <span
                    key={person.id}
                    style={css(`display:inline-flex;gap:4px;align-items:center;border-radius:999px;padding:6px 13px;font-size:13px;background:${t.bg};border:1px solid ${t.border};`)}
                  >
                    <button
                      onClick={() => toggleRole(person)}
                      style={css(`border:none;background:transparent;padding:0;font-size:13px;color:#26221e;display:inline-flex;gap:4px;align-items:center;cursor:${manager ? 'pointer' : 'default'};`)}
                    >
                      <span style={css("font-family:'Heebo', sans-serif;font-weight:500;")}>{person.name}</span>
                      <span style={css('color:#6f6659;')}>{manager ? (person.paid ? ' · בתשלום' : ' · משפחה') : ''}</span>
                      <span style={css('color:#8a8073;font-variant-numeric:tabular-nums;')}>
                        {minutes ? ` · ${hoursLabel(minutes)}` : ''}
                      </span>
                    </button>
                    {manager ? (
                      <button
                        onClick={() => removePerson(person)}
                        title="הסרה"
                        aria-label={`הסרת ${person.name}`}
                        style={css(`border:none;background:transparent;color:${t.strong};font-size:14px;line-height:1;padding:0 2px;cursor:pointer;`)}
                      >
                        ×
                      </button>
                    ) : null}
                  </span>
                );
              })}
            </div>
            {manager ? (
              <>
                <form onSubmit={addPerson} style={css('display:flex;flex-wrap:wrap;gap:8px;align-items:center;')}>
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="שם מלווה"
                    style={css(`border:1px solid #d4ccc0;background:#fdfcfa;border-radius:999px;padding:8px 13px;font-size:14px;${isNarrow ? 'flex:1;min-width:0;' : 'width:132px;'}color:#26221e;`)}
                  />
                  <div style={css('display:flex;gap:4px;background:#ece7df;padding:4px;border-radius:999px;')}>
                    <button type="button" onClick={() => setNewPaid(false)} style={css(roleBtn(!newPaid))}>משפחה</button>
                    <button type="button" onClick={() => setNewPaid(true)} style={css(roleBtn(newPaid))}>בתשלום</button>
                  </div>
                  <button
                    type="submit"
                    disabled={busy}
                    aria-label="הוספת מלווה"
                    style={css('border:none;background:#26221e;color:#f6f3ee;border-radius:999px;padding:9px 16px;font-size:14px;cursor:pointer;')}
                  >
                    הוספה
                  </button>
                </form>
                <div style={css('font-size:12.5px;color:#a1978a;')}>
                  לחיצה על שם מלווה מחליפה את השיוך שלה בין משפחה לבתשלום.
                </div>
              </>
            ) : null}
            <p style={css('margin:0;font-size:13px;color:#8a8073;line-height:1.6;')}>
              {manager
                ? 'לחיצה על עמודת יום פותחת שיבוץ בשעה שנבחרה, וכל טווח שעות אפשרי. פסים אלכסוניים = ממתין לאישור. שעות של מלווה בתשלום נסכמות אוטומטית.'
                : 'לחיצה על עמודת יום פותחת בקשת משמרת על שמך — הבקשה ממתינה לאישור של יפעת. לחיצה על משמרת מציגה את ההערות ואת ההודעה מיפעת. פסים אלכסוניים = עדיין לא אושרה.'}
            </p>
            <button
              onClick={toggleView}
              style={css('align-self:flex-start;border:1px solid #d4ccc0;background:#fdfcfa;color:#45403a;padding:8px 14px;border-radius:999px;font-size:13px;cursor:pointer;')}
            >
              {manager ? 'מעבר לתצוגת המלווים' : 'כניסה לתצוגת יפעת'}
            </button>
            {/* Offered in both views: from the manager board this used to need
                a detour through the team view first. */}
            {data?.isManager ? (
              <button
                onClick={logout}
                style={css('align-self:flex-start;border:1px solid #e4ddd3;background:transparent;color:#8a8073;padding:7px 13px;border-radius:999px;font-size:12.5px;cursor:pointer;')}
              >
                יציאה מהחשבון
              </button>
            ) : null}
          </div>
        </section>
      </div>

      {askPass ? (
        <div
          onClick={() => {
            setAskPass(false);
            setPassInput('');
            setPassError('');
          }}
          style={css('position:fixed;inset:0;background:rgba(38, 34, 30, 0.34);display:flex;align-items:center;justify-content:center;padding:20px;z-index:50;')}
        >
          <form
            onSubmit={submitPass}
            onClick={(e) => e.stopPropagation()}
            dir="rtl"
            style={css('background:#fdfcfa;border-radius:18px;padding:22px;width:100%;max-width:330px;display:flex;flex-direction:column;gap:13px;box-shadow:0 24px 60px rgba(38, 34, 30, 0.26);')}
          >
            <div style={css("font-family:'Heebo', sans-serif;font-size:19px;font-weight:700;")}>כניסה לתצוגת יפעת</div>
            <input
              value={passInput}
              onChange={(e) => {
                setPassInput(e.target.value);
                setPassError('');
              }}
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              autoFocus
              placeholder="סיסמה"
              style={css('border:1px solid #d4ccc0;background:#fff;border-radius:10px;padding:10px 12px;font-size:16px;color:#26221e;letter-spacing:0.2em;text-align:center;')}
            />
            <div style={css(`font-size:13px;color:#8a4a37;min-height:17px;display:${passError ? 'block' : 'none'};`)}>{passError}</div>
            <div style={css('display:flex;gap:8px;justify-content:space-between;')}>
              <button
                type="button"
                onClick={() => {
                  setAskPass(false);
                  setPassInput('');
                  setPassError('');
                }}
                style={css('border:1px solid #d4ccc0;background:#fdfcfa;color:#45403a;padding:9px 14px;border-radius:999px;font-size:14px;cursor:pointer;')}
              >
                ביטול
              </button>
              <button type="submit" style={css('border:none;background:#26221e;color:#f6f3ee;padding:9px 20px;border-radius:999px;font-size:14px;cursor:pointer;')}>
                כניסה
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {draft ? (
        <div
          onClick={closeEditor}
          style={css(`position:fixed;inset:0;background:rgba(38, 34, 30, 0.34);display:flex;align-items:center;justify-content:center;padding:${isNarrow ? '10px' : '20px'};z-index:40;`)}
        >
          <div
            data-editor=""
            onClick={(e) => e.stopPropagation()}
            dir="rtl"
            style={css(`background:#fdfcfa;border-radius:18px;padding:${isNarrow ? '16px' : '22px'};width:100%;min-width:0;max-width:460px;max-height:${isNarrow ? '92vh' : '88vh'};overflow-y:auto;display:flex;flex-direction:column;gap:15px;box-shadow:0 24px 60px rgba(38, 34, 30, 0.26);`)}
          >
            <div style={css('display:flex;justify-content:space-between;align-items:flex-start;gap:12px;')}>
              <div style={css("font-family:'Heebo', sans-serif;font-size:20px;font-weight:700;")}>
                {manager
                  ? `${draft.isNew ? 'שיבוץ חדש · יום ' : 'עריכת שיבוץ · יום '}${DAYS[draftView.day]}`
                  : draft.isNew
                    ? `בקשת משמרת · יום ${DAYS[draftView.day]}`
                    : `יום ${DAYS[draftView.day]}`}
              </div>
              <button
                onClick={closeEditor}
                aria-label="סגירת החלון"
                style={css('border:none;background:#ece7df;color:#45403a;width:30px;height:30px;border-radius:999px;font-size:17px;cursor:pointer;flex:none;')}
              >
                ×
              </button>
            </div>

            {draftError ? (
              <div style={css('font-size:13px;color:#8a4a37;background:#fdf7f5;border:1px solid #e7d3cc;border-radius:10px;padding:9px 11px;line-height:1.5;')}>
                {draftError}
              </div>
            ) : null}

            {manager ? (
              <div style={css('display:flex;flex-direction:column;gap:15px;')}>
                <div style={css('display:flex;flex-direction:column;gap:7px;')}>
                  <div style={css('font-size:13px;color:#8a8073;')}>מי מלווה</div>
                  {caregivers.length === 0 ? (
                    /* Without this the label sits above an empty gap with no
                       hint that the roster, not the app, is the problem. */
                    <div
                      data-roster-empty=""
                      style={css('display:flex;flex-direction:column;gap:9px;background:#f5f2ec;border:1px solid #e4ddd3;border-radius:12px;padding:12px;')}
                    >
                      <span style={css('font-size:13.5px;color:#6f6659;line-height:1.5;')}>
                        עדיין אין מלווים ברשימה, ולכן אין את מי לשבץ. אפשר להוסיף כאן.
                      </span>
                      <form onSubmit={addPersonFromEditor} style={css('display:flex;flex-wrap:wrap;gap:8px;align-items:center;')}>
                        <input
                          value={newName}
                          onChange={(e) => setNewName(e.target.value)}
                          placeholder="שם מלווה"
                          style={css('flex:1;min-width:120px;border:1px solid #d4ccc0;background:#fff;border-radius:999px;padding:8px 13px;font-size:14px;color:#26221e;')}
                        />
                        <div style={css('display:flex;gap:4px;background:#ece7df;padding:4px;border-radius:999px;')}>
                          <button type="button" onClick={() => setNewPaid(false)} style={css(roleBtn(!newPaid))}>
                            משפחה
                          </button>
                          <button type="button" onClick={() => setNewPaid(true)} style={css(roleBtn(newPaid))}>
                            בתשלום
                          </button>
                        </div>
                        <button
                          type="submit"
                          disabled={busy}
                          aria-label="הוספת מלווה"
                          style={css('border:none;background:#26221e;color:#f6f3ee;border-radius:999px;padding:9px 16px;font-size:14px;cursor:pointer;')}
                        >
                          הוספה
                        </button>
                      </form>
                    </div>
                  ) : (
                    <div style={css('display:flex;flex-wrap:wrap;gap:7px;')}>
                      {caregivers.map((person) => {
                        const picked = draftView.caregiverId === person.id;
                        const t = toneFor(person.id);
                        return (
                          <button
                            key={person.id}
                            onClick={() => patchDraft({ caregiverId: picked ? null : person.id })}
                            style={css(
                              `${CHIP}background:${picked ? t.bg : '#fdfcfa'};border:1px solid ${picked ? t.border : '#d4ccc0'};color:#26221e;`
                            )}
                          >
                            {person.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div style={css('display:flex;gap:10px;flex-wrap:wrap;')}>
                  <label style={css('display:flex;flex-direction:column;gap:6px;flex:1;min-width:110px;')}>
                    <span style={css('font-size:13px;color:#8a8073;')}>משעה</span>
                    <select
                      value={String(draftView.start)}
                      onChange={(e) => patchDraft({ start: Number(e.target.value) })}
                      style={css('width:100%;min-width:0;border:1px solid #d4ccc0;background:#fff;border-radius:10px;padding:9px 10px;font-size:15px;color:#26221e;font-variant-numeric:tabular-nums;')}
                    >
                      {TIME_OPTIONS.map((t) => (
                        <option key={t.value} value={String(t.value)}>{t.label}</option>
                      ))}
                    </select>
                  </label>
                  <label style={css('display:flex;flex-direction:column;gap:6px;flex:1;min-width:110px;')}>
                    <span style={css('font-size:13px;color:#8a8073;')}>עד שעה</span>
                    <select
                      value={String(draftView.end)}
                      onChange={(e) => patchDraft({ end: Number(e.target.value) })}
                      style={css('width:100%;min-width:0;border:1px solid #d4ccc0;background:#fff;border-radius:10px;padding:9px 10px;font-size:15px;color:#26221e;font-variant-numeric:tabular-nums;')}
                    >
                      {TIME_OPTIONS.map((t) => (
                        <option key={t.value} value={String(t.value)}>{t.label}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div style={css('font-size:13px;color:#6f6659;')}>
                  {`משך: ${hoursLabel(dur)}${draftView.end <= draftView.start ? ` · חוצה חצות אל יום ${DAYS[(draftView.day + 1) % 7]}` : ''}`}
                </div>

                <label style={css('display:flex;flex-direction:column;gap:6px;')}>
                  <span style={css('font-size:13px;color:#8a8073;')}>הערות ומשימות למשמרת</span>
                  <input
                    value={draftView.note || ''}
                    onChange={(e) => patchDraft({ note: e.target.value })}
                    placeholder="תרופות ב־09:00, ביקור רופא, אוכל"
                    style={css('width:100%;min-width:0;border:1px solid #d4ccc0;background:#fff;border-radius:10px;padding:9px 11px;font-size:15px;color:#26221e;')}
                  />
                </label>

                <label style={css('display:flex;flex-direction:column;gap:6px;background:#f5f2ec;border:1px solid #e4ddd3;border-radius:12px;padding:12px;')}>
                  <span style={css('font-size:13px;color:#6f6659;')}>הודעה מיפעת למלווה במשמרת</span>
                  <textarea
                    value={draftView.msg || ''}
                    onChange={(e) => patchDraft({ msg: e.target.value })}
                    rows={3}
                    placeholder="אני בבית הערב — אם היא מתעוררת תעדכני אותי"
                    style={css('width:100%;min-width:0;border:1px solid #d4ccc0;background:#fff;border-radius:10px;padding:9px 11px;font-size:15px;color:#26221e;resize:vertical;line-height:1.5;')}
                  />
                </label>

                <button
                  onClick={() => patchDraft({ confirmed: !draftView.confirmed })}
                  style={css(
                    `border:1px solid ${draftView.confirmed ? 'oklch(0.76 0.08 150)' : '#d4ccc0'};background:${draftView.confirmed ? 'oklch(0.95 0.04 150)' : '#fdfcfa'};color:#26221e;padding:10px 14px;border-radius:10px;font-size:14px;cursor:pointer;text-align:right;font-family:Heebo, sans-serif;`
                  )}
                >
                  {draftView.confirmed ? '✓ אושר וסופי' : 'ממתין לאישור — לחצו לאישור'}
                </button>

                <div style={css('display:flex;gap:8px;justify-content:space-between;border-top:1px solid #eae4db;padding-top:14px;')}>
                  <button
                    onClick={deleteShift}
                    disabled={busy}
                    style={css('border:1px solid #e7d3cc;background:#fdf7f5;color:#8a4a37;padding:9px 14px;border-radius:999px;font-size:14px;cursor:pointer;')}
                  >
                    מחיקה
                  </button>
                  <button
                    onClick={saveShift}
                    disabled={busy}
                    style={css('border:none;background:#26221e;color:#f6f3ee;padding:9px 20px;border-radius:999px;font-size:14px;cursor:pointer;')}
                  >
                    שמירה
                  </button>
                </div>
              </div>
            ) : draft.isNew ? (
              /* A caregiver putting herself down for a slot. Everything here
                 becomes a request: the server forces it unconfirmed, and it
                 stays striped on the board until יפעת approves it. */
              <div style={css('display:flex;flex-direction:column;gap:14px;')}>
                <div style={css('display:flex;flex-direction:column;gap:7px;')}>
                  <div style={css('font-size:13px;color:#8a8073;')}>מי לוקחת את המשמרת</div>
                  <div style={css('display:flex;flex-wrap:wrap;gap:7px;')}>
                    {caregivers.map((person) => {
                      const picked = draftView.caregiverId === person.id;
                      const t = toneFor(person.id);
                      return (
                        <button
                          key={person.id}
                          onClick={() => {
                            patchDraft({ caregiverId: picked ? null : person.id });
                            if (!picked) chooseMe(person.id);
                          }}
                          style={css(
                            `${CHIP}background:${picked ? t.bg : '#fdfcfa'};border:1px solid ${picked ? t.border : '#d4ccc0'};color:#26221e;`
                          )}
                        >
                          {person.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div style={css('display:flex;gap:10px;flex-wrap:wrap;')}>
                  <label style={css('display:flex;flex-direction:column;gap:6px;flex:1;min-width:110px;')}>
                    <span style={css('font-size:13px;color:#8a8073;')}>משעה</span>
                    <select
                      value={String(draftView.start)}
                      onChange={(e) => patchDraft({ start: Number(e.target.value) })}
                      style={css('width:100%;min-width:0;border:1px solid #d4ccc0;background:#fff;border-radius:10px;padding:9px 10px;font-size:15px;color:#26221e;font-variant-numeric:tabular-nums;')}
                    >
                      {TIME_OPTIONS.map((t) => (
                        <option key={t.value} value={String(t.value)}>{t.label}</option>
                      ))}
                    </select>
                  </label>
                  <label style={css('display:flex;flex-direction:column;gap:6px;flex:1;min-width:110px;')}>
                    <span style={css('font-size:13px;color:#8a8073;')}>עד שעה</span>
                    <select
                      value={String(draftView.end)}
                      onChange={(e) => patchDraft({ end: Number(e.target.value) })}
                      style={css('width:100%;min-width:0;border:1px solid #d4ccc0;background:#fff;border-radius:10px;padding:9px 10px;font-size:15px;color:#26221e;font-variant-numeric:tabular-nums;')}
                    >
                      {TIME_OPTIONS.map((t) => (
                        <option key={t.value} value={String(t.value)}>{t.label}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div style={css('font-size:13px;color:#6f6659;')}>
                  {`משך: ${hoursLabel(dur)}${draftView.end <= draftView.start ? ` · חוצה חצות אל יום ${DAYS[(draftView.day + 1) % 7]}` : ''}`}
                </div>

                <div style={css('display:flex;flex-direction:column;gap:7px;')}>
                  <span style={css('font-size:13px;color:#8a8073;')}>מה את מביאה או עושה במשמרת</span>
                  <div style={css('display:flex;flex-wrap:wrap;gap:6px;')}>
                    {CONTRIBUTIONS.map((label) => (
                      <button
                        key={label}
                        type="button"
                        onClick={() =>
                          patchDraft({
                            note: draftView.note
                              ? `${draftView.note}, ${label}`
                              : label,
                          })
                        }
                        style={css('border:1px solid #d4ccc0;background:#fdfcfa;color:#45403a;border-radius:999px;padding:6px 12px;font-size:13px;cursor:pointer;')}
                      >
                        {`+ ${label}`}
                      </button>
                    ))}
                  </div>
                  <input
                    value={draftView.note || ''}
                    onChange={(e) => patchDraft({ note: e.target.value })}
                    placeholder="אפשר גם לכתוב חופשי"
                    style={css('width:100%;min-width:0;border:1px solid #d4ccc0;background:#fff;border-radius:10px;padding:9px 11px;font-size:15px;color:#26221e;')}
                  />
                </div>

                <div style={css('font-size:13px;color:#6f6659;line-height:1.5;background:#f5f2ec;border:1px solid #e4ddd3;border-radius:12px;padding:11px 12px;')}>
                  הבקשה תופיע בלוח בפסים אלכסוניים — ממתינה לאישור — עד שיפעת תאשר אותה.
                </div>

                <div style={css('display:flex;gap:8px;justify-content:flex-end;border-top:1px solid #eae4db;padding-top:14px;')}>
                  <button
                    onClick={saveShift}
                    disabled={busy}
                    style={css('border:none;background:#26221e;color:#f6f3ee;padding:9px 20px;border-radius:999px;font-size:14px;cursor:pointer;')}
                  >
                    שליחת בקשה
                  </button>
                </div>
              </div>
            ) : (
              <div style={css('display:flex;flex-direction:column;gap:14px;')}>
                <div style={css('display:flex;flex-direction:column;gap:3px;')}>
                  <span style={css("font-family:'Heebo', sans-serif;font-size:17px;font-weight:700;")}>
                    {draftPersonName || draft.person || 'ללא שם'}
                  </span>
                  <span style={css('font-size:14px;color:#6f6659;font-variant-numeric:tabular-nums;')}>
                    {`${hhmm(draftView.start)}–${hhmm(draftView.end)} · ${hoursLabel(dur)}`}
                  </span>
                  <span style={css('font-size:13px;color:#8a8073;')}>
                    {draftView.confirmed ? 'המשמרת אושרה' : 'ממתין לאישור'}
                  </span>
                </div>
                <div style={css('display:flex;flex-direction:column;gap:5px;')}>
                  <span style={css('font-size:13px;color:#8a8073;')}>הערות ומשימות</span>
                  <span style={css('font-size:15px;line-height:1.55;color:#26221e;')}>
                    {draftView.note || 'אין הערות למשמרת הזו.'}
                  </span>
                </div>
                <div style={css('background:#f5f2ec;border:1px solid #e4ddd3;border-radius:12px;padding:13px;display:flex;flex-direction:column;gap:5px;')}>
                  <span style={css('font-size:13px;color:#6f6659;')}>הודעה מיפעת</span>
                  <span style={css('font-size:15px;line-height:1.55;color:#26221e;')}>
                    {draftView.msg || 'אין הודעה חדשה.'}
                  </span>
                </div>
                <div style={css('display:flex;gap:8px;justify-content:space-between;align-items:center;flex-wrap:wrap;')}>
                  {!draftView.confirmed && draftView.caregiverId && draftView.caregiverId === effectiveMeId ? (
                    <button
                      onClick={deleteShift}
                      disabled={busy}
                      style={css('border:1px solid #e7d3cc;background:#fdf7f5;color:#8a4a37;padding:9px 14px;border-radius:999px;font-size:14px;cursor:pointer;')}
                    >
                      ביטול הבקשה
                    </button>
                  ) : (
                    <span />
                  )}
                  <button
                    onClick={closeEditor}
                    style={css('border:none;background:#26221e;color:#f6f3ee;padding:9px 20px;border-radius:999px;font-size:14px;cursor:pointer;')}
                  >
                    סגירה
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
