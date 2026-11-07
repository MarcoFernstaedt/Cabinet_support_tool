-- Role baselines (finding F7, decision-log D33): a baseline can apply to every cabinet of one role (sync, satellite or standalone),
-- between the fleet's and a model's. The role is the scope's id, and only the three roles are accepted.
ALTER TABLE baselines DROP CONSTRAINT [baselines_scope_kind_check];
GO
ALTER TABLE baselines ADD CONSTRAINT [baselines_scope_kind_check] CHECK (scope_kind IN ('global', 'role', 'model', 'client', 'site', 'cabinet'));
GO
ALTER TABLE baselines ADD CONSTRAINT [baselines_role_check] CHECK (scope_kind <> 'role' OR scope_id IN ('sync', 'satellite', 'standalone'));
GO
