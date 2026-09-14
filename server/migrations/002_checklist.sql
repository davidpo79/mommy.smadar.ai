-- Shared checklist.
--
-- Unlike caregivers and shifts, this table is writable by anyone who can read
-- the board: the whole point is that a caregiver on shift can add a task or
-- tick one off without the manager code. Deletion stays manager-only, so the
-- worst an anonymous writer can do is add noise, never destroy history.

CREATE TABLE IF NOT EXISTS checklist_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body         text NOT NULL CHECK (btrim(body) <> '' AND length(body) <= 300),
  done         boolean NOT NULL DEFAULT false,
  created_by   uuid REFERENCES caregivers (id) ON DELETE SET NULL,
  done_by      uuid REFERENCES caregivers (id) ON DELETE SET NULL,
  done_at      timestamptz,
  position     integer NOT NULL DEFAULT 0,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- done_at and done_by only make sense on a completed item.
  CONSTRAINT checklist_done_consistent CHECK (done OR (done_at IS NULL AND done_by IS NULL))
);

CREATE INDEX IF NOT EXISTS checklist_open_idx ON checklist_items (done, position, created_at);
CREATE INDEX IF NOT EXISTS checklist_done_at_idx ON checklist_items (done_at DESC);

-- Same triggers as the other tables: updated_at/version stay honest, and every
-- change bumps the revision counter so open clients refetch.
DROP TRIGGER IF EXISTS checklist_touch ON checklist_items;
CREATE TRIGGER checklist_touch BEFORE UPDATE ON checklist_items
  FOR EACH ROW EXECUTE FUNCTION touch_row();

DROP TRIGGER IF EXISTS checklist_sync_revision ON checklist_items;
CREATE TRIGGER checklist_sync_revision
  AFTER INSERT OR UPDATE OR DELETE ON checklist_items
  FOR EACH STATEMENT EXECUTE FUNCTION bump_sync_revision();
