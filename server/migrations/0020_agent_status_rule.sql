-- The agent's own status reports (kind agent_status: "N more entries from <log> were not sent: the log is being flooded", a dropped
-- or set-aside queue, a fault reported as a code) had no rule, so each one surfaced as "Unrecognized agent status event" and could
-- not be told apart from an event nobody knows (product test 2026-11-02, finding 5). They are the agent reporting on itself: the
-- built-in "Agent problem" issue type (minor), which existed with no rule raising it.
INSERT INTO symptom_rules ([id], [issue_type_id], [kind], [state], [version], [match], [regroup], [built_in], [severity]) VALUES
  (N'00000000-0000-4000-8000-000000000380', N'00000000-0000-4000-8000-000000000107', N'map', N'live', 1, N'{"kind":"agent_status"}', 0, 1, NULL);
GO
INSERT INTO symptom_rule_history ([rule_id], [version], [change], [state], [issue_type_id], [match], [severity]) VALUES
  (N'00000000-0000-4000-8000-000000000380', 1, N'created', N'live', N'00000000-0000-4000-8000-000000000107', N'{"kind":"agent_status"}', NULL);
GO
