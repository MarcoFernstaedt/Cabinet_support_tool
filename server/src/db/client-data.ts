// Where each table would live if a client's data moved to a database of its own (F21.R5, decision-log D62). Today every table is in
// one database; this is the line along which it would split, written down and held by client-data.test.ts against the real foreign keys.
//
//   platform:  one for the whole platform. People, sign-in, the audit trail, rules and issue types, releases and packages, settings and
//              baselines at every scope, and the work that spans clients (fleet jobs, rollouts, fleet patterns).
//   directory: clients, sites and cabinets. The platform database holds them all and resolves a cabinet, site or token to its client;
//              each client database holds a copy of its own rows, so the foreign keys inside it still hold.
//   client:    what a client's cabinets produce, and the work done on them: events, alerts, commands, readings, diagnoses, incidents.
//
// The test fails on a table with no placement, on a platform or directory table with a foreign key to a client table (the platform
// database would depend on a client's), on a client table with no way back to its client, and on a foreign key from a client table to a
// platform table that is not listed in CROSS_REFERENCES (each one becomes a reference the code checks, since a foreign key cannot span
// two databases).
export type Placement = "platform" | "directory" | "client";

export const TABLE_PLACEMENT: Readonly<Record<string, Placement>> = {
  agent_releases: "platform",
  alerts: "client",
  audit_chain_head: "platform",
  audit_checkpoint: "platform",
  audit_log: "platform",
  baseline_versions: "platform",
  baselines: "platform",
  bootstrap_tokens: "platform",
  cabinet_boots: "client",
  cabinet_certificates: "platform",
  cabinet_drift: "client",
  cabinet_health: "client",
  cabinets: "directory",
  case_notes: "client",
  clients: "directory",
  commands: "client",
  config_changes: "client",
  config_current: "client",
  config_versions: "client",
  diagnoses: "client",
  diagnosis_batches: "client",
  drive_samples: "client",
  drive_status: "client",
  enrollment_baselines: "client",
  enrollment_requests: "platform",
  error_daily: "client",
  events: "client",
  firewall_changes: "client",
  fleet_job_targets: "client",
  fleet_jobs: "platform",
  fleet_patterns: "platform",
  health_hourly: "client",
  health_samples: "client",
  health_transitions: "client",
  healthy_marks: "client",
  incident_links: "client",
  incident_steps: "client",
  incidents: "client",
  issue_daily: "client",
  issue_types: "platform",
  job_leases: "platform",
  known_fixes: "client",
  notifications: "platform",
  ops_counters: "platform",
  packages: "platform",
  remote_sessions: "client",
  session_shell_commands: "client",
  session_shell_frames: "client",
  replacement_reapply: "client",
  replacement_reapply_steps: "client",
  rollout_targets: "client",
  rollouts: "platform",
  runbooks: "platform",
  security_alerts: "platform",
  sessions: "platform",
  settings: "platform",
  sign_ins: "platform",
  sites: "directory",
  step_up_tokens: "platform",
  symptom_rule_history: "platform",
  symptom_rules: "platform",
  trend_state: "platform",
  user_devices: "platform",
  user_networks: "platform",
  user_permissions: "platform",
  users: "platform",
};

/**
 * The foreign keys from a client table to a platform table, as "client_table -> platform_table". In a split each becomes a reference
 * the code checks when it writes the row (the referenced row is in the platform database); a new one must be listed here, and one that
 * no longer exists must come off.
 */
export const CROSS_REFERENCES: readonly string[] = [
  "alerts -> issue_types",
  "alerts -> symptom_rules",
  "alerts -> users",
  "case_notes -> users",
  "commands -> users",
  "diagnoses -> users",
  "diagnosis_batches -> users",
  "fleet_job_targets -> fleet_jobs",
  "known_fixes -> issue_types",
  "known_fixes -> users",
  "remote_sessions -> users",
  "rollout_targets -> rollouts",
];

/** Columns that name a client's cabinet, site or client directly, for a client table with no foreign key to the directory. */
export const CLIENT_KEY_COLUMNS = ["cabinet_id", "site_id", "client_id"] as const;
