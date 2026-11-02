-- The audit append procedures, made atomic (docs/platform/decision-log.md, D10). Called outside a transaction, each statement committed
-- on its own: the UPDLOCK, HOLDLOCK on audit_chain_head ended with the SELECT, so two calls could read the same head and take the same
-- sequence number; the duplicate-key error ends only its statement, so the losing call still moved the head, and the head could fall
-- behind the log, after which every append collided with an entry already there. Each procedure now runs in its own transaction with
-- XACT_ABORT on: the chain lock is held until the entry and the head are both written, and any error rolls back both.
-- The bodies are otherwise unchanged; ALTER keeps the procedures' owner and the cabinet_app role's EXECUTE grant.
ALTER PROCEDURE audit_append
  @actor_kind nvarchar(64), @actor_id nvarchar(450), @action nvarchar(450), @target_kind nvarchar(64), @target_id nvarchar(450),
  @outcome nvarchar(64), @details nvarchar(max), @seq bigint OUTPUT
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON; -- any error rolls back the whole append (and dooms a caller's transaction), never half of it
  BEGIN TRANSACTION; -- holds the chain lock until the entry and the head are both written; nests inside a caller's transaction
  DECLARE @prev nvarchar(64), @n bigint, @at datetime2(6) = SYSUTCDATETIME(), @hash nvarchar(64);
  SELECT @prev = [hash], @n = [seq] + 1 FROM audit_chain_head WITH (UPDLOCK, HOLDLOCK) WHERE id = 1; -- serializes the chain
  DECLARE @input nvarchar(max) = CONCAT(@prev, NCHAR(31), CONVERT(nvarchar(20), @n), NCHAR(31), CONVERT(nvarchar(27), @at, 126), NCHAR(31), @actor_kind, NCHAR(31),
    @actor_id, NCHAR(31), @action, NCHAR(31), COALESCE(@target_kind, N''), NCHAR(31), COALESCE(@target_id, N''), NCHAR(31), @outcome, NCHAR(31), @details);
  SET @hash = LOWER(CONVERT(nvarchar(64), HASHBYTES('SHA2_256', @input), 2));
  INSERT INTO audit_log ([seq], [at], [actor_kind], [actor_id], [action], [target_kind], [target_id], [outcome], [details], [prev_hash], [hash])
    VALUES (@n, @at, @actor_kind, @actor_id, @action, @target_kind, @target_id, @outcome, @details, @prev, @hash);
  UPDATE audit_chain_head SET [seq] = @n, [hash] = @hash WHERE id = 1;
  SET @seq = @n;
  COMMIT TRANSACTION;
END
GO

ALTER PROCEDURE audit_append_many
  @entries nvarchar(max), @first bigint OUTPUT, @last bigint OUTPUT
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON; -- any error rolls back the whole append (and dooms a caller's transaction), never half of it
  IF ISJSON(@entries, ARRAY) IS NULL OR ISJSON(@entries, ARRAY) = 0 THROW 50011, 'the audit entries must be a JSON array', 1;
  IF EXISTS (SELECT 1 FROM OPENJSON(@entries) WHERE [type] <> 5) THROW 50011, 'every audit entry must be a JSON object', 1;
  DECLARE @t TABLE (n int PRIMARY KEY, actor_kind nvarchar(64), actor_id nvarchar(450), action nvarchar(450), target_kind nvarchar(64), target_id nvarchar(450),
    outcome nvarchar(64), details nvarchar(max), seq bigint NULL, prev_hash nvarchar(64) NULL, hash nvarchar(64) NULL);
  INSERT INTO @t (n, actor_kind, actor_id, action, target_kind, target_id, outcome, details)
    SELECT CAST(a.[key] AS int), j.actor_kind, j.actor_id, j.action, j.target_kind, j.target_id, j.outcome, j.details
      FROM OPENJSON(@entries) a CROSS APPLY OPENJSON(a.[value]) WITH (actor_kind nvarchar(64) '$.actorKind', actor_id nvarchar(450) '$.actorId', action nvarchar(450) '$.action',
        target_kind nvarchar(64) '$.targetKind', target_id nvarchar(450) '$.targetId', outcome nvarchar(64) '$.outcome', details nvarchar(max) '$.details') j;
  DECLARE @count int = (SELECT COUNT(*) FROM @t);
  IF @count = 0 BEGIN SET @first = NULL; SET @last = NULL; RETURN; END
  DECLARE @prev nvarchar(64), @n bigint, @at datetime2(6) = SYSUTCDATETIME(), @hash nvarchar(64), @input nvarchar(max), @i int = 0;
  BEGIN TRANSACTION; -- after the input checks; holds the chain lock until the entry and the head are both written; nests inside a caller's transaction
  SELECT @prev = [hash], @n = [seq] FROM audit_chain_head WITH (UPDLOCK, HOLDLOCK) WHERE id = 1; -- serializes the chain
  SET @first = @n + 1;
  WHILE @i < @count
  BEGIN
    SET @n = @n + 1;
    SELECT @input = CONCAT(@prev, NCHAR(31), CONVERT(nvarchar(20), @n), NCHAR(31), CONVERT(nvarchar(27), @at, 126), NCHAR(31), actor_kind, NCHAR(31),
      actor_id, NCHAR(31), action, NCHAR(31), COALESCE(target_kind, N''), NCHAR(31), COALESCE(target_id, N''), NCHAR(31), outcome, NCHAR(31), details) FROM @t WHERE n = @i;
    SET @hash = LOWER(CONVERT(nvarchar(64), HASHBYTES('SHA2_256', @input), 2));
    UPDATE @t SET seq = @n, prev_hash = @prev, hash = @hash WHERE n = @i;
    SET @prev = @hash;
    SET @i = @i + 1;
  END
  INSERT INTO audit_log ([seq], [at], [actor_kind], [actor_id], [action], [target_kind], [target_id], [outcome], [details], [prev_hash], [hash])
    SELECT seq, @at, actor_kind, actor_id, action, target_kind, target_id, outcome, details, prev_hash, hash FROM @t ORDER BY n;
  UPDATE audit_chain_head SET [seq] = @n, [hash] = @prev WHERE id = 1;
  SET @last = @n;
  COMMIT TRANSACTION;
END
GO
