-- The platform database on Microsoft SQL Server 2022 (docs/spec/05-server-spec.md). One baseline: nothing was ever deployed
-- on the earlier PostgreSQL schema, so the 25 incremental PostgreSQL migrations were folded into this final shape.
-- Conventions: identifiers keep their names; uuid is uniqueidentifier; times are datetime2 in UTC; JSON is nvarchar(max)
-- with an ISJSON check; arrays are JSON arrays; text that is indexed is nvarchar(450) at most.
-- Regular expression checks became LIKE patterns; the contracts (JSON Schemas) remain the strict check, every input is validated before it reaches here.

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'cabinet_app' AND type = 'R') CREATE ROLE cabinet_app;
GO

CREATE TABLE users (
  [id] uniqueidentifier NOT NULL,
  [username] nvarchar(450) NOT NULL,
  [name] nvarchar(128) NOT NULL,
  [role] nvarchar(64) NOT NULL,
  [status] nvarchar(64) DEFAULT 'active' NOT NULL,
  [created_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [password_hash] nvarchar(max) NULL,
  [must_change_password] bit DEFAULT 1 NOT NULL,
  [totp_secret_enc] varbinary(256) NULL,
  [totp_enabled] bit DEFAULT 0 NOT NULL,
  [totp_last_step] bigint NULL,
  [failed_logins] int DEFAULT 0 NOT NULL,
  [locked_until] datetime2(3) NULL,
  [last_login_at] datetime2(3) NULL,
  [write_limit] int DEFAULT 20 NOT NULL,
  [tour_completed] bit DEFAULT 0 NOT NULL,
  [writes_paused] bit DEFAULT 0 NOT NULL,
  [writes_paused_reason] nvarchar(max) NULL,
  [can_approve_fixes] bit DEFAULT 0 NOT NULL,
  CONSTRAINT [users_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [users_username_key] UNIQUE ([username]),
  CONSTRAINT [users_name_check] CHECK (((LEN(name) >= 1) AND (LEN(name) <= 128))),
  CONSTRAINT [users_role_check] CHECK (role IN ('tier1', 'tier2', 'admin')),
  CONSTRAINT [users_status_check] CHECK (status IN ('active', 'disabled', 'deleted')),
  CONSTRAINT [users_username_check] CHECK (LEN(username) BETWEEN 2 AND 64 AND username COLLATE Latin1_General_100_BIN2 NOT LIKE '%[^a-z0-9._-]%')
);
GO

CREATE TABLE agent_releases (
  [version] nvarchar(450) NOT NULL,
  [manifest] varbinary(4096) NOT NULL,
  [signature] nvarchar(max) NOT NULL,
  [key_id] nvarchar(max) NOT NULL,
  [minimum_version] nvarchar(max) NOT NULL,
  [sha256] nvarchar(max) NOT NULL,
  [size_bytes] bigint NOT NULL,
  [released_at] datetime2(3) NOT NULL,
  [notes] nvarchar(max) NULL,
  [state] nvarchar(64) NOT NULL,
  [refusal] nvarchar(max) NULL,
  [added_by] uniqueidentifier NOT NULL,
  [added_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [package_at] datetime2(3) NULL,
  CONSTRAINT [agent_releases_pkey] PRIMARY KEY ([version]),
  CONSTRAINT [agent_releases_signature_json] CHECK ([signature] IS NULL OR ISJSON([signature], VALUE) = 1),
  CONSTRAINT [agent_releases_manifest_check] CHECK ((LEN(manifest) <= 4096)),
  CONSTRAINT [agent_releases_sha256_check] CHECK (LEN(sha256) = 64 AND sha256 COLLATE Latin1_General_100_BIN2 NOT LIKE '%[^0-9a-f]%'),
  CONSTRAINT [agent_releases_size_bytes_check] CHECK ((size_bytes > 0)),
  CONSTRAINT [agent_releases_state_check] CHECK (state IN ('awaiting_package', 'ready', 'refused')),
  CONSTRAINT [agent_releases_version_check] CHECK (LEN(version) BETWEEN 5 AND 48 AND version COLLATE Latin1_General_100_BIN2 NOT LIKE '%[^0-9A-Za-z.-]%' AND version LIKE '[0-9]%.[0-9]%.[0-9]%')
);
GO

CREATE TABLE clients (
  [id] uniqueidentifier NOT NULL,
  [name] nvarchar(128) NOT NULL,
  [write_paused] bit DEFAULT 0 NOT NULL,
  [created_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [write_pause_reason] nvarchar(max) NULL,
  [removed_at] datetime2(3) NULL,
  [scanner_hardware_ids] nvarchar(max) NULL,
  [sync_ports] nvarchar(max) NULL,
  [firewall_policy] nvarchar(max) NULL,
  [watched_services] nvarchar(max) NULL,
  [demo] bit DEFAULT 0 NOT NULL,
  CONSTRAINT [clients_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [clients_scanner_hardware_ids_json] CHECK ([scanner_hardware_ids] IS NULL OR ISJSON([scanner_hardware_ids], VALUE) = 1),
  CONSTRAINT [clients_sync_ports_json] CHECK ([sync_ports] IS NULL OR ISJSON([sync_ports], VALUE) = 1),
  CONSTRAINT [clients_firewall_policy_json] CHECK ([firewall_policy] IS NULL OR ISJSON([firewall_policy], VALUE) = 1),
  CONSTRAINT [clients_watched_services_json] CHECK ([watched_services] IS NULL OR ISJSON([watched_services], VALUE) = 1),
  CONSTRAINT [clients_name_check] CHECK (((LEN(name) >= 1) AND (LEN(name) <= 128))),
  CONSTRAINT [clients_sync_ports_check] CHECK (sync_ports IS NULL OR JSON_VALUE(sync_ports, '$[4]') IS NULL),
  CONSTRAINT [clients_watched_services_check] CHECK (((watched_services IS NULL) OR (JSON_VALUE(watched_services, '$[16]') IS NULL)))
);
GO

CREATE TABLE sites (
  [id] uniqueidentifier NOT NULL,
  [client_id] uniqueidentifier NOT NULL,
  [name] nvarchar(128) NOT NULL,
  [created_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [sync_address] nvarchar(max) NULL,
  [sync_ports] nvarchar(max) NULL,
  [removed_at] datetime2(3) NULL,
  [scanner_hardware_ids] nvarchar(max) NULL,
  [watched_services] nvarchar(max) NULL,
  [time_zone] nvarchar(64) NULL,
  [network_baseline] nvarchar(max) NULL,
  CONSTRAINT [sites_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [sites_sync_ports_json] CHECK ([sync_ports] IS NULL OR ISJSON([sync_ports], VALUE) = 1),
  CONSTRAINT [sites_scanner_hardware_ids_json] CHECK ([scanner_hardware_ids] IS NULL OR ISJSON([scanner_hardware_ids], VALUE) = 1),
  CONSTRAINT [sites_watched_services_json] CHECK ([watched_services] IS NULL OR ISJSON([watched_services], VALUE) = 1),
  CONSTRAINT [sites_network_baseline_json] CHECK ([network_baseline] IS NULL OR ISJSON([network_baseline], VALUE) = 1),
  CONSTRAINT [sites_name_check] CHECK (((LEN(name) >= 1) AND (LEN(name) <= 128))),
  CONSTRAINT [sites_sync_address_check] CHECK (sync_address IS NULL OR (LEN(sync_address) BETWEEN 7 AND 15 AND sync_address NOT LIKE '%[^0-9.]%' AND sync_address LIKE '%.%.%.%' AND sync_address NOT LIKE '%.%.%.%.%' AND sync_address NOT LIKE '%..%' AND sync_address NOT LIKE '.%' AND sync_address NOT LIKE '%.')),
  CONSTRAINT [sites_sync_ports_check] CHECK (sync_ports IS NULL OR JSON_VALUE(sync_ports, '$[4]') IS NULL),
  CONSTRAINT [sites_time_zone_check] CHECK (time_zone IN ('Eastern Standard Time', 'Central Standard Time', 'Mountain Standard Time', 'US Mountain Standard Time', 'Pacific Standard Time', 'Alaskan Standard Time', 'Hawaiian Standard Time')),
  CONSTRAINT [sites_watched_services_check] CHECK (((watched_services IS NULL) OR (JSON_VALUE(watched_services, '$[16]') IS NULL)))
);
GO

CREATE TABLE cabinets (
  [id] uniqueidentifier NOT NULL,
  [site_id] uniqueidentifier NOT NULL,
  [name] nvarchar(128) NOT NULL,
  [role] nvarchar(64) NOT NULL,
  [status] nvarchar(64) NOT NULL,
  [hostname] nvarchar(max) NULL,
  [serial_number] nvarchar(max) NULL,
  [read_only] bit NULL,
  [agent_version] nvarchar(max) NULL,
  [uptime_seconds] bigint NULL,
  [clock_skew_seconds] float NULL,
  [last_heartbeat_at] datetime2(3) NULL,
  [created_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [scanner_hardware_ids] nvarchar(max) NULL,
  [in_office] bit DEFAULT 0 NOT NULL,
  [firewall_profiles] nvarchar(max) NULL,
  [watched_services] nvarchar(max) NULL,
  [demo_scenario] nvarchar(max) NULL,
  [time_zone_id] nvarchar(64) NULL,
  [demo_net] nvarchar(max) NULL,
  [ipv4] nvarchar(15) NULL,
  [ipv4_at] datetime2(3) NULL,
  CONSTRAINT [cabinets_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [cabinets_site_id_name_key] UNIQUE ([site_id], [name]),
  CONSTRAINT [cabinets_scanner_hardware_ids_json] CHECK ([scanner_hardware_ids] IS NULL OR ISJSON([scanner_hardware_ids], VALUE) = 1),
  CONSTRAINT [cabinets_firewall_profiles_json] CHECK ([firewall_profiles] IS NULL OR ISJSON([firewall_profiles], VALUE) = 1),
  CONSTRAINT [cabinets_watched_services_json] CHECK ([watched_services] IS NULL OR ISJSON([watched_services], VALUE) = 1),
  CONSTRAINT [cabinets_demo_net_json] CHECK ([demo_net] IS NULL OR ISJSON([demo_net], VALUE) = 1),
  CONSTRAINT [cabinets_demo_scenario_check] CHECK (demo_scenario IS NULL OR (LEN(demo_scenario) BETWEEN 1 AND 32 AND demo_scenario COLLATE Latin1_General_100_BIN2 NOT LIKE '%[^a-z_]%')),
  CONSTRAINT [cabinets_ipv4_check] CHECK (ipv4 IS NULL OR LEN(ipv4) <= 15),
  CONSTRAINT [cabinets_name_check] CHECK (((LEN(name) >= 1) AND (LEN(name) <= 128))),
  CONSTRAINT [cabinets_role_check] CHECK (role IN ('sync', 'satellite', 'standalone')),
  CONSTRAINT [cabinets_status_check] CHECK (status IN ('pending', 'active', 'removed')),
  CONSTRAINT [cabinets_time_zone_id_check] CHECK (((LEN(time_zone_id) >= 1) AND (LEN(time_zone_id) <= 64))),
  CONSTRAINT [cabinets_watched_services_check] CHECK (((watched_services IS NULL) OR (JSON_VALUE(watched_services, '$[16]') IS NULL)))
);
GO

CREATE TABLE issue_types (
  [id] uniqueidentifier DEFAULT NEWID() NOT NULL,
  [key] nvarchar(450) NULL,
  [name] nvarchar(128) NOT NULL,
  [severity] nvarchar(64) NOT NULL,
  [description] nvarchar(1024) NOT NULL,
  [built_in] bit DEFAULT 0 NOT NULL,
  [created_by] uniqueidentifier NULL,
  [created_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [scope] nvarchar(64) DEFAULT 'fleet' NOT NULL,
  CONSTRAINT [issue_types_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [issue_types_key_key] UNIQUE ([key]),
  CONSTRAINT [issue_types_name_key] UNIQUE ([name]),
  CONSTRAINT [issue_types_description_check] CHECK ((LEN(description) <= 1024)),
  CONSTRAINT [issue_types_name_check] CHECK (((LEN(name) >= 1) AND (LEN(name) <= 128))),
  CONSTRAINT [issue_types_scope_check] CHECK (scope IN ('fleet', 'cabinet')),
  CONSTRAINT [issue_types_severity_check] CHECK (severity IN ('major', 'minor'))
);
GO

CREATE TABLE symptom_rules (
  [id] uniqueidentifier DEFAULT NEWID() NOT NULL,
  [issue_type_id] uniqueidentifier NULL,
  [kind] nvarchar(64) NOT NULL,
  [state] nvarchar(64) NOT NULL,
  [version] int DEFAULT 1 NOT NULL,
  [match] nvarchar(max) NOT NULL,
  [regroup] bit DEFAULT 0 NOT NULL,
  [built_in] bit DEFAULT 0 NOT NULL,
  [proposed_by] uniqueidentifier NULL,
  [approved_by] uniqueidentifier NULL,
  [reason] nvarchar(max) NULL,
  [expires_at] datetime2(3) NULL,
  [created_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [updated_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [matched_count] bigint DEFAULT 0 NOT NULL,
  [severity] nvarchar(64) NULL,
  CONSTRAINT [symptom_rules_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [symptom_rules_match_json] CHECK ([match] IS NULL OR ISJSON([match], VALUE) = 1),
  CONSTRAINT [symptom_rules_check] CHECK ((kind = 'map' AND issue_type_id IS NOT NULL) OR (kind <> 'map' AND issue_type_id IS NULL)),
  CONSTRAINT [symptom_rules_kind_check] CHECK (kind IN ('map', 'suppress')),
  CONSTRAINT [symptom_rules_severity_check] CHECK (((severity IS NULL) OR severity IN ('major', 'minor'))),
  CONSTRAINT [symptom_rules_state_check] CHECK (state IN ('proposed', 'live', 'disabled', 'expired', 'rejected'))
);
GO

CREATE TABLE alerts (
  [id] uniqueidentifier DEFAULT NEWID() NOT NULL,
  [cabinet_id] uniqueidentifier NOT NULL,
  [issue_type_id] uniqueidentifier NULL,
  [severity] nvarchar(64) NOT NULL,
  [signature] nvarchar(450) NOT NULL,
  [title] nvarchar(max) NOT NULL,
  [state] nvarchar(64) DEFAULT 'open' NOT NULL,
  [occurrences] int DEFAULT 1 NOT NULL,
  [first_seen] datetime2(3) NOT NULL,
  [last_seen] datetime2(3) NOT NULL,
  [site_pattern] bit DEFAULT 0 NOT NULL,
  [rule_id] uniqueidentifier NULL,
  [last_event_id] uniqueidentifier NULL,
  [claimed_by] uniqueidentifier NULL,
  [claimed_at] datetime2(3) NULL,
  [resolved_by] uniqueidentifier NULL,
  [resolved_at] datetime2(3) NULL,
  [resolution] nvarchar(max) NULL,
  [created_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [scope] nvarchar(64) DEFAULT 'fleet' NOT NULL,
  CONSTRAINT [alerts_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [alerts_scope_check] CHECK (scope IN ('fleet', 'cabinet')),
  CONSTRAINT [alerts_severity_check] CHECK (severity IN ('major', 'minor')),
  CONSTRAINT [alerts_state_check] CHECK (state IN ('open', 'claimed', 'resolved'))
);
GO

CREATE TABLE audit_chain_head (
  [id] int NOT NULL,
  [seq] bigint NOT NULL,
  [hash] nvarchar(64) NOT NULL,
  CONSTRAINT [audit_chain_head_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [audit_chain_head_id_check] CHECK ((id = 1))
);
GO

CREATE TABLE audit_log (
  [seq] bigint NOT NULL,
  [at] datetime2(6) NOT NULL,
  [actor_kind] nvarchar(64) NOT NULL,
  [actor_id] nvarchar(450) NOT NULL,
  [action] nvarchar(450) NOT NULL,
  [target_kind] nvarchar(max) NULL,
  [target_id] nvarchar(450) NULL,
  [outcome] nvarchar(max) NOT NULL,
  [details] nvarchar(max) NOT NULL,
  [prev_hash] nvarchar(64) NOT NULL,
  [hash] nvarchar(64) NOT NULL,
  CONSTRAINT [audit_log_pkey] PRIMARY KEY ([seq]),
  CONSTRAINT [audit_log_details_json] CHECK ([details] IS NULL OR ISJSON([details], VALUE) = 1),
  CONSTRAINT [audit_log_actor_kind_check] CHECK (actor_kind IN ('user', 'agent', 'system'))
);
GO

CREATE TABLE bootstrap_tokens (
  [id] uniqueidentifier NOT NULL,
  [token_hash] varbinary(64) NOT NULL,
  [created_by] uniqueidentifier NOT NULL,
  [created_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [expires_at] datetime2(3) NOT NULL,
  [used_at] datetime2(3) NULL,
  CONSTRAINT [bootstrap_tokens_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [bootstrap_tokens_token_hash_key] UNIQUE ([token_hash])
);
GO

CREATE TABLE cabinet_boots (
  [cabinet_id] uniqueidentifier NOT NULL,
  [booted_at] datetime2(3) NOT NULL,
  [source] nvarchar(64) NOT NULL,
  CONSTRAINT [cabinet_boots_pkey] PRIMARY KEY ([cabinet_id], [booted_at]),
  CONSTRAINT [cabinet_boots_source_check] CHECK (source IN ('heartbeat', 'event'))
);
GO

CREATE TABLE cabinet_certificates (
  [serial] nvarchar(450) NOT NULL,
  [cabinet_id] uniqueidentifier NOT NULL,
  [issued_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [not_after] datetime2(3) NOT NULL,
  [revoked_at] datetime2(3) NULL,
  [renewed_from] nvarchar(450) NULL,
  [first_used_at] datetime2(3) NULL,
  CONSTRAINT [cabinet_certificates_pkey] PRIMARY KEY ([serial]),
  CONSTRAINT [cabinet_certificates_serial_check] CHECK (LEN(serial) BETWEEN 2 AND 64 AND serial COLLATE Latin1_General_100_BIN2 NOT LIKE '%[^0-9A-F]%')
);
GO

CREATE TABLE commands (
  [id] uniqueidentifier NOT NULL,
  [cabinet_id] uniqueidentifier NOT NULL,
  [operation] nvarchar(450) NOT NULL,
  [params] nvarchar(max) NOT NULL,
  [issued_by] uniqueidentifier NOT NULL,
  [issued_at] datetime2(3) NOT NULL,
  [expires_at] datetime2(3) NOT NULL,
  [status] nvarchar(64) NOT NULL,
  [delivered_at] datetime2(3) NULL,
  [result] nvarchar(max) NULL,
  [result_at] datetime2(3) NULL,
  [bulk_id] uniqueidentifier NULL,
  CONSTRAINT [commands_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [commands_params_json] CHECK ([params] IS NULL OR ISJSON([params], VALUE) = 1),
  CONSTRAINT [commands_result_json] CHECK ([result] IS NULL OR ISJSON([result], VALUE) = 1),
  CONSTRAINT [commands_check] CHECK ((expires_at > issued_at)),
  CONSTRAINT [commands_status_check] CHECK (status IN ('queued', 'delivered', 'succeeded', 'failed', 'rejected', 'expired'))
);
GO

CREATE TABLE diagnosis_batches (
  [id] uniqueidentifier NOT NULL,
  [created_by] uniqueidentifier NOT NULL,
  [created_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [label] nvarchar(200) NOT NULL,
  [site_id] uniqueidentifier NULL,
  [cabinet_ids] nvarchar(max) NOT NULL,
  [total] int NOT NULL,
  CONSTRAINT [diagnosis_batches_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [diagnosis_batches_cabinet_ids_json] CHECK ([cabinet_ids] IS NULL OR ISJSON([cabinet_ids], VALUE) = 1),
  CONSTRAINT [diagnosis_batches_label_check] CHECK (((LEN(label) >= 1) AND (LEN(label) <= 200))),
  CONSTRAINT [diagnosis_batches_total_check] CHECK (((total >= 1) AND (total <= 60)))
);
GO

CREATE TABLE diagnoses (
  [id] uniqueidentifier NOT NULL,
  [cabinet_id] uniqueidentifier NOT NULL,
  [kind] nvarchar(max) NOT NULL,
  [run_by] uniqueidentifier NOT NULL,
  [started_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [finished_at] datetime2(3) NULL,
  [state] nvarchar(64) NOT NULL,
  [commands] nvarchar(max) DEFAULT '[]' NOT NULL,
  [findings] nvarchar(max) NULL,
  [failure] nvarchar(max) NULL,
  [batch_id] uniqueidentifier NULL,
  [readings] nvarchar(max) NULL,
  CONSTRAINT [diagnoses_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [diagnoses_commands_json] CHECK ([commands] IS NULL OR ISJSON([commands], VALUE) = 1),
  CONSTRAINT [diagnoses_findings_json] CHECK ([findings] IS NULL OR ISJSON([findings], VALUE) = 1),
  CONSTRAINT [diagnoses_readings_json] CHECK ([readings] IS NULL OR ISJSON([readings], VALUE) = 1),
  CONSTRAINT [diagnoses_kind_check] CHECK ((kind = 'network')),
  CONSTRAINT [diagnoses_state_check] CHECK (state IN ('running', 'done', 'failed', 'offline'))
);
GO

CREATE TABLE drive_samples (
  [cabinet_id] uniqueidentifier NOT NULL,
  [drive_key] nvarchar(256) NOT NULL,
  [at] datetime2(3) NOT NULL,
  [model] nvarchar(max) NULL,
  [serial_number] nvarchar(max) NULL,
  [health] nvarchar(64) NOT NULL,
  [predict_failure] bit NULL,
  [temperature_c] int NULL,
  [power_on_hours] bigint NULL,
  [reallocated] bigint NULL,
  [pending] bigint NULL,
  [uncorrectable] bigint NULL,
  [wear_percent] int NULL,
  CONSTRAINT [drive_samples_pkey] PRIMARY KEY ([cabinet_id], [drive_key], [at]),
  CONSTRAINT [drive_samples_drive_key_check] CHECK (((LEN(drive_key) >= 1) AND (LEN(drive_key) <= 256))),
  CONSTRAINT [drive_samples_health_check] CHECK (health IN ('healthy', 'warning', 'failing', 'unknown'))
);
GO

CREATE TABLE drive_status (
  [cabinet_id] uniqueidentifier NOT NULL,
  [drive_key] nvarchar(450) NOT NULL,
  [model] nvarchar(max) NULL,
  [level] nvarchar(64) NOT NULL,
  [reasons] nvarchar(max) DEFAULT '[]' NOT NULL,
  [projection] nvarchar(max) DEFAULT '{}' NOT NULL,
  [assessed_at] datetime2(3) NOT NULL,
  CONSTRAINT [drive_status_pkey] PRIMARY KEY ([cabinet_id], [drive_key]),
  CONSTRAINT [drive_status_reasons_json] CHECK ([reasons] IS NULL OR ISJSON([reasons], VALUE) = 1),
  CONSTRAINT [drive_status_projection_json] CHECK ([projection] IS NULL OR ISJSON([projection], VALUE) = 1),
  CONSTRAINT [drive_status_level_check] CHECK (level IN ('ok', 'watch', 'act', 'urgent'))
);
GO

CREATE TABLE enrollment_requests (
  [id] uniqueidentifier NOT NULL,
  [token_id] uniqueidentifier NOT NULL,
  [csr] nvarchar(max) NOT NULL,
  [fingerprints] nvarchar(max) NOT NULL,
  [source_address] nvarchar(max) NULL,
  [status] nvarchar(64) NOT NULL,
  [cabinet_id] uniqueidentifier NULL,
  [certificate_serial] nvarchar(450) NULL,
  [certificate_pem] nvarchar(max) NULL,
  [decided_by] uniqueidentifier NULL,
  [decided_at] datetime2(3) NULL,
  [created_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  CONSTRAINT [enrollment_requests_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [enrollment_requests_token_id_key] UNIQUE ([token_id]),
  CONSTRAINT [enrollment_requests_fingerprints_json] CHECK ([fingerprints] IS NULL OR ISJSON([fingerprints], VALUE) = 1),
  CONSTRAINT [enrollment_requests_status_check] CHECK (status IN ('pending', 'rejected', 'issued'))
);
GO

CREATE TABLE events (
  [event_id] uniqueidentifier NOT NULL,
  [cabinet_id] uniqueidentifier NOT NULL,
  [kind] nvarchar(max) NOT NULL,
  [occurred_at] datetime2(3) NOT NULL,
  [received_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [source] nvarchar(max) NULL,
  [command_id] uniqueidentifier NULL,
  [severity_hint] nvarchar(max) NULL,
  [detail] nvarchar(max) NULL,
  [matched_rule] uniqueidentifier NULL,
  [device] nvarchar(max) NULL,
  [alert_id] uniqueidentifier NULL,
  CONSTRAINT [events_pkey] PRIMARY KEY ([event_id]),
  CONSTRAINT [events_source_json] CHECK ([source] IS NULL OR ISJSON([source], VALUE) = 1),
  CONSTRAINT [events_detail_json] CHECK ([detail] IS NULL OR ISJSON([detail], VALUE) = 1),
  CONSTRAINT [events_device_json] CHECK ([device] IS NULL OR ISJSON([device], VALUE) = 1)
);
GO

CREATE TABLE firewall_changes (
  [id] uniqueidentifier DEFAULT NEWID() NOT NULL,
  [cabinet_id] uniqueidentifier NOT NULL,
  [command_id] uniqueidentifier NULL,
  [event_id] uniqueidentifier NULL,
  [explained] bit NOT NULL,
  [operation] nvarchar(max) NULL,
  [before] nvarchar(max) NULL,
  [after] nvarchar(max) NULL,
  [detail] nvarchar(max) NULL,
  [occurred_at] datetime2(3) NOT NULL,
  [recorded_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  CONSTRAINT [firewall_changes_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [firewall_changes_before_json] CHECK ([before] IS NULL OR ISJSON([before], VALUE) = 1),
  CONSTRAINT [firewall_changes_after_json] CHECK ([after] IS NULL OR ISJSON([after], VALUE) = 1),
  CONSTRAINT [firewall_changes_detail_json] CHECK ([detail] IS NULL OR ISJSON([detail], VALUE) = 1)
);
GO

CREATE TABLE fleet_jobs (
  [id] uniqueidentifier NOT NULL,
  [operation] nvarchar(64) NOT NULL,
  [created_by] uniqueidentifier NOT NULL,
  [created_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [batch_size] int NOT NULL,
  [total] int NOT NULL,
  [state] nvarchar(64) DEFAULT 'running' NOT NULL,
  [cancelled_by] uniqueidentifier NULL,
  [finished_at] datetime2(3) NULL,
  CONSTRAINT [fleet_jobs_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [fleet_jobs_batch_size_check] CHECK (((batch_size >= 1) AND (batch_size <= 50))),
  CONSTRAINT [fleet_jobs_operation_check] CHECK (operation IN ('time.setZone', 'time.sync', 'firewall.applyPolicy', 'network.setDns', 'network.setIp', 'network.renewLease')),
  CONSTRAINT [fleet_jobs_state_check] CHECK (state IN ('running', 'done', 'cancelled')),
  CONSTRAINT [fleet_jobs_total_check] CHECK (((total >= 1) AND (total <= 200)))
);
GO

CREATE TABLE fleet_job_targets (
  [job_id] uniqueidentifier NOT NULL,
  [cabinet_id] uniqueidentifier NOT NULL,
  [position] int NOT NULL,
  [params] nvarchar(max) NULL,
  [state] nvarchar(64) NOT NULL,
  [command_id] uniqueidentifier NULL,
  [detail] nvarchar(300) NULL,
  [updated_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  CONSTRAINT [fleet_job_targets_pkey] PRIMARY KEY ([job_id], [cabinet_id]),
  CONSTRAINT [fleet_job_targets_params_json] CHECK ([params] IS NULL OR ISJSON([params], VALUE) = 1),
  CONSTRAINT [fleet_job_targets_detail_check] CHECK ((LEN(detail) <= 300)),
  CONSTRAINT [fleet_job_targets_state_check] CHECK (state IN ('pending', 'skipped', 'issued', 'succeeded', 'failed', 'verified', 'not_verified', 'cancelled'))
);
GO

CREATE TABLE health_samples (
  [cabinet_id] uniqueidentifier NOT NULL,
  [at] datetime2(3) NOT NULL,
  [cpu_percent] smallint NOT NULL,
  [memory_used_percent] smallint NOT NULL,
  [disk_free_percent] smallint NOT NULL,
  CONSTRAINT [health_samples_pkey] PRIMARY KEY ([cabinet_id], [at]),
  CONSTRAINT [health_samples_cpu_percent_check] CHECK (((cpu_percent >= 0) AND (cpu_percent <= 100))),
  CONSTRAINT [health_samples_disk_free_percent_check] CHECK (((disk_free_percent >= 0) AND (disk_free_percent <= 100))),
  CONSTRAINT [health_samples_memory_used_percent_check] CHECK (((memory_used_percent >= 0) AND (memory_used_percent <= 100)))
);
GO

CREATE TABLE known_fixes (
  [id] uniqueidentifier NOT NULL,
  [title] nvarchar(256) NOT NULL,
  [solution] nvarchar(2000) NOT NULL,
  [finding_key] nvarchar(450) NULL,
  [issue_type_id] uniqueidentifier NULL,
  [environment] nvarchar(max) NOT NULL,
  [cabinet_id] uniqueidentifier NULL,
  [created_by] uniqueidentifier NOT NULL,
  [created_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [seen_count] int DEFAULT 0 NOT NULL,
  [last_seen_at] datetime2(3) NULL,
  [removed_at] datetime2(3) NULL,
  [status] nvarchar(64) DEFAULT 'approved' NOT NULL,
  [reviewed_by] uniqueidentifier NULL,
  [reviewed_at] datetime2(3) NULL,
  [review_note] nvarchar(256) NULL,
  [alert_id] uniqueidentifier NULL,
  CONSTRAINT [known_fixes_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [known_fixes_environment_json] CHECK ([environment] IS NULL OR ISJSON([environment], VALUE) = 1),
  CONSTRAINT [known_fixes_check] CHECK ((finding_key IS NULL AND issue_type_id IS NOT NULL) OR (finding_key IS NOT NULL AND issue_type_id IS NULL)),
  CONSTRAINT [known_fixes_finding_key_check] CHECK (finding_key IS NULL OR (LEN(finding_key) BETWEEN 1 AND 48 AND finding_key COLLATE Latin1_General_100_BIN2 LIKE '[a-z]%' AND finding_key COLLATE Latin1_General_100_BIN2 NOT LIKE '%[^a-z0-9-]%')),
  CONSTRAINT [known_fixes_review_note_check] CHECK (((review_note IS NULL) OR (LEN(review_note) <= 256))),
  CONSTRAINT [known_fixes_solution_check] CHECK (((LEN(solution) >= 1) AND (LEN(solution) <= 2000))),
  CONSTRAINT [known_fixes_status_check] CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT [known_fixes_title_check] CHECK (((LEN(title) >= 1) AND (LEN(title) <= 256)))
);
GO

CREATE TABLE packages (
  [id] uniqueidentifier NOT NULL,
  [name] nvarchar(128) NOT NULL,
  [version] nvarchar(64) NOT NULL,
  [vendor] nvarchar(128) NOT NULL,
  [type] nvarchar(64) NOT NULL,
  [hardware_ids] nvarchar(max) DEFAULT '[]' NOT NULL,
  [notes] nvarchar(max) NULL,
  [state] nvarchar(64) NOT NULL,
  [sha256] nvarchar(max) NULL,
  [size_bytes] bigint NULL,
  [signer] nvarchar(max) NULL,
  [detail] nvarchar(max) NULL,
  [refusal] nvarchar(max) NULL,
  [uploaded_by] uniqueidentifier NOT NULL,
  [uploaded_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [approved_by] uniqueidentifier NULL,
  [approved_at] datetime2(3) NULL,
  [retired_by] uniqueidentifier NULL,
  [retired_at] datetime2(3) NULL,
  CONSTRAINT [packages_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [packages_name_version_key] UNIQUE ([name], [version]),
  CONSTRAINT [packages_hardware_ids_json] CHECK ([hardware_ids] IS NULL OR ISJSON([hardware_ids], VALUE) = 1),
  CONSTRAINT [packages_check] CHECK (((approved_by IS NULL) OR (approved_by <> uploaded_by))),
  CONSTRAINT [packages_check1] CHECK (state NOT IN ('uploaded', 'approved', 'retired') OR (sha256 IS NOT NULL AND signer IS NOT NULL)),
  CONSTRAINT [packages_name_check] CHECK (((LEN(name) >= 1) AND (LEN(name) <= 128))),
  CONSTRAINT [packages_sha256_check] CHECK (sha256 IS NULL OR (LEN(sha256) = 64 AND sha256 COLLATE Latin1_General_100_BIN2 NOT LIKE '%[^0-9a-f]%')),
  CONSTRAINT [packages_state_check] CHECK (state IN ('uploading', 'uploaded', 'approved', 'retired', 'refused')),
  CONSTRAINT [packages_type_check] CHECK (type IN ('driver', 'msi')),
  CONSTRAINT [packages_vendor_check] CHECK (((LEN(vendor) >= 1) AND (LEN(vendor) <= 128))),
  CONSTRAINT [packages_version_check] CHECK (((LEN(version) >= 1) AND (LEN(version) <= 64)))
);
GO

CREATE TABLE rollouts (
  [id] uniqueidentifier NOT NULL,
  [version] nvarchar(450) NOT NULL,
  [state] nvarchar(64) NOT NULL,
  [current_batch] int NOT NULL,
  [success_rate_percent] int NOT NULL,
  [failure_limit_percent] int NOT NULL,
  [started_by] uniqueidentifier NOT NULL,
  [started_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [batch_started_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [paused_reason] nvarchar(max) NULL,
  [accepted_failures] int DEFAULT 0 NOT NULL,
  [changed_by] uniqueidentifier NULL,
  [finished_at] datetime2(3) NULL,
  [active_key] AS CAST(CASE WHEN state IN ('running', 'paused') THEN N'active' ELSE CONVERT(nvarchar(36), id) END AS nvarchar(36)) PERSISTED,
  CONSTRAINT [rollouts_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [rollouts_current_batch_check] CHECK (((current_batch >= 1) AND (current_batch <= 4))),
  CONSTRAINT [rollouts_failure_limit_percent_check] CHECK (((failure_limit_percent >= 0) AND (failure_limit_percent <= 50))),
  CONSTRAINT [rollouts_state_check] CHECK (state IN ('running', 'paused', 'completed', 'stopped')),
  CONSTRAINT [rollouts_success_rate_percent_check] CHECK (((success_rate_percent >= 50) AND (success_rate_percent <= 100)))
);
GO

CREATE TABLE rollout_targets (
  [rollout_id] uniqueidentifier NOT NULL,
  [cabinet_id] uniqueidentifier NOT NULL,
  [batch] int NOT NULL,
  [state] nvarchar(64) NOT NULL,
  [from_version] nvarchar(max) NULL,
  [offered_at] datetime2(3) NULL,
  [finished_at] datetime2(3) NULL,
  [outcome] nvarchar(64) NULL,
  [check_name] nvarchar(max) NULL,
  [message] nvarchar(max) NULL,
  CONSTRAINT [rollout_targets_pkey] PRIMARY KEY ([rollout_id], [cabinet_id]),
  CONSTRAINT [rollout_targets_batch_check] CHECK (((batch >= 1) AND (batch <= 4))),
  CONSTRAINT [rollout_targets_outcome_check] CHECK (((outcome IS NULL) OR outcome IN ('succeeded', 'refused', 'rolled_back', 'failed', 'timed_out', 'offline'))),
  CONSTRAINT [rollout_targets_state_check] CHECK (state IN ('pending', 'offered', 'succeeded', 'failed', 'skipped'))
);
GO

CREATE TABLE security_alerts (
  [id] uniqueidentifier DEFAULT NEWID() NOT NULL,
  [kind] nvarchar(64) NOT NULL,
  [signature] nvarchar(256) NOT NULL,
  [title] nvarchar(256) NOT NULL,
  [detail] nvarchar(max) DEFAULT '{}' NOT NULL,
  [user_id] uniqueidentifier NULL,
  [cabinet_id] uniqueidentifier NULL,
  [state] nvarchar(64) DEFAULT 'open' NOT NULL,
  [occurrences] int DEFAULT 1 NOT NULL,
  [first_seen] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [last_seen] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [resolved_by] uniqueidentifier NULL,
  [resolved_at] datetime2(3) NULL,
  [resolution] nvarchar(max) NULL,
  CONSTRAINT [security_alerts_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [security_alerts_detail_json] CHECK ([detail] IS NULL OR ISJSON([detail], VALUE) = 1),
  CONSTRAINT [security_alerts_check] CHECK ((state = 'resolved' AND resolved_at IS NOT NULL) OR (state <> 'resolved' AND resolved_at IS NULL)),
  CONSTRAINT [security_alerts_kind_check] CHECK (kind IN ('write_volume', 'failed_logins', 'failed_step_ups', 'new_location', 'new_device', 'audit_chain', 'agent_self_check', 'package_refused', 'signature_failure', 'certificate')),
  CONSTRAINT [security_alerts_signature_check] CHECK (((LEN(signature) >= 1) AND (LEN(signature) <= 256))),
  CONSTRAINT [security_alerts_state_check] CHECK (state IN ('open', 'resolved')),
  CONSTRAINT [security_alerts_title_check] CHECK (((LEN(title) >= 1) AND (LEN(title) <= 256)))
);
GO

CREATE TABLE sign_ins (
  [id] bigint IDENTITY(1,1) NOT NULL,
  [user_id] uniqueidentifier NOT NULL,
  [at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [address] nvarchar(64) NOT NULL,
  [network] nvarchar(64) NOT NULL,
  [device_label] nvarchar(120) NOT NULL,
  [new_network] bit NOT NULL,
  [new_device] bit NOT NULL,
  [completed] bit DEFAULT 0 NOT NULL,
  [is_new] AS CAST(CASE WHEN new_network = 1 OR new_device = 1 THEN 1 ELSE 0 END AS bit) PERSISTED,
  CONSTRAINT [sign_ins_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [sign_ins_address_check] CHECK (((LEN(address) >= 1) AND (LEN(address) <= 64))),
  CONSTRAINT [sign_ins_device_label_check] CHECK (((LEN(device_label) >= 1) AND (LEN(device_label) <= 120))),
  CONSTRAINT [sign_ins_network_check] CHECK (((LEN(network) >= 1) AND (LEN(network) <= 64)))
);
GO

CREATE TABLE sessions (
  [id_hash] varbinary(64) NOT NULL,
  [user_id] uniqueidentifier NOT NULL,
  [stage] nvarchar(64) NOT NULL,
  [created_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [last_activity_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [expires_at] datetime2(3) NOT NULL,
  [address] nvarchar(max) NULL,
  [current_cabinet] uniqueidentifier NULL,
  [sign_in_id] bigint NULL,
  CONSTRAINT [sessions_pkey] PRIMARY KEY ([id_hash]),
  CONSTRAINT [sessions_stage_check] CHECK (stage IN ('totp', 'totp_setup', 'password_change', 'complete'))
);
GO

CREATE TABLE settings (
  [key] nvarchar(450) NOT NULL,
  [value] nvarchar(max) NOT NULL,
  [changed_by] uniqueidentifier NULL,
  [changed_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  CONSTRAINT [settings_pkey] PRIMARY KEY ([key]),
  CONSTRAINT [settings_value_json] CHECK ([value] IS NULL OR ISJSON([value], VALUE) = 1)
);
GO

CREATE TABLE step_up_tokens (
  [token_hash] varbinary(64) NOT NULL,
  [user_id] uniqueidentifier NOT NULL,
  [action] nvarchar(max) NOT NULL,
  [target] nvarchar(max) NOT NULL,
  [expires_at] datetime2(3) NOT NULL,
  [used_at] datetime2(3) NULL,
  [params_hash] nvarchar(max) NULL,
  CONSTRAINT [step_up_tokens_pkey] PRIMARY KEY ([token_hash]),
  CONSTRAINT [step_up_tokens_params_hash_check] CHECK (params_hash IS NULL OR (LEN(params_hash) = 64 AND params_hash COLLATE Latin1_General_100_BIN2 NOT LIKE '%[^0-9a-f]%'))
);
GO

CREATE TABLE symptom_rule_history (
  [id] bigint IDENTITY(1,1) NOT NULL,
  [rule_id] uniqueidentifier NOT NULL,
  [version] int NOT NULL,
  [change] nvarchar(64) NOT NULL,
  [state] nvarchar(max) NOT NULL,
  [issue_type_id] uniqueidentifier NULL,
  [match] nvarchar(max) NOT NULL,
  [changed_by] uniqueidentifier NULL,
  [changed_at] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [severity] nvarchar(max) NULL,
  CONSTRAINT [symptom_rule_history_pkey] PRIMARY KEY ([id]),
  CONSTRAINT [symptom_rule_history_match_json] CHECK ([match] IS NULL OR ISJSON([match], VALUE) = 1),
  CONSTRAINT [symptom_rule_history_change_check] CHECK (change IN ('created', 'proposed', 'approved', 'rejected', 'disabled', 'rolled_back', 'expired', 'renewed'))
);
GO

CREATE TABLE user_devices (
  [user_id] uniqueidentifier NOT NULL,
  [device_hash] varbinary(64) NOT NULL,
  [label] nvarchar(120) NOT NULL,
  [first_seen] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [last_seen] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  CONSTRAINT [user_devices_pkey] PRIMARY KEY ([user_id], [device_hash]),
  CONSTRAINT [user_devices_label_check] CHECK (((LEN(label) >= 1) AND (LEN(label) <= 120)))
);
GO

CREATE TABLE user_networks (
  [user_id] uniqueidentifier NOT NULL,
  [network] nvarchar(64) NOT NULL,
  [first_seen] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  [last_seen] datetime2(3) DEFAULT SYSUTCDATETIME() NOT NULL,
  CONSTRAINT [user_networks_pkey] PRIMARY KEY ([user_id], [network]),
  CONSTRAINT [user_networks_network_check] CHECK (((LEN(network) >= 1) AND (LEN(network) <= 64)))
);
GO

-- Foreign keys
ALTER TABLE agent_releases ADD CONSTRAINT [agent_releases_added_by_fkey] FOREIGN KEY ([added_by]) REFERENCES users([id]);
ALTER TABLE sites ADD CONSTRAINT [sites_client_id_fkey] FOREIGN KEY ([client_id]) REFERENCES clients([id]);
ALTER TABLE cabinets ADD CONSTRAINT [cabinets_site_id_fkey] FOREIGN KEY ([site_id]) REFERENCES sites([id]);
ALTER TABLE issue_types ADD CONSTRAINT [issue_types_created_by_fkey] FOREIGN KEY ([created_by]) REFERENCES users([id]);
ALTER TABLE symptom_rules ADD CONSTRAINT [symptom_rules_approved_by_fkey] FOREIGN KEY ([approved_by]) REFERENCES users([id]);
ALTER TABLE symptom_rules ADD CONSTRAINT [symptom_rules_issue_type_id_fkey] FOREIGN KEY ([issue_type_id]) REFERENCES issue_types([id]);
ALTER TABLE symptom_rules ADD CONSTRAINT [symptom_rules_proposed_by_fkey] FOREIGN KEY ([proposed_by]) REFERENCES users([id]);
ALTER TABLE alerts ADD CONSTRAINT [alerts_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]);
ALTER TABLE alerts ADD CONSTRAINT [alerts_claimed_by_fkey] FOREIGN KEY ([claimed_by]) REFERENCES users([id]);
ALTER TABLE alerts ADD CONSTRAINT [alerts_issue_type_id_fkey] FOREIGN KEY ([issue_type_id]) REFERENCES issue_types([id]);
ALTER TABLE alerts ADD CONSTRAINT [alerts_resolved_by_fkey] FOREIGN KEY ([resolved_by]) REFERENCES users([id]);
ALTER TABLE alerts ADD CONSTRAINT [alerts_rule_id_fkey] FOREIGN KEY ([rule_id]) REFERENCES symptom_rules([id]);
ALTER TABLE bootstrap_tokens ADD CONSTRAINT [bootstrap_tokens_created_by_fkey] FOREIGN KEY ([created_by]) REFERENCES users([id]);
ALTER TABLE cabinet_boots ADD CONSTRAINT [cabinet_boots_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]);
ALTER TABLE cabinet_certificates ADD CONSTRAINT [cabinet_certificates_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]);
ALTER TABLE cabinet_certificates ADD CONSTRAINT [cabinet_certificates_renewed_from_fkey] FOREIGN KEY ([renewed_from]) REFERENCES cabinet_certificates([serial]);
ALTER TABLE commands ADD CONSTRAINT [commands_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]);
ALTER TABLE commands ADD CONSTRAINT [commands_issued_by_fkey] FOREIGN KEY ([issued_by]) REFERENCES users([id]);
ALTER TABLE diagnosis_batches ADD CONSTRAINT [diagnosis_batches_created_by_fkey] FOREIGN KEY ([created_by]) REFERENCES users([id]);
ALTER TABLE diagnosis_batches ADD CONSTRAINT [diagnosis_batches_site_id_fkey] FOREIGN KEY ([site_id]) REFERENCES sites([id]);
ALTER TABLE diagnoses ADD CONSTRAINT [diagnoses_batch_id_fkey] FOREIGN KEY ([batch_id]) REFERENCES diagnosis_batches([id]);
ALTER TABLE diagnoses ADD CONSTRAINT [diagnoses_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]);
ALTER TABLE diagnoses ADD CONSTRAINT [diagnoses_run_by_fkey] FOREIGN KEY ([run_by]) REFERENCES users([id]);
ALTER TABLE drive_samples ADD CONSTRAINT [drive_samples_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]) ON DELETE CASCADE;
ALTER TABLE drive_status ADD CONSTRAINT [drive_status_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]) ON DELETE CASCADE;
ALTER TABLE enrollment_requests ADD CONSTRAINT [enrollment_requests_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]);
ALTER TABLE enrollment_requests ADD CONSTRAINT [enrollment_requests_certificate_serial_fkey] FOREIGN KEY ([certificate_serial]) REFERENCES cabinet_certificates([serial]);
ALTER TABLE enrollment_requests ADD CONSTRAINT [enrollment_requests_decided_by_fkey] FOREIGN KEY ([decided_by]) REFERENCES users([id]);
ALTER TABLE enrollment_requests ADD CONSTRAINT [enrollment_requests_token_id_fkey] FOREIGN KEY ([token_id]) REFERENCES bootstrap_tokens([id]);
ALTER TABLE events ADD CONSTRAINT [events_alert_id_fkey] FOREIGN KEY ([alert_id]) REFERENCES alerts([id]);
ALTER TABLE events ADD CONSTRAINT [events_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]);
ALTER TABLE firewall_changes ADD CONSTRAINT [firewall_changes_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]);
ALTER TABLE firewall_changes ADD CONSTRAINT [firewall_changes_command_id_fkey] FOREIGN KEY ([command_id]) REFERENCES commands([id]);
ALTER TABLE fleet_jobs ADD CONSTRAINT [fleet_jobs_cancelled_by_fkey] FOREIGN KEY ([cancelled_by]) REFERENCES users([id]);
ALTER TABLE fleet_jobs ADD CONSTRAINT [fleet_jobs_created_by_fkey] FOREIGN KEY ([created_by]) REFERENCES users([id]);
ALTER TABLE fleet_job_targets ADD CONSTRAINT [fleet_job_targets_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]);
ALTER TABLE fleet_job_targets ADD CONSTRAINT [fleet_job_targets_command_id_fkey] FOREIGN KEY ([command_id]) REFERENCES commands([id]);
ALTER TABLE fleet_job_targets ADD CONSTRAINT [fleet_job_targets_job_id_fkey] FOREIGN KEY ([job_id]) REFERENCES fleet_jobs([id]);
ALTER TABLE health_samples ADD CONSTRAINT [health_samples_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]) ON DELETE CASCADE;
ALTER TABLE known_fixes ADD CONSTRAINT [known_fixes_alert_id_fkey] FOREIGN KEY ([alert_id]) REFERENCES alerts([id]) ON DELETE SET NULL;
ALTER TABLE known_fixes ADD CONSTRAINT [known_fixes_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]);
ALTER TABLE known_fixes ADD CONSTRAINT [known_fixes_created_by_fkey] FOREIGN KEY ([created_by]) REFERENCES users([id]);
ALTER TABLE known_fixes ADD CONSTRAINT [known_fixes_issue_type_id_fkey] FOREIGN KEY ([issue_type_id]) REFERENCES issue_types([id]);
ALTER TABLE known_fixes ADD CONSTRAINT [known_fixes_reviewed_by_fkey] FOREIGN KEY ([reviewed_by]) REFERENCES users([id]);
ALTER TABLE packages ADD CONSTRAINT [packages_approved_by_fkey] FOREIGN KEY ([approved_by]) REFERENCES users([id]);
ALTER TABLE packages ADD CONSTRAINT [packages_retired_by_fkey] FOREIGN KEY ([retired_by]) REFERENCES users([id]);
ALTER TABLE packages ADD CONSTRAINT [packages_uploaded_by_fkey] FOREIGN KEY ([uploaded_by]) REFERENCES users([id]);
ALTER TABLE rollouts ADD CONSTRAINT [rollouts_changed_by_fkey] FOREIGN KEY ([changed_by]) REFERENCES users([id]);
ALTER TABLE rollouts ADD CONSTRAINT [rollouts_started_by_fkey] FOREIGN KEY ([started_by]) REFERENCES users([id]);
ALTER TABLE rollouts ADD CONSTRAINT [rollouts_version_fkey] FOREIGN KEY ([version]) REFERENCES agent_releases([version]);
ALTER TABLE rollout_targets ADD CONSTRAINT [rollout_targets_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]);
ALTER TABLE rollout_targets ADD CONSTRAINT [rollout_targets_rollout_id_fkey] FOREIGN KEY ([rollout_id]) REFERENCES rollouts([id]);
ALTER TABLE security_alerts ADD CONSTRAINT [security_alerts_cabinet_id_fkey] FOREIGN KEY ([cabinet_id]) REFERENCES cabinets([id]);
ALTER TABLE security_alerts ADD CONSTRAINT [security_alerts_resolved_by_fkey] FOREIGN KEY ([resolved_by]) REFERENCES users([id]);
ALTER TABLE security_alerts ADD CONSTRAINT [security_alerts_user_id_fkey] FOREIGN KEY ([user_id]) REFERENCES users([id]);
ALTER TABLE sign_ins ADD CONSTRAINT [sign_ins_user_id_fkey] FOREIGN KEY ([user_id]) REFERENCES users([id]);
ALTER TABLE sessions ADD CONSTRAINT [sessions_sign_in_id_fkey] FOREIGN KEY ([sign_in_id]) REFERENCES sign_ins([id]);
ALTER TABLE sessions ADD CONSTRAINT [sessions_user_id_fkey] FOREIGN KEY ([user_id]) REFERENCES users([id]);
ALTER TABLE settings ADD CONSTRAINT [settings_changed_by_fkey] FOREIGN KEY ([changed_by]) REFERENCES users([id]);
ALTER TABLE step_up_tokens ADD CONSTRAINT [step_up_tokens_user_id_fkey] FOREIGN KEY ([user_id]) REFERENCES users([id]);
ALTER TABLE symptom_rule_history ADD CONSTRAINT [symptom_rule_history_changed_by_fkey] FOREIGN KEY ([changed_by]) REFERENCES users([id]);
ALTER TABLE symptom_rule_history ADD CONSTRAINT [symptom_rule_history_rule_id_fkey] FOREIGN KEY ([rule_id]) REFERENCES symptom_rules([id]);
ALTER TABLE user_devices ADD CONSTRAINT [user_devices_user_id_fkey] FOREIGN KEY ([user_id]) REFERENCES users([id]);
ALTER TABLE user_networks ADD CONSTRAINT [user_networks_user_id_fkey] FOREIGN KEY ([user_id]) REFERENCES users([id]);
GO

-- Indexes (filtered where the PostgreSQL ones were partial)
CREATE INDEX alerts_fleet_scope ON alerts ([state], [severity], [last_seen] DESC) WHERE scope = 'fleet';
CREATE INDEX alerts_issue_recent ON alerts ([issue_type_id], [last_seen] DESC);
CREATE UNIQUE INDEX alerts_one_active ON alerts ([cabinet_id], [signature]) WHERE state <> 'resolved';
CREATE INDEX alerts_state_severity ON alerts ([state], [severity], [last_seen] DESC);
CREATE INDEX audit_log_action ON audit_log ([action], [seq] DESC);
CREATE INDEX audit_log_actor ON audit_log ([actor_id], [seq] DESC);
CREATE INDEX audit_log_at ON audit_log ([at]);
CREATE INDEX audit_log_target ON audit_log ([target_id], [seq] DESC);
CREATE INDEX cabinet_certificates_cabinet ON cabinet_certificates ([cabinet_id]);
CREATE INDEX cabinet_certificates_renewed_from ON cabinet_certificates ([renewed_from]) WHERE renewed_from IS NOT NULL;
CREATE INDEX cabinets_demo ON cabinets ([id]) WHERE demo_scenario IS NOT NULL;
CREATE UNIQUE INDEX clients_live_name ON clients ([name]) WHERE removed_at IS NULL;
CREATE INDEX commands_cabinet_issued ON commands ([cabinet_id], [issued_at] DESC);
CREATE INDEX commands_delivered ON commands ([delivered_at]) WHERE status = 'delivered';
CREATE INDEX commands_latest_result ON commands ([cabinet_id], [operation], [result_at] DESC) WHERE (status = 'succeeded') AND (result IS NOT NULL);
CREATE INDEX commands_result_by_operation ON commands ([operation], [cabinet_id], [result_at] DESC) WHERE (status = 'succeeded') AND (result IS NOT NULL);
CREATE INDEX commands_waiting ON commands ([cabinet_id], [issued_at]) WHERE status = 'queued';
CREATE INDEX commands_writes_by_user ON commands ([issued_by], [issued_at] DESC);
CREATE INDEX diagnoses_batch ON diagnoses ([batch_id]) WHERE batch_id IS NOT NULL;
CREATE INDEX diagnoses_cabinet ON diagnoses ([cabinet_id], [started_at] DESC);
CREATE INDEX drive_status_level ON drive_status ([level]) WHERE level <> 'ok';
CREATE INDEX enrollment_requests_pending ON enrollment_requests ([created_at]) WHERE status = 'pending';
CREATE INDEX events_alert ON events ([alert_id]);
CREATE INDEX events_cabinet_time ON events ([cabinet_id], [occurred_at] DESC);
CREATE INDEX events_received ON events ([occurred_at] DESC);
CREATE INDEX events_received_at ON events ([received_at]);
CREATE INDEX firewall_changes_cabinet ON firewall_changes ([cabinet_id], [occurred_at] DESC);
CREATE INDEX fleet_job_targets_order ON fleet_job_targets ([job_id], [position]);
CREATE INDEX fleet_jobs_recent ON fleet_jobs ([created_at] DESC);
CREATE INDEX known_fixes_finding ON known_fixes ([finding_key]) WHERE (removed_at IS NULL) AND (finding_key IS NOT NULL);
CREATE INDEX known_fixes_issue ON known_fixes ([issue_type_id]) WHERE (removed_at IS NULL) AND (issue_type_id IS NOT NULL);
CREATE INDEX known_fixes_pending ON known_fixes ([created_at]) WHERE (status = 'pending') AND (removed_at IS NULL);
CREATE INDEX rollout_targets_batch ON rollout_targets ([rollout_id], [batch], [state]);
CREATE INDEX rollout_targets_cabinet ON rollout_targets ([cabinet_id], [state]);
CREATE UNIQUE INDEX rollouts_one_active ON rollouts ([active_key]);
CREATE UNIQUE INDEX security_alerts_open_signature ON security_alerts ([signature]) WHERE state = 'open';
CREATE INDEX security_alerts_recent ON security_alerts ([last_seen] DESC);
CREATE INDEX sessions_user ON sessions ([user_id]);
CREATE INDEX sign_ins_new ON sign_ins ([is_new], [at] DESC);
CREATE INDEX sign_ins_user_at ON sign_ins ([user_id], [at] DESC);
CREATE UNIQUE INDEX sites_live_name ON sites ([client_id], [name]) WHERE removed_at IS NULL;
CREATE INDEX symptom_rule_history_rule ON symptom_rule_history ([rule_id], [id]);
CREATE INDEX symptom_rules_state ON symptom_rules ([state]);
GO
-- Built-in issue types and symptom rules

GO

GO

GO

-- ---- Audit log: append-only hash chain ------------------------------------------------------------------------
-- The application's role can read the log and call audit_append; it has no INSERT, UPDATE or DELETE on the tables themselves.
-- audit_append and the tables have the same owner, so the procedure may write where the caller may not (ownership chaining).
-- Each entry's hash covers the previous hash and the entry's stored fields, joined by the unit separator, as UTF-16 text
-- (SQL Server hashes nvarchar as UTF-16); verifyAuditChain in src/db/db.ts recomputes it the same way.
INSERT INTO audit_chain_head ([id], [seq], [hash]) VALUES (1, 0, REPLICATE('0', 64));
GO

CREATE PROCEDURE audit_append
  @actor_kind nvarchar(64), @actor_id nvarchar(450), @action nvarchar(450), @target_kind nvarchar(64), @target_id nvarchar(450),
  @outcome nvarchar(64), @details nvarchar(max), @seq bigint OUTPUT
AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @prev nvarchar(64), @n bigint, @at datetime2(6) = SYSUTCDATETIME(), @hash nvarchar(64);
  SELECT @prev = [hash], @n = [seq] + 1 FROM audit_chain_head WITH (UPDLOCK, HOLDLOCK) WHERE id = 1; -- serializes the chain
  DECLARE @input nvarchar(max) = CONCAT(@prev, NCHAR(31), CONVERT(nvarchar(20), @n), NCHAR(31), CONVERT(nvarchar(27), @at, 126), NCHAR(31), @actor_kind, NCHAR(31),
    @actor_id, NCHAR(31), @action, NCHAR(31), COALESCE(@target_kind, N''), NCHAR(31), COALESCE(@target_id, N''), NCHAR(31), @outcome, NCHAR(31), @details);
  SET @hash = LOWER(CONVERT(nvarchar(64), HASHBYTES('SHA2_256', @input), 2));
  INSERT INTO audit_log ([seq], [at], [actor_kind], [actor_id], [action], [target_kind], [target_id], [outcome], [details], [prev_hash], [hash])
    VALUES (@n, @at, @actor_kind, @actor_id, @action, @target_kind, @target_id, @outcome, @details, @prev, @hash);
  UPDATE audit_chain_head SET [seq] = @n, [hash] = @hash WHERE id = 1;
  SET @seq = @n;
END
GO

-- Append-only even for the owner. (SQL Server has no TRUNCATE trigger: the application's role has no ALTER right, which TRUNCATE needs.)
CREATE TRIGGER audit_log_immutable ON audit_log INSTEAD OF UPDATE, DELETE AS
BEGIN
  THROW 50010, 'the audit log is append-only', 1;
END
GO

-- ---- Notifications ----------------------------------------------------------------------------------------------
-- A small table that wakes other server processes: a new command wakes the long poll held for its cabinet, a result or an alert wakes the
-- consoles' live streams. Every server process reads rows newer than the last one it saw; maintenance removes old rows.
CREATE TABLE notifications (
  [id]       bigint IDENTITY(1,1) PRIMARY KEY,
  [channel]  nvarchar(40) NOT NULL,
  [payload]  nvarchar(450) NOT NULL,
  [at]       datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX notifications_at ON notifications ([at]);
GO

CREATE TRIGGER commands_notify ON commands AFTER INSERT AS
BEGIN
  SET NOCOUNT ON;
  INSERT INTO notifications ([channel], [payload]) SELECT 'cabinet_commands', LOWER(CONVERT(nvarchar(36), cabinet_id)) FROM inserted;
END
GO

CREATE TRIGGER command_result_notify ON commands AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON;
  IF NOT UPDATE([result]) RETURN;
  INSERT INTO notifications ([channel], [payload])
    SELECT 'command_results', LOWER(CONVERT(nvarchar(36), i.id)) + ' ' + LOWER(CONVERT(nvarchar(36), i.issued_by))
      FROM inserted i JOIN deleted d ON d.id = i.id WHERE i.result IS NOT NULL AND d.result IS NULL;
END
GO

-- An alert that becomes major (a more serious symptom of the same issue arrived) is announced like a new major alert.
CREATE TRIGGER alert_notify ON alerts AFTER INSERT, UPDATE AS
BEGIN
  SET NOCOUNT ON;
  INSERT INTO notifications ([channel], [payload])
    SELECT 'alerts', LOWER(CONVERT(nvarchar(36), i.id)) + ' ' + CASE WHEN d.id IS NULL THEN 'created' WHEN i.state <> d.state THEN i.state ELSE 'created' END
      FROM inserted i LEFT JOIN deleted d ON d.id = i.id
     WHERE d.id IS NULL OR i.state <> d.state OR (i.severity = 'major' AND d.severity = 'minor');
END
GO

-- ---- Rights of the application's role ----------------------------------------------------------------------------
GRANT INSERT, SELECT, UPDATE ON agent_releases TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON alerts TO cabinet_app;
GRANT SELECT ON audit_log TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON bootstrap_tokens TO cabinet_app;
GRANT DELETE, INSERT, SELECT ON cabinet_boots TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON cabinet_certificates TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON cabinets TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON clients TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON commands TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON diagnoses TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON diagnosis_batches TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON drive_samples TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON drive_status TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON enrollment_requests TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON events TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON firewall_changes TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON fleet_job_targets TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON fleet_jobs TO cabinet_app;
GRANT DELETE, INSERT, SELECT ON health_samples TO cabinet_app;
GRANT INSERT, SELECT, UPDATE ON issue_types TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON known_fixes TO cabinet_app;
GRANT INSERT, SELECT, UPDATE ON packages TO cabinet_app;
GRANT INSERT, SELECT, UPDATE ON rollout_targets TO cabinet_app;
GRANT INSERT, SELECT, UPDATE ON rollouts TO cabinet_app;
GRANT INSERT, SELECT, UPDATE ON security_alerts TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON sessions TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON settings TO cabinet_app;
GRANT INSERT, SELECT, UPDATE ON sign_ins TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON sites TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON step_up_tokens TO cabinet_app;
GRANT INSERT, SELECT ON symptom_rule_history TO cabinet_app;
GRANT INSERT, SELECT, UPDATE ON symptom_rules TO cabinet_app;
GRANT INSERT, SELECT, UPDATE ON user_devices TO cabinet_app;
GRANT INSERT, SELECT, UPDATE ON user_networks TO cabinet_app;
GRANT DELETE, INSERT, SELECT, UPDATE ON users TO cabinet_app;
GRANT SELECT, INSERT, DELETE ON notifications TO cabinet_app;
GRANT EXECUTE ON audit_append TO cabinet_app;
DENY INSERT, UPDATE, DELETE ON audit_log TO cabinet_app;
DENY SELECT, INSERT, UPDATE, DELETE ON audit_chain_head TO cabinet_app;
GO
