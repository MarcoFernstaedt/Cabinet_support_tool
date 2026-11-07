-- Site installers (finding F6.R1, decision-log D35): one bootstrap token several cabinets of one site (and, optionally, one role) can use.
-- The Admin sets how many cabinets it is for (1 to 100) and for how long (up to 30 days, in code); it stops at either limit and can be
-- revoked early. Every cabinet that uses it still waits for an Admin's approval. A token with no site is the one-cabinet token it always was.
ALTER TABLE bootstrap_tokens ADD
  [site_id] uniqueidentifier NULL,
  [role] nvarchar(16) NULL,
  [max_uses] int NOT NULL CONSTRAINT [bootstrap_tokens_max_uses_default] DEFAULT 1,
  [uses] int NOT NULL CONSTRAINT [bootstrap_tokens_uses_default] DEFAULT 0,
  [revoked_at] datetime2(3) NULL,
  [revoked_by] uniqueidentifier NULL;
GO
UPDATE bootstrap_tokens SET uses = CASE WHEN used_at IS NULL THEN 0 ELSE 1 END;
GO
ALTER TABLE bootstrap_tokens ADD
  CONSTRAINT [bootstrap_tokens_site_fkey] FOREIGN KEY ([site_id]) REFERENCES sites([id]),
  CONSTRAINT [bootstrap_tokens_revoked_by_fkey] FOREIGN KEY ([revoked_by]) REFERENCES users([id]),
  CONSTRAINT [bootstrap_tokens_role_check] CHECK (role IS NULL OR (site_id IS NOT NULL AND role IN ('sync', 'satellite', 'standalone'))),
  CONSTRAINT [bootstrap_tokens_uses_check] CHECK (max_uses BETWEEN 1 AND 100 AND uses BETWEEN 0 AND max_uses AND (site_id IS NOT NULL OR max_uses = 1));
GO
-- One request per token held only while a token was for one cabinet.
ALTER TABLE enrollment_requests DROP CONSTRAINT [enrollment_requests_token_id_key];
GO
CREATE INDEX enrollment_requests_token ON enrollment_requests ([token_id]);
GO
