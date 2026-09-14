-- Proposed changes to an already-approved shift.
--
-- A caregiver may edit her own shift freely while it is still pending, but once
-- the manager has approved it the schedule is something people rely on. Rather
-- than letting her change it silently, or throwing the approval away, a change
-- is parked on the row as a proposal: the live shift keeps its approved hours
-- until the manager accepts, so nobody turns up at the wrong time in between.
--
-- A proposal is either a change of hours/notes, or "I cannot make it" (cancel).

ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS proposal_kind        text,
  ADD COLUMN IF NOT EXISTS proposed_start_minute integer,
  ADD COLUMN IF NOT EXISTS proposed_end_minute   integer,
  ADD COLUMN IF NOT EXISTS proposed_note         text,
  ADD COLUMN IF NOT EXISTS proposed_by           uuid REFERENCES caregivers (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS proposed_at           timestamptz;

ALTER TABLE shifts DROP CONSTRAINT IF EXISTS shifts_proposal_shape;
ALTER TABLE shifts ADD CONSTRAINT shifts_proposal_shape CHECK (
  -- No proposal: every proposal column is empty.
  (proposal_kind IS NULL
     AND proposed_start_minute IS NULL AND proposed_end_minute IS NULL
     AND proposed_note IS NULL AND proposed_at IS NULL)
  -- A cancellation carries no replacement hours.
  OR (proposal_kind = 'cancel'
     AND proposed_start_minute IS NULL AND proposed_end_minute IS NULL
     AND proposed_at IS NOT NULL)
  -- A change must say what the new hours would be.
  OR (proposal_kind = 'change'
     AND proposed_start_minute IS NOT NULL AND proposed_end_minute IS NOT NULL
     AND proposed_at IS NOT NULL)
);

ALTER TABLE shifts DROP CONSTRAINT IF EXISTS shifts_proposed_minutes;
ALTER TABLE shifts ADD CONSTRAINT shifts_proposed_minutes CHECK (
  (proposed_start_minute IS NULL OR (proposed_start_minute >= 0 AND proposed_start_minute < 1440))
  AND (proposed_end_minute IS NULL OR (proposed_end_minute >= 0 AND proposed_end_minute < 1440))
);

-- The manager's review queue is "everything waiting on me this week".
CREATE INDEX IF NOT EXISTS shifts_pending_proposal_idx
  ON shifts (week_start) WHERE proposal_kind IS NOT NULL;
