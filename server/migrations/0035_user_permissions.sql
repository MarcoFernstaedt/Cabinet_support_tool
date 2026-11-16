-- Scoped, revocable grants. Rank never implies session access (D98).
CREATE TABLE user_permissions (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  user_id uniqueidentifier NOT NULL REFERENCES users(id),
  permission nvarchar(128) NOT NULL,
  scope_kind nvarchar(16) NOT NULL,
  scope_id uniqueidentifier NULL,
  granted_by uniqueidentifier NOT NULL REFERENCES users(id),
  granted_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
  removed_at datetime2(3) NULL,
  removed_by uniqueidentifier NULL REFERENCES users(id),
  CONSTRAINT user_permissions_scope_check CHECK (
    (scope_kind = 'fleet' AND scope_id IS NULL) OR
    (scope_kind IN ('site', 'cabinet') AND scope_id IS NOT NULL)),
  CONSTRAINT user_permissions_permission_check CHECK (LEN(LTRIM(RTRIM(permission))) BETWEEN 1 AND 128),
  CONSTRAINT user_permissions_removal_check CHECK (
    (removed_at IS NULL AND removed_by IS NULL) OR
    (removed_at IS NOT NULL AND removed_by IS NOT NULL AND removed_at >= granted_at))
);
GO
CREATE UNIQUE INDEX user_permissions_live ON user_permissions(user_id, permission, scope_kind, scope_id) WHERE removed_at IS NULL;
GO
GRANT SELECT, INSERT, UPDATE ON user_permissions TO cabinet_app;
DENY DELETE ON user_permissions TO cabinet_app;
GO
