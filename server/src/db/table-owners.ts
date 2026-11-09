// Which module owns each table (F21.R2, decision-log D56). A table has one owning module, the one that is meant to write it. Every other
// source file that writes it today is listed under `also`, including writes whose table name is built at run time (declared in
// RUNTIME_TABLE_WRITES). That list is the debt, written down. table-ownership.test.ts fails on any write by a file not listed here (a new
// cross-module write), on a run-time write that is not declared, and on any `also` entry that no longer writes the table (the debt was
// paid and the list must shrink with it). A new table must name its owner here before anything writes it. The demo simulator (demo/)
// seeds its own demo rows across the schema and is listed like any other writer, so its reach stays visible.
export interface Ownership { owner: string; also: readonly string[] }

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
  "services/approved-apps.ts": [
    "cabinets",
    "clients",
    "sites"
  ],
  "services/device-settings.ts": [
    "clients",
    "sites"
  ],
  "services/filefacts-allowlist.ts": [
    "cabinets",
    "clients",
    "sites"
  ],
  "services/watched-services.ts": [
    "cabinets",
    "clients",
    "sites"
  ]
};

export const TABLE_OWNERS: Readonly<Record<string, Ownership>> = {
  agent_releases: { owner: "services/releases.ts", also: [] },
  alerts: { owner: "services/alerts.ts", also: ["demo/demo.ts", "demo/troubleshooting.ts", "diagnose/network.ts", "services/baseline-drift.ts", "services/client-scanner.ts", "services/crashes.ts", "services/drives.ts", "services/filefacts-ingest.ts", "services/firewall-policy.ts", "services/maintenance.ts", "services/peer-differences.ts", "services/replacement.ts", "services/rules.ts", "services/service-recovery.ts", "services/site-outage.ts", "services/time.ts", "services/usb-sql.ts"] },
  audit_chain_head: { owner: "the audit_append procedures (migrations)", also: [] },
  audit_checkpoint: { owner: "the audit_append procedures (migrations)", also: [] },
  audit_log: { owner: "the audit_append procedures (migrations)", also: [] },
  baseline_versions: { owner: "services/baselines.ts", also: ["demo/config.ts", "demo/demo.ts"] },
  baselines: { owner: "services/baselines.ts", also: ["demo/demo.ts"] },
  bootstrap_tokens: { owner: "services/enrollment.ts", also: [] },
  cabinet_boots: { owner: "services/crashes.ts", also: ["demo/demo.ts", "services/maintenance.ts"] },
  cabinet_certificates: { owner: "services/cabinets.ts", also: ["services/enrollment.ts", "services/replacement.ts"] },
  cabinet_drift: { owner: "services/baseline-drift.ts", also: [] },
  cabinet_health: { owner: "services/cabinet-health.ts", also: [] },
  cabinets: { owner: "services/cabinets.ts", also: ["agent-api/presence.ts", "demo/demo.ts", "services/admin.ts", "services/approved-apps.ts", "services/commands.ts", "services/config-ingest.ts", "services/enrollment.ts", "services/filefacts-allowlist.ts", "services/replacement.ts", "services/rollouts.ts", "services/settings.ts", "services/sync-cabinets.ts", "services/watched-services.ts"] },
  case_notes: { owner: "services/case-notes.ts", also: ["demo/troubleshooting.ts"] },
  clients: { owner: "services/admin.ts", also: ["demo/demo.ts", "services/approved-apps.ts", "services/client-scanner.ts", "services/device-settings.ts", "services/enrollment.ts", "services/filefacts-allowlist.ts", "services/firewall-policy.ts", "services/fleet-import.ts", "services/time.ts", "services/watched-services.ts", "services/writes.ts"] },
  commands: { owner: "services/commands.ts", also: ["demo/demo.ts", "services/firewall-policy.ts", "services/fleet-jobs.ts"] },
  config_changes: { owner: "services/config-ingest.ts", also: ["services/maintenance.ts"] },
  config_current: { owner: "services/config-ingest.ts", also: [] },
  config_versions: { owner: "services/config-ingest.ts", also: [] },
  diagnoses: { owner: "diagnose/cabinet.ts", also: ["demo/demo.ts", "diagnose/network.ts", "services/maintenance.ts"] },
  diagnosis_batches: { owner: "diagnose/network.ts", also: ["demo/demo.ts"] },
  drive_samples: { owner: "services/drives.ts", also: ["demo/demo.ts", "services/maintenance.ts"] },
  drive_status: { owner: "services/drives.ts", also: [] },
  enrollment_baselines: { owner: "services/baselines.ts", also: [] },
  enrollment_requests: { owner: "services/enrollment.ts", also: [] },
  error_daily: { owner: "services/error-trends.ts", also: ["demo/demo.ts", "demo/troubleshooting.ts"] },
  events: { owner: "services/events.ts", also: ["demo/demo.ts", "services/alerts.ts", "services/maintenance.ts", "services/rules.ts"] },
  firewall_changes: { owner: "services/commands.ts", also: ["demo/demo.ts", "services/events.ts"] },
  fleet_job_targets: { owner: "services/fleet-jobs.ts", also: ["demo/demo.ts"] },
  fleet_jobs: { owner: "services/fleet-jobs.ts", also: ["demo/demo.ts"] },
  fleet_patterns: { owner: "services/fleet-patterns.ts", also: [] },
  health_hourly: { owner: "services/maintenance.ts", also: [] },
  health_samples: { owner: "services/cabinets.ts", also: ["demo/demo.ts", "services/maintenance.ts", "services/readings.ts"] },
  health_transitions: { owner: "services/cabinet-health.ts", also: ["services/maintenance.ts"] },
  healthy_marks: { owner: "services/cabinet-health.ts", also: [] },
  incident_links: { owner: "services/incidents.ts", also: [] },
  incident_steps: { owner: "services/incidents.ts", also: [] },
  incidents: { owner: "services/incidents.ts", also: ["services/maintenance.ts"] },
  issue_daily: { owner: "services/error-trends.ts", also: ["demo/demo.ts"] },
  issue_types: { owner: "services/rules.ts", also: [] },
  job_leases: { owner: "services/job-lease.ts", also: [] },
  known_fixes: { owner: "services/known-fixes.ts", also: ["demo/demo.ts"] },
  notifications: { owner: "db/db.ts", also: ["services/maintenance.ts"] },
  ops_counters: { owner: "services/ops-meter.ts", also: [] },
  packages: { owner: "services/packages.ts", also: [] },
  replacement_reapply: { owner: "services/replacement-reapply.ts", also: [] },
  replacement_reapply_steps: { owner: "services/replacement-reapply.ts", also: [] },
  rollout_targets: { owner: "services/rollouts.ts", also: [] },
  rollouts: { owner: "services/rollouts.ts", also: [] },
  runbooks: { owner: "services/runbooks.ts", also: [] },
  security_alerts: { owner: "services/security.ts", also: ["db/migrate.ts", "demo/demo.ts", "services/ops-health.ts"] },
  sessions: { owner: "auth/sessions.ts", also: ["console-api/auth-routes.ts", "console-api/fleet-routes.ts"] },
  settings: { owner: "services/settings.ts", also: ["demo/demo.ts", "services/approved-apps.ts", "services/device-settings.ts", "services/filefacts-allowlist.ts", "services/firewall-policy.ts", "services/time.ts", "services/usb-sql.ts", "services/watched-services.ts", "services/writes.ts"] },
  sign_ins: { owner: "auth/sessions.ts", also: [] },
  sites: { owner: "services/admin.ts", also: ["demo/demo.ts", "services/approved-apps.ts", "services/device-settings.ts", "services/enrollment.ts", "services/filefacts-allowlist.ts", "services/firewall-policy.ts", "services/fleet-import.ts", "services/network-baseline.ts", "services/settings.ts", "services/time.ts", "services/watched-services.ts"] },
  step_up_tokens: { owner: "auth/stepup.ts", also: [] },
  symptom_rule_history: { owner: "services/rules.ts", also: [] },
  symptom_rules: { owner: "services/rules.ts", also: ["demo/demo.ts"] },
  trend_state: { owner: "services/error-trends.ts", also: ["demo/troubleshooting.ts"] },
  user_devices: { owner: "auth/devices.ts", also: [] },
  user_networks: { owner: "auth/devices.ts", also: [] },
  users: { owner: "services/users.ts", also: ["cli.ts", "console-api/auth-routes.ts", "demo/demo.ts", "services/auth-failures.ts", "services/writes.ts"] },
};
