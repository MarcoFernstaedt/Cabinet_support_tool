-- Fixes from the repository review.

-- Certificate renewal: a renewed certificate remembers the one it replaced. The first time the new one is used, the old
-- one is revoked, so a copied certificate stops working once the real agent has moved on, and cannot renew itself again.
ALTER TABLE cabinet_certificates
  ADD COLUMN renewed_from  text REFERENCES cabinet_certificates(serial),
  ADD COLUMN first_used_at timestamptz;
CREATE INDEX cabinet_certificates_renewed_from ON cabinet_certificates (renewed_from) WHERE renewed_from IS NOT NULL;

-- Retention deletes and "same error elsewhere" look events up by when they arrived; 0003 indexed when they occurred.
CREATE INDEX events_received_at ON events (received_at);

-- A cabinet's command history and the package-download check look commands up by cabinet; the only index was for queued ones.
CREATE INDEX commands_cabinet_issued ON commands (cabinet_id, issued_at DESC);

-- Delivered commands that never got a result are marked expired after a while (the minute job looks only at these).
CREATE INDEX commands_delivered ON commands (delivered_at) WHERE status = 'delivered';
