# Mommy Care

Shared caregiver scheduling for round-the-clock family care.

Production: **https://mommy.smadar.ai**

Mommy Care replaces a Claude Design prototype that kept its schedule in
`localStorage`. Everyone — the manager, the family and the paid caregivers —
now sees the same canonical schedule, because PostgreSQL holds it and every
device reads and writes through the API.

> **Independence.** Mommy Care is a standalone application. It shares nothing
> with the central Lovable application: no code, no database, no runtime. Its
> only relationship to existing infrastructure is that it is deployed as its own
> isolated services inside the existing Railway project `ibda-webinar`. It can
> be removed without touching anything else in that project.

---

## Contents

- [Architecture](#architecture)
- [Data model](#data-model)
- [API](#api)
- [Authentication](#authentication)
- [Synchronization](#synchronization)
- [Local development](#local-development)
- [Environment variables](#environment-variables)
- [Database migrations](#database-migrations)
- [Seed data](#seed-data)
- [Deployment (Railway)](#deployment-railway)
- [Domain configuration](#domain-configuration)
- [Observability](#observability)
- [Rollback](#rollback)

---

## Architecture

One Node.js service serves both the API and the compiled frontend, backed by a
dedicated PostgreSQL instance.

```
Browser (manager / family / caregiver)
   │  HTTPS   fetch + EventSource
   ▼
mommy-web  ── Node 22 / Express
   │  ├── /api/mommy/*     JSON API, session cookies
   │  ├── /api/mommy/events Server-Sent Events
   │  └── /                 static React bundle (built at deploy time)
   ▼
mommy-postgres ── PostgreSQL 18 (dedicated volume)
   └── NOTIFY 'mommy_changes' on every mutation → fan-out to SSE clients
```

Why a single service: the frontend is a static bundle that the API server can
serve directly. Two services would add a hop, a second domain and a CORS
surface for no benefit. The bundle is built during deployment (`npm run build`)
and served from disk — nothing is fetched from GitHub at runtime.

Frontend is React 18 bundled with esbuild. The prototype's markup and inline
styles were carried over verbatim: `client/src/css.js` turns the prototype's CSS
strings into React style objects so the design did not have to be re-typed and
could not drift.

### Two layouts

Every style in this app is inline, so the breakpoint is a `matchMedia` check in
JavaScript (`client/src/useViewport.js`) rather than a CSS media query. Both
layouts render the same `WeekGrid`: seven day columns over a 24-hour track, all
seven days and all 24 hours on screen at once. Below 760px it switches to a
compact variant rather than a different structure.

- **Hour height is measured, not guessed.** The desktop grid is the prototype's
  fixed 34px per hour. On a phone the app measures where the track actually
  starts — which moves when the manager's extra button row appears — and divides
  the remaining viewport height across 24 hours, to one decimal place, clamped
  to 14–26px. On the phones tested the whole board lands above the fold.
- **Every dimension shrinks with it**: column gaps, the hour gutter, day
  headers, block padding and radii.
- **Text in a block earns its place.** A phone column is about 45px wide, so a
  block shows the start time only (its height already shows where the shift
  ends), and the caregiver name, notes and the message indicator appear only as
  the block gets tall enough for them. Tapping a block opens the same editor as
  on desktop, with the full text.
- **Each day header carries a coverage bar**, so the week's gaps read at a
  glance even when the blocks are too small to label, and today's column is
  tinted. Today comes from the server in `APP_TIMEZONE`, not the device clock.
- Header, coverage card and both modals tighten their spacing at the same
  breakpoint, and the cards below the board (hours tracking, checklist, roster)
  stack instead of sharing a row. Three `flex:1` cards with `min-width:0` never
  wrap — they squeeze to roughly 120px each and their contents overflow, which
  in mobile browsers widens the layout viewport and pushes fixed overlays
  partly off-screen. Form controls are forced to 16px so iOS does not zoom the
  page when a field takes focus.

Managers create a shift the same way in both: tapping an empty position in a
day column opens the editor at that hour.

## Data model

Three tables, defined in `server/migrations/001_init.sql`.

**`caregivers`**

| column | type | notes |
| --- | --- | --- |
| `id` | `uuid` | primary key |
| `name` | `text` | non-blank |
| `paid` | `boolean` | paid caregiver vs. family |
| `hourly_rate` | `numeric(10,2)` | 0 for family members |
| `active` | `boolean` | soft-delete flag |
| `sort_order` | `integer` | roster order, drives the colour palette |
| `version` | `integer` | bumped on every update, used for conflict detection |
| `created_at` / `updated_at` | `timestamptz` | maintained by trigger |

A partial unique index on `lower(btrim(name)) WHERE active` stops two active
caregivers sharing a name while still allowing a name to be reused later.

**`shifts`**

| column | type | notes |
| --- | --- | --- |
| `id` | `uuid` | primary key |
| `caregiver_id` | `uuid` | `REFERENCES caregivers ON DELETE SET NULL` |
| `week_start` | `date` | always a Sunday (`CHECK EXTRACT(DOW) = 0`) |
| `day_of_week` | `smallint` | 0–6, Sunday first |
| `start_minute` / `end_minute` | `integer` | 0–1439, minutes from midnight |
| `note` | `text` | tasks for the shift |
| `message` | `text` | manager's message to the caregiver |
| `confirmed` | `boolean` | confirmed vs. awaiting confirmation |
| `version` | `integer` | conflict detection |

`end_minute <= start_minute` means the shift crosses midnight into the next
day, exactly as the prototype modelled it. A unique index over
`(week_start, day_of_week, start_minute, end_minute, caregiver_id)` rejects
duplicate shifts from double taps or a retried request.

**`checklist_items`**

| column | type | notes |
| --- | --- | --- |
| `id` | `uuid` | primary key |
| `body` | `text` | non-blank, 300 characters or fewer |
| `done` | `boolean` | ticked or open |
| `created_by` / `done_by` | `uuid` | `REFERENCES caregivers ON DELETE SET NULL` |
| `done_at` | `timestamptz` | set on the tick, cleared when reopened |
| `position` | `integer` | order of the open list |
| `version` | `integer` | conflict detection |

A check constraint keeps `done_at`/`done_by` empty on an open item, so a
reopened task can never show a stale signature. Removing a caregiver nulls the
reference rather than deleting their tasks.

**`sync_revision`** — a single row holding a monotonic counter. Statement-level
triggers on `caregivers` and `shifts` bump it and `pg_notify` the new value.

**Timezone.** Week boundaries are computed in `APP_TIMEZONE` (default
`Asia/Jerusalem`) by the server, never by the browser, so every device agrees on
which Sunday starts "this week". `week_start` is a `DATE`, so it carries no
offset of its own.

**Caregiver deletion.** `DELETE /api/mommy/caregivers/:id` deactivates a
caregiver who already appears in the schedule (history stays intact, the name
leaves the roster) and hard-deletes one who has never been scheduled. The
response says which happened via `mode`.

## API

All routes are under `/api/mommy`. Mutations require a manager session.

| method | path | auth | purpose |
| --- | --- | --- | --- |
| `GET` | `/auth/session` | public | current session flags |
| `POST` | `/auth/manager` | public | exchange the manager code for a session |
| `POST` | `/auth/team` | public | exchange the team code, when one is configured |
| `POST` | `/auth/logout` | public | clear session cookies |
| `GET` | `/state?week=YYYY-MM-DD` | read | caregivers + shifts for a week |
| `GET` | `/weeks/:week` | read | same, week in the path |
| `GET` | `/revision` | read | current sync revision (polling fallback) |
| `GET` | `/events` | read | Server-Sent Events change stream |
| `POST` | `/caregivers` | manager | create a caregiver |
| `PATCH` | `/caregivers/:id` | manager | rename / change role / rate / active |
| `DELETE` | `/caregivers/:id` | manager | deactivate or delete |
| `POST` | `/shifts` | manager | create a shift |
| `PATCH` | `/shifts/:id` | manager | edit a shift |
| `DELETE` | `/shifts/:id` | manager | delete a shift |
| `POST` | `/weeks/:week/copy-previous` | manager | replace a week with a copy of the one before |
| `GET` | `/checklist` | read | the shared checklist |
| `POST` | `/checklist` | **read** | add a task |
| `PATCH` | `/checklist/:id` | **read** (text: manager) | tick, untick or reword |
| `DELETE` | `/checklist/:id` | manager | remove a task |
| `POST` | `/checklist/clear-done` | manager | remove every completed task |
| `GET` | `/healthz` (root, not under `/api`) | public | liveness + database check |

Notes and messages are fields on a shift, so they persist through the same
`PATCH /shifts/:id` call as the rest of the shift.

`omit`ting `week` defaults to the current week in `APP_TIMEZONE`. A week key
that is not a Sunday is rejected with `400 invalid_week`.

**Stale clients.** `PATCH` accepts the `version` the client last saw. If the row
has moved on, the server answers `409 stale_version` with the current row
instead of overwriting someone else's edit; the UI shows a notice and reloads
the row. Omitting `version` is last-write-wins and is used only for the hourly
rate field.

Error codes are stable strings: `invalid_code`, `manager_required`,
`access_code_required`, `invalid_week`, `stale_version`, `duplicate`,
`caregiver_not_found`, `shift_not_found`, `too_many_attempts`.

## Shared checklist

A running list of tasks for the care team — medication to buy, an appointment to
book — separate from the per-shift notes, which belong to one shift.

The point of it is that a caregiver mid-shift can hand work over **without the
manager code**, so `POST /checklist` and ticking through `PATCH /checklist/:id`
are open to anyone who can read the board. That is a deliberate widening of the
write surface, bounded on every side:

- Only additive actions are public. Deleting a task, clearing the completed ones
  and rewording an existing task are manager-only, so the worst an anonymous
  writer can do is add noise, never destroy the list.
- Public writes are throttled to 60 per IP per 5 minutes, the list is capped at
  300 items, and a task is capped at 300 characters.
- Nothing else opened up: caregivers and shifts still reject every write without
  a manager session.

Tasks are attributed when the writer has said who they are. The choice sits in
a picker on the card and is remembered per device in `localStorage` — a viewer
preference, not shared state, so it never becomes a second source of truth.
Ticking records who and when; unticking clears both. A caregiver removed from
the roster leaves their tasks in place, unattributed.

Checklist changes travel over the same revision counter and SSE stream as the
schedule, so a task added on one phone appears on the others without a reload.

## Authentication

The manager code lives only in the `MANAGER_SECRET` environment variable. It is
never bundled into the frontend and never returned by any endpoint.

`POST /api/mommy/auth/manager` compares the submitted code in constant time and,
on success, sets `mommy_session` — an HMAC-SHA256 signed, `httpOnly`,
`SameSite=Lax`, `Secure` (behind HTTPS) cookie carrying only a role and an
expiry. Every mutating route is behind `requireManager`, so calling the API
directly without that cookie fails with `401` regardless of what the UI shows.
Code entry is throttled to 10 attempts per IP per 10 minutes.

Signing out is offered wherever a manager session exists — on the manager board
and in the team view — and clears the cookie server-side before reloading onto
the public board. The session otherwise lasts `SESSION_MAX_AGE_SECONDS`
(30 days by default), so the code is asked for once per device rather than on
every visit.

The team view is read-only and, by default, open to anyone with the link — the
same reach the prototype's share link had, minus the schedule in the URL. Set
`TEAM_ACCESS_CODE` to put a shared code in front of it; the app then asks for
that code before it loads any data. Team responses never include pay rates or
paid/family status: the server strips them for non-managers.

## Synchronization

1. A client mutates through the API.
2. PostgreSQL commits, and a statement trigger bumps `sync_revision` and calls
   `pg_notify('mommy_changes', …)`.
3. The service holds one dedicated `LISTEN` connection and pushes the new
   revision to every open SSE stream (`GET /api/mommy/events`).
4. Each browser compares that revision with its own and refetches
   `/state` when it is behind. The payload is never pushed — only the fact that
   the client is stale — so PostgreSQL stays the single source of truth.

Fallbacks: every client also polls `/revision` every 20 seconds and refetches
when the tab becomes visible again, so a dropped or proxy-buffered SSE stream
still converges. `localStorage` is not used for schedule data at all.

## Local development

```bash
npm install
cp .env.example .env          # then fill in the values
createdb mommy                # or point DATABASE_URL at any PostgreSQL
npm run migrate
npm run dev                   # esbuild watch + node --watch
```

The app listens on `PORT` (default 8080) and serves the built frontend from
`public/`, which is generated by `npm run build` and is not committed.

## Environment variables

| name | required | default | purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | — | PostgreSQL connection string |
| `MANAGER_SECRET` | yes | — | manager access code, server-side only |
| `SESSION_SECRET` | yes | — | key used to sign session cookies |
| `TEAM_ACCESS_CODE` | no | empty | when set, gates the read-only team view |
| `APP_TIMEZONE` | no | `Asia/Jerusalem` | timezone for week boundaries |
| `SESSION_MAX_AGE_SECONDS` | no | 2592000 | session lifetime (30 days) |
| `PORT` | no | 8080 | HTTP port (Railway sets this) |

Rotating `SESSION_SECRET` invalidates every existing session — everyone signs in
again, which is also the fastest way to revoke access.

## Database migrations

Plain SQL files in `server/migrations/`, applied in filename order and recorded
in `schema_migrations`. They run automatically at startup (`server/index.js`
calls `runMigrations()`), guarded by a PostgreSQL advisory lock so two booting
instances cannot race. Run them by hand with `npm run migrate`.

To add one, create `server/migrations/002_<name>.sql`. Each file runs in its own
transaction; a failure rolls that file back and stops the boot.

## Seed data

The prototype shipped with five caregiver names. They are **not** inserted
automatically — the database starts empty and the manager adds the real roster
through the UI. If you do want the prototype roster (for a demo, or because
those are the real people), run it explicitly:

```bash
npm run seed
```

It is idempotent and skips names that already exist. The list lives in
`server/seed.js`.

## Deployment (Railway)

Railway project **`ibda-webinar`**, environment **`production`**.

| service | kind | notes |
| --- | --- | --- |
| `mommy-web` | this repository | Nixpacks; build `npm run build`, start `npm start` |
| `mommy-postgres` | `ghcr.io/railwayapp-templates/postgres-ssl:18` | dedicated volume `mommy-postgres-volume` |

`mommy-web` deploys from the branch configured on the service. Nixpacks runs
`npm ci` itself, so `railway.json` only adds `npm run build` — running `npm ci`
again in the build phase collides with the cache Nixpacks mounts at
`node_modules/.cache`. `esbuild` is a runtime dependency rather than a dev
dependency for the same reason: `NODE_ENV=production` makes `npm ci` skip
devDependencies, and esbuild is what produces the deployed bundle.

Both are new, isolated services. The pre-existing `web`, `Postgres` and
`sumit-diag-temp` services, their variables, volumes and domains are untouched,
and Mommy Care does not read from or write to the existing `Postgres` service.

`mommy-web` reads `DATABASE_URL` as `${{mommy-postgres.DATABASE_URL}}`, which
resolves to the private-network hostname — the Mommy database is never reached
over the public internet by the app.

Deploys are triggered by pushes to the configured branch. Build configuration
lives in `railway.json`; the healthcheck path is `/healthz`, which verifies the
database connection before Railway routes traffic to a new deployment.

## Domain configuration

`mommy.smadar.ai` is attached as a custom domain on `mommy-web`, alongside the
generated `mommy-web-production.up.railway.app`.

| record | host | value |
| --- | --- | --- |
| `CNAME` | `mommy` (in the `smadar.ai` zone) | `p60qyt8a.up.railway.app` |

Railway reports this record as propagated and the certificate as valid. If the
domain is ever recreated, Railway issues a **different** CNAME target — read it
from the service's domain settings rather than reusing the value above.

Existing domains in the project — including `webinar.braingy.ai` on the `web`
service — are unchanged.

## Verifying a deployment

`scripts/smoke-test.sh` exercises a running deployment end to end: the public
team view, a rejected wrong code, manager login, every mutation, week
navigation, copy-previous-week, and the SSE stream. It also checks that the
manager code appears in neither the HTML nor the JavaScript bundle.

```bash
BASE=https://mommy.smadar.ai MANAGER_CODE=<code> ./scripts/smoke-test.sh
```

It writes while it runs, then deletes every row it created and asserts the
caregiver and shift counts are back where they started, so it is safe to point
at production. It exits non-zero if any check fails.

## Observability

The service logs to stdout, which Railway collects:

- `[boot]` startup, timezone, database host (credentials stripped)
- `[migrate]` migrations applied or already current
- `[sync]` listener connect / reconnect
- `[auth]` login success, failures and throttling, with IP
- `[mutation]` every create / update / delete, with row id
- `[api]` unhandled errors
- `[health]` failed database checks

Secrets are never logged: `describeDatabase()` prints only host and database
name, and no code path prints `MANAGER_SECRET`, `TEAM_ACCESS_CODE` or
`SESSION_SECRET`.

## Rollback

1. **Application.** Railway → `mommy-web` → Deployments → pick the last good
   deployment → *Redeploy*. Or revert the commit and push; the service redeploys
   from the branch.
2. **Schema.** Migrations are additive and never drop data. To undo one, add a
   new migration that reverses it rather than editing an applied file.
3. **Data.** The database lives on the `mommy-postgres-volume` volume. Take a
   `pg_dump` before anything destructive; Railway volume backups cover the rest.
4. **Whole application.** Deleting the `mommy-web` and `mommy-postgres`
   services, their volume and the `mommy.smadar.ai` domain removes Mommy Care
   completely and leaves the rest of `ibda-webinar` untouched.
