// Which module owns each table (F21.R2, decision-log D56). A table has one owning module, the one that is meant to write it. Every other
// source file that writes it today is listed under `also`, including writes whose table name is built at run time (declared in
// RUNTIME_TABLE_WRITES). That list is the debt, written down. table-ownership.test.ts fails on any write by a file not listed here (a new
// cross-module write), on a run-time write that is not declared, and on any `also` entry that no longer writes the table (the debt was
// paid and the list must shrink with it). A new table must name its owner here before anything writes it. The demo simulator (demo/)
// seeds its own demo rows across the schema and is listed like any other writer, so its reach stays visible.
export interface Ownership {
  owner: string;
  /** Other files that write the table today: the debt, to move behind the owner. */
  also: readonly string[];
  /** Other files accepted as writers of the table, each for the reason ACCEPTED_WRITERS gives (D108). Not debt, still checked. */
  accepted?: readonly string[];
  /**
   * Setting columns owned by the feature module they belong to, not by the table's owner (decision-log D118): column -> file. A file
   * whose every write of the table is a plain UPDATE of columns it owns here is not debt. Creating, removing or renaming a row, and any
   * column no feature owns, stay with the table's owner.
   */
  columns?: Readonly<Record<string, string>>;
}

/**
 * The files accepted as writers of tables they do not own, and why (decision-log D108). They are not debt, so they are not counted, but
 * the ownership test still holds them: each must be named here with its reason, a reason no table uses must come off, and an accepted
 * writer that stops writing its table must come off that table, as a paid debt does.
 */
export const ACCEPTED_WRITERS: Readonly<Record<string, string>> = {
  "demo/config.ts": "The demo simulator seeds its own simulated cabinets' rows across the schema; it never runs against a real cabinet's data.",
  "demo/demo.ts": "The demo simulator seeds its own simulated cabinets' rows across the schema; it never runs against a real cabinet's data.",
  "demo/troubleshooting.ts": "The demo simulator seeds its own simulated cabinets' rows across the schema; it never runs against a real cabinet's data.",
  "services/usb-sql.ts": "The USB layer keeps its statements as data in a module with no database driver, so usb-sql.test.ts checks every one against the migrations without a database (its header says why); usb-store.ts runs them.",
};

/**
 * The files whose statements name their table at run time (an UPDATE whose table comes from a per-level lookup, the demo's seeding helper), with every table those
 * statements can write. The source reader cannot see the table in such a statement, so it is declared here, and the ownership test
 * counts these as writes like any other: a new run-time write in a file not listed here fails, and a listing whose file no longer has one
 * must come off.
 */
export const RUNTIME_TABLE_WRITES: Readonly<Record<string, readonly string[]>> = {
  "demo/demo.ts": [
    "alerts",
    "cabinet_boots",
    "cabinets",
    "clients",
    "commands",
    "diagnoses",
    "events",
    "firewall_changes",
    "known_fixes",
    "sites"
  ],
};

