-- The healthy mark a cabinet's health points at is never deleted while it does (finding F8.R2, decision-log D40). The prune in
-- cabinet-health.ts already skips it; this makes the database refuse any other deletion of it too. A reference that already points at
-- nothing (none is expected: the mark referenced has always been the newest) is cleared first, so the cabinet reads "no mark" rather
-- than a mark that cannot be found; its last_healthy_at is kept.
-- 0005_baselines.sql said last_mark_id carries no foreign key, because a second cascade path from cabinets is not allowed. That is
-- true of a cascading constraint; this one is NO ACTION, so it adds no cascade path: deleting a cabinet still removes its health
-- row and its marks, as baselines.test.ts and health-mark-reference.test.ts both do.
UPDATE h SET last_mark_id = NULL
  FROM cabinet_health h
 WHERE h.last_mark_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM healthy_marks m WHERE m.id = h.last_mark_id);
GO
ALTER TABLE cabinet_health ADD CONSTRAINT [cabinet_health_last_mark_fkey] FOREIGN KEY ([last_mark_id]) REFERENCES healthy_marks([id]);
GO
CREATE INDEX cabinet_health_by_mark ON cabinet_health ([last_mark_id]) WHERE [last_mark_id] IS NOT NULL;
GO
