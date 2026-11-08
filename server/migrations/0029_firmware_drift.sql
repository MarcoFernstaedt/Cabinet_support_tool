-- Firmware that differs from what its model's baseline expects (finding F19.R7, decision-log D48). The BIOS version and date are already
-- read into the hardware item of the system configuration category; a baseline for a model can expect them, and drift from that is now a named, minor alert.
-- Detect, alert, hand to a human: flashing firmware stays out of scope.
INSERT INTO issue_types ([id], [key], [name], [severity], [description], [built_in], [scope]) VALUES
  (N'00000000-0000-4000-8000-000000000128', N'firmware_drift', N'Firmware differs from its model''s expectation', N'minor', N'This cabinet''s BIOS version or date is not the one the baseline for its model expects: it is older, or it changed without anyone planning it. The platform does not update firmware; check the model''s approved firmware and update it by hand, or update the baseline if the new firmware is approved.', 1, N'fleet');
GO
