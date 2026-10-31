-- When an Admin last resumed a person's writes (docs/platform hardware test report, 2026-10-30, defect 2). The hourly write limit counts
-- only writes issued after it, so a person resumed after going over the limit is not paused again by the very writes that paused them.
ALTER TABLE users ADD [writes_resumed_at] datetime2(3) NULL;
GO