export const TABLE_OWNERS: Readonly<Record<string, Ownership>> = {
  user_permissions: { owner: "services/user-permissions.ts", also: [] },
  remote_sessions: { owner: "services/session-records.ts", also: [] },
  agent_releases: { owner: "services/releases.ts", also: [] },
  alerts: { owner: "services/alerts.ts", also: [], accepted: ["demo/demo.ts", "demo/troubleshooting.ts", "services/usb-sql.ts"] },
  audit_chain_head: { owner: "the audit_append procedures (migrations)", also: [] },
  audit_checkpoint: { owner: "the audit_append procedures (migrations)", also: [] },
  audit_log: { owner: "the audit_append procedures (migrations)", also: [] },
  baseline_versions: { owner: "services/baselines.ts", also: [], accepted: ["demo/config.ts", "demo/demo.ts"] },
  baselines: { owner: "services/baselines.ts", also: [], accepted: ["demo/demo.ts"] },
  bootstrap_tokens: { owner: "services/enrollment.ts", also: [] },
  cabinet_boots: { owner: "services/crashes.ts", also: [], accepted: ["demo/demo.ts"] },
  cabinet_certificates: { owner: "services/cabinets.ts", also: [] },
  cabinet_drift: { owner: "services/baseline-drift.ts", also: [] },
  cabinet_health: { owner: "services/cabinet-health.ts", also: [] },
  cabinets: { owner: "services/cabinets.ts", also: [], accepted: ["demo/demo.ts"],
    columns: { approved_apps: "services/approved-apps.ts", watched_services: "services/watched-services.ts", manufacturer: "services/config-ingest.ts", model: "services/config-ingest.ts", ipv4: "services/commands.ts", ipv4_at: "services/commands.ts", scanner_hardware_ids: "services/settings.ts", in_office: "services/rollouts.ts", sync_address: "services/sync-cabinets.ts", sync_address_source: "services/sync-cabinets.ts", sync_cabinet_id: "services/sync-cabinets.ts" } },
  case_notes: { owner: "services/case-notes.ts", also: [], accepted: ["demo/troubleshooting.ts"] },
  clients: { owner: "services/admin.ts", also: [], accepted: ["demo/demo.ts"],
    columns: { approved_apps: "services/approved-apps.ts", fingerprint_scanner: "services/client-scanner.ts", scanner_service: "services/client-scanner.ts", scanner_hardware_ids: "services/device-settings.ts", sync_ports: "services/device-settings.ts", watched_services: "services/watched-services.ts", firewall_policy: "services/firewall-policy.ts", time_zone: "services/time.ts", clock_tolerance_seconds: "services/time.ts", write_paused: "services/writes.ts", write_pause_reason: "services/writes.ts" } },
  commands: { owner: "services/commands.ts", also: [], accepted: ["demo/demo.ts"] },
  config_changes: { owner: "services/config-ingest.ts", also: [] },
  config_current: { owner: "services/config-ingest.ts", also: [] },
  config_versions: { owner: "services/config-ingest.ts", also: [] },
  diagnoses: { owner: "diagnose/diagnoses.ts", also: [], accepted: ["demo/demo.ts"] },
  diagnosis_batches: { owner: "diagnose/network.ts", also: [], accepted: ["demo/demo.ts"] },
  enrollment_baselines: { owner: "services/baselines.ts", also: [] },
  enrollment_requests: { owner: "services/enrollment.ts", also: [] },
  error_daily: { owner: "services/error-trends.ts", also: [], accepted: ["demo/demo.ts", "demo/troubleshooting.ts"] },
  events: { owner: "services/events.ts", also: [], accepted: ["demo/demo.ts"] },
  firewall_changes: { owner: "services/commands.ts", also: [], accepted: ["demo/demo.ts"] },
  fleet_job_targets: { owner: "services/fleet-jobs.ts", also: [], accepted: ["demo/demo.ts"] },
  fleet_jobs: { owner: "services/fleet-jobs.ts", also: [], accepted: ["demo/demo.ts"] },
  fleet_patterns: { owner: "services/fleet-patterns.ts", also: [] },
  health_hourly: { owner: "services/maintenance.ts", also: [] },
  health_samples: { owner: "services/cabinets.ts", also: [], accepted: ["demo/demo.ts"] },
  health_transitions: { owner: "services/cabinet-health.ts", also: [] },
  healthy_marks: { owner: "services/cabinet-health.ts", also: [] },
  incident_links: { owner: "services/incidents.ts", also: [] },
  incident_steps: { owner: "services/incidents.ts", also: [] },
  incidents: { owner: "services/incidents.ts", also: [] },
  issue_daily: { owner: "services/error-trends.ts", also: [], accepted: ["demo/demo.ts"] },
  issue_types: { owner: "services/rules.ts", also: [] },
  job_leases: { owner: "services/job-lease.ts", also: [] },
  known_fixes: { owner: "services/known-fixes.ts", also: [], accepted: ["demo/demo.ts"] },
  notifications: { owner: "db/db.ts", also: [] },
  ops_counters: { owner: "services/ops-meter.ts", also: [] },
  packages: { owner: "services/packages.ts", also: [] },
  replacement_reapply: { owner: "services/replacement-reapply.ts", also: [] },
  replacement_reapply_steps: { owner: "services/replacement-reapply.ts", also: [] },
  rollout_targets: { owner: "services/rollouts.ts", also: [] },
  rollouts: { owner: "services/rollouts.ts", also: [] },
  runbooks: { owner: "services/runbooks.ts", also: [] },
  security_alerts: { owner: "services/security.ts", also: [], accepted: ["demo/demo.ts"] },
  sessions: { owner: "auth/sessions.ts", also: [] },
  settings: { owner: "services/settings.ts", also: [], accepted: ["demo/demo.ts", "services/usb-sql.ts"] },
  sign_ins: { owner: "auth/sessions.ts", also: [] },
  sites: { owner: "services/admin.ts", also: [], accepted: ["demo/demo.ts"],
    columns: { approved_apps: "services/approved-apps.ts", scanner_hardware_ids: "services/device-settings.ts", watched_services: "services/watched-services.ts", firewall_policy: "services/firewall-policy.ts", time_zone: "services/time.ts", clock_tolerance_seconds: "services/time.ts", sync_ports: "services/settings.ts", network_baseline: "services/network-baseline.ts" } },
  step_up_tokens: { owner: "auth/stepup.ts", also: [] },
  symptom_rule_history: { owner: "services/rules.ts", also: [] },
  symptom_rules: { owner: "services/rules.ts", also: [], accepted: ["demo/demo.ts"] },
  trend_state: { owner: "services/error-trends.ts", also: [], accepted: ["demo/troubleshooting.ts"] },
  user_devices: { owner: "auth/devices.ts", also: [] },
  user_networks: { owner: "auth/devices.ts", also: [] },
  users: { owner: "services/users.ts", also: [], accepted: ["demo/demo.ts"] },
};
