-- Mommy Care initial schema.
-- PostgreSQL is the canonical source of truth for caregivers and shifts.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- caregivers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS caregivers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (btrim(name) <> ''),
  paid         boolean NOT NULL DEFAULT true,
  hourly_rate  numeric(10, 2) NOT NULL DEFAULT 0 CHECK (hourly_rate >= 0),
  active       boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Two active caregivers may not share a name (case-insensitive). Deactivated
-- caregivers are excluded so a name can be reused after someone leaves.
CREATE UNIQUE INDEX IF NOT EXISTS caregivers_active_name_key
  ON caregivers (lower(btrim(name))) WHERE active;

CREATE INDEX IF NOT EXISTS caregivers_active_idx ON caregivers (active, sort_order, created_at);

-- ---------------------------------------------------------------------------
-- shifts
-- A shift belongs to one week (week_start is always the Sunday of that week in
-- APP_TIMEZONE) and one day of that week. Times are minutes-from-midnight.
-- end_minute <= start_minute means the shift crosses midnight into the next day.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shifts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caregiver_id  uuid REFERENCES caregivers (id) ON DELETE SET NULL,
  week_start    date NOT NULL CHECK (EXTRACT(DOW FROM week_start) = 0),
  day_of_week   smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_minute  integer NOT NULL CHECK (start_minute >= 0 AND start_minute < 1440),
  end_minute    integer NOT NULL CHECK (end_minute >= 0 AND end_minute < 1440),
  note          text NOT NULL DEFAULT '',
  message       text NOT NULL DEFAULT '',
  confirmed     boolean NOT NULL DEFAULT false,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shifts_week_idx ON shifts (week_start, day_of_week, start_minute);
CREATE INDEX IF NOT EXISTS shifts_caregiver_idx ON shifts (caregiver_id);

-- Guards against double-submitted / duplicated shifts: the same caregiver
-- cannot hold two identical slots on the same day. Unassigned shifts
-- (caregiver_id IS NULL) are deduplicated against each other too.
CREATE UNIQUE INDEX IF NOT EXISTS shifts_no_duplicate_key
  ON shifts (
    week_start,
    day_of_week,
    start_minute,
    end_minute,
    COALESCE(caregiver_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- ---------------------------------------------------------------------------
-- sync_revision
-- A single monotonic counter bumped by triggers on every mutation. Clients use
-- it to detect that their view is stale; the server uses NOTIFY to push it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_revision (
  id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  revision   bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO sync_revision (id, revision) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION bump_sync_revision() RETURNS trigger AS $$
DECLARE
  next_revision bigint;
BEGIN
  UPDATE sync_revision
     SET revision = revision + 1, updated_at = now()
   WHERE id = 1
  RETURNING revision INTO next_revision;

  PERFORM pg_notify(
    'mommy_changes',
    json_build_object(
      'revision', next_revision,
      'entity', TG_TABLE_NAME,
      'op', lower(TG_OP)
    )::text
  );

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS caregivers_sync_revision ON caregivers;
CREATE TRIGGER caregivers_sync_revision
  AFTER INSERT OR UPDATE OR DELETE ON caregivers
  FOR EACH STATEMENT EXECUTE FUNCTION bump_sync_revision();

DROP TRIGGER IF EXISTS shifts_sync_revision ON shifts;
CREATE TRIGGER shifts_sync_revision
  AFTER INSERT OR UPDATE OR DELETE ON shifts
  FOR EACH STATEMENT EXECUTE FUNCTION bump_sync_revision();

-- ---------------------------------------------------------------------------
-- touch_updated_at: keeps updated_at/version honest without trusting callers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_row() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS caregivers_touch ON caregivers;
CREATE TRIGGER caregivers_touch BEFORE UPDATE ON caregivers
  FOR EACH ROW EXECUTE FUNCTION touch_row();

DROP TRIGGER IF EXISTS shifts_touch ON shifts;
CREATE TRIGGER shifts_touch BEFORE UPDATE ON shifts
  FOR EACH ROW EXECUTE FUNCTION touch_row();
