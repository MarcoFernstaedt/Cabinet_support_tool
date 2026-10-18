-- Protocol 1.1 (docs/spec/03-protocol.md "Protocol 1.1"): leased command delivery, and presence from the long poll.

-- A command handed to a poll is leased until lease_until; the agent acknowledges it (ack_at) on its next poll, or its result
-- arrives. One that is neither acknowledged nor answered when the lease ends is offered again while it has not expired.
ALTER TABLE commands ADD [ack_at] datetime2(3) NULL, [lease_until] datetime2(3) NULL;
GO

-- last_heartbeat_at is now the last contact (a heartbeat, or a long poll written in a batch each minute), so every "offline after
-- 5 minutes" judgement counts polls too. uptime_at is when uptime_seconds was reported, which boot detection needs.
ALTER TABLE cabinets ADD [uptime_at] datetime2(3) NULL;
GO

CREATE INDEX commands_leased ON commands ([cabinet_id], [lease_until]) WHERE status = 'delivered' AND ack_at IS NULL AND result_at IS NULL;
GO

-- The expiring-certificate check: a security alert a week before an unrenewed certificate expires.
CREATE INDEX cabinet_certificates_not_after ON cabinet_certificates ([not_after]) INCLUDE ([cabinet_id]) WHERE revoked_at IS NULL;
GO
