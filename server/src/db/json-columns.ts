// The columns that hold JSON text. A query result column with one of these names is parsed before the rest of the code sees it
// (only objects and arrays, except `value`, which holds any JSON value). test/db.test.ts checks this list against the schema.
export const JSON_COLUMNS: ReadonlySet<string> = new Set([
  "actual", "after", "approved_apps", "before", "cabinet_ids", "commands", "compat", "content", "demo_net", "detail", "details", "device", "environment", "expected", "fields", "findings", "fingerprints",
  "firewall_policy", "firewall_profiles", "frame", "hardware_ids", "in_force", "match", "network_baseline", "origin", "params", "projection", "readings", "reasons", "result", "scanner_hardware_ids",
  "signature", "source", "sync_ports", "value", "versions", "watched_services",
]);
