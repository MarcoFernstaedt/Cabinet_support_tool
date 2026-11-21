-- An error's source and event ID as indexed columns (F21.R4, decision-log D138). "The same error elsewhere" on an event's detail view
-- counted the cabinets that reported the same log, source and event ID in the last 30 days by reading every event in the window and
-- opening its JSON source: 2 to 4 s at 2 million events. Through this index it reads the matching events only: 6 ms. Computed and not
-- stored, so the table itself is unchanged; the index holds the values. 0035 to 0037 are feat/remote-access-tunnel's own migrations.
ALTER TABLE events ADD [err_source] AS CAST(JSON_VALUE([source], '$.source') AS nvarchar(512)),
                       [err_event_id] AS TRY_CAST(JSON_VALUE([source], '$.eventId') AS int);
GO
-- Only events that still have their source: after 30 days most lose it (clearOldEventDetail), and the view looks back 30 days.
CREATE INDEX events_error_key ON events ([err_event_id], [err_source], [occurred_at]) INCLUDE ([cabinet_id]) WHERE [source] IS NOT NULL
  WITH (DATA_COMPRESSION = PAGE);
GO
