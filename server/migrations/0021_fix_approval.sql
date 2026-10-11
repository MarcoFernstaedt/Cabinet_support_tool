-- A known fix a member submits waits for approval before everyone sees it. An Admin approves, or a Tier 2 who has been granted that.
ALTER TABLE users ADD COLUMN can_approve_fixes boolean NOT NULL DEFAULT false;
ALTER TABLE known_fixes
  ADD COLUMN status      text NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN reviewed_by uuid REFERENCES users(id),
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN review_note text CHECK (review_note IS NULL OR length(review_note) <= 256);
CREATE INDEX known_fixes_pending ON known_fixes (created_at) WHERE status = 'pending' AND removed_at IS NULL;
