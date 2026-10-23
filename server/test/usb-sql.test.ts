// The USB layer's SQL against the migration: every table and column a statement names has to exist in
// migrations/0001_baseline.sql, every placeholder has to have a parameter behind it, and the keys and literals the
// statements rely on have to be the ones the rest of the layer and the schema actually use.
//
// Why this test exists: usb-store.ts is the only file in the layer that needs a live SQL Server, so without this the
// statements are unverified text. It is what catches a column that does not exist — cabinets carries no removed_at (the
// migration marks a removed cabinet with status = 'removed'), and an earlier draft of usb-store.ts would have failed at
// run time with "Invalid column name 'removed_at'".
// No database, no cabinet, no driver.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  USB_INCIDENT_SIGNATURE_PREFIX, usbIssueCatalogParams, usbIssueCatalogSql, usbOpenIncidentsParams, usbOpenIncidentsSql,
  usbPolicyDeleteParams, usbPolicyDeleteSql, usbPolicyLevelsParams, usbPolicyLevelsSql, usbPolicyRowParams,
  usbPolicyRowSql, usbResolveIncidentParams, usbResolveIncidentSql, usbScopeExistsParams, usbScopeExistsSql,
} from "../src/services/usb-sql.js";
import { USB_ISSUE_KEYS, USB_RULE_IDS, usbPolicySettingKey } from "../src/services/usb-policy.js";
import { usbIncidentKey } from "../src/services/usb-rules.js";

/** The migration is the schema's own word; the test reads it rather than keeping a second copy of the columns. */
const DDL = readFileSync(new URL("../../migrations/0001_baseline.sql", import.meta.url), "utf8");

/** Words that are not column names when they turn up in a statement. */
const KEYWORDS = new Set([
  "select", "from", "where", "and", "or", "not", "in", "is", "null", "like", "on", "join", "left", "right", "inner",
  "outer", "full", "as", "update", "delete", "set", "with", "forceseek", "values", "distinct", "order", "by", "group",
  "having", "case", "when", "then", "else", "end", "exists", "between", "asc", "desc", "top", "cross", "apply", "union",
  "all", "into", "insert", "convert", "lower", "sysutcdatetime", "dateadd", "getutcdate",
]);

/** A match group as a string (the project compiles with unchecked indexed access off the table). */
const group = (m: RegExpMatchArray, index: number): string => m[index] ?? "";

/** Every table the migration creates, with the columns it declares (constraints are not columns). */
function tables(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const block of DDL.matchAll(/CREATE TABLE\s+(\w+)\s*\(([\s\S]*?)\n\)/g)) {
    const columns = new Set<string>();
    for (const line of group(block, 2).split("\n")) {
      if (/^\s*CONSTRAINT\b/i.test(line)) continue;
      const column = /^\s*\[(\w+)\]\s+\S/.exec(line);
      if (column) columns.add(group(column, 1).toLowerCase());
    }
    found.set(group(block, 1).toLowerCase(), columns);
  }
  return found;
}

const DDL_TABLES = tables();

/** One table's columns, with the test failing loudly if the table is not in the migration at all. */
function columnsOf(table: string): Set<string> {
  const columns = DDL_TABLES.get(table);
  assert.ok(columns !== undefined, `the migration has no table ${table}`);
  return columns;
}

/** Checks one statement: its tables, its columns, its aliases and its placeholders. */
function checkStatement(name: string, sql: string, params: readonly unknown[]): void {
  const text = sql.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();

  const placeholders = [...text.matchAll(/\$(\d+)/g)].map(m => Number(group(m, 1)));
  const highest = placeholders.length === 0 ? 0 : Math.max(...placeholders);
  assert.equal(highest, params.length, `${name}: the statement uses ${highest} placeholders but carries ${params.length} parameters (${JSON.stringify(params)})`);

  const alias = new Map<string, string>();
  const named = new Set<string>();
  for (const m of text.matchAll(/\b(?:FROM|JOIN)\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?/gi)) {
    const table = group(m, 1).toLowerCase();
    named.add(table);
    const aliasToken = group(m, 2).toLowerCase();
    if (aliasToken !== "" && !KEYWORDS.has(aliasToken)) alias.set(aliasToken, table);
  }
  assert.ok(named.size > 0, `${name}: the statement names no table at all`);
  for (const table of named) columnsOf(table);

  for (const m of text.matchAll(/(\w+)\.\[?(\w+)\]?/g)) {
    const table = alias.get(group(m, 1).toLowerCase());
    if (table === undefined) {
      assert.ok(!/^[a-z]$/.test(group(m, 1)), `${name}: ${group(m, 1)} is used as an alias but never named in a FROM or JOIN`);
      continue;
    }
    assert.ok(columnsOf(table).has(group(m, 2).toLowerCase()), `${name}: ${table} has no column ${group(m, 2)}`);
  }

  const update = /\bUPDATE\s+(\w+)\s+SET\s+([\s\S]*?)(?=\bFROM\b|\bWHERE\b|$)/i.exec(text);
  if (update) {
    const target = alias.get(group(update, 1).toLowerCase()) ?? group(update, 1).toLowerCase();
    const columns = columnsOf(target);
    for (const assignment of group(update, 2).split(",")) {
      const column = /^\s*\[?(\w+)\]?\s*=/.exec(assignment);
      if (column) assert.ok(columns.has(group(column, 1).toLowerCase()), `${name}: ${target} has no column ${group(column, 1)}`);
    }
  }

  // A statement over one table can also name columns without an alias; every one of those has to be a column of it.
  if (named.size === 1) {
    const table = [...named][0] ?? "";
    const columns = columnsOf(table);
    for (const m of text.matchAll(/\[(\w+)\]/g)) assert.ok(columns.has(group(m, 1).toLowerCase()), `${name}: ${table} has no column ${group(m, 1)}`);
    const where = /\bWHERE\s+([\s\S]*)$/i.exec(text);
    if (where) {
      const withoutLiterals = group(where, 1)
        .replace(/'[^']*'/g, " ")
        .replace(/\$\d+/g, " ")
        .replace(/\([^)]*\)/g, " ")
        .replace(new RegExp(`\\b(${[...alias.keys()].join("|") || "\\u0000"})\\.`, "gi"), "");
      for (const m of withoutLiterals.matchAll(/\b([a-z_]\w*)\b/gi)) {
        const token = group(m, 1).toLowerCase();
        if (KEYWORDS.has(token)) continue;
        assert.ok(columns.has(token), `${name}: ${table} has no column ${token}`);
      }
    }
  }
}

test("the migration the statements are checked against is the real one", () => {
  assert.ok(DDL_TABLES.size >= 20, `only ${DDL_TABLES.size} tables parsed out of the migration`);
  for (const table of ["alerts", "settings", "cabinets", "sites", "clients", "issue_types"]) columnsOf(table);
  // A client and a site are removed with a timestamp; a cabinet is not — it has no removed_at column at all.
  assert.equal(columnsOf("clients").has("removed_at"), true);
  assert.equal(columnsOf("sites").has("removed_at"), true);
  assert.equal(columnsOf("cabinets").has("removed_at"), false, "cabinets gained a removed_at column: usbScopeExistsSql has to follow it");
  assert.match(DDL, /cabinets_status_check.*'removed'/, "a removed cabinet is marked with status = 'removed'");
  // The alert columns the layer reads and writes.
  for (const column of ["cabinet_id", "severity", "signature", "state", "occurrences", "last_seen", "resolved_at", "resolution"]) {
    assert.ok(columnsOf("alerts").has(column), `alerts has no column ${column}`);
  }
  // Severities and states are constrained, so the words the rules and the statements use are the only ones allowed.
  assert.match(DDL, /alerts_severity_check\] CHECK \(severity IN \('major', 'minor'\)\)/);
  assert.match(DDL, /alerts_state_check\] CHECK \(state IN \('open', 'claimed', 'resolved'\)\)/);
});

test("the four-level policy read names tables and columns that exist, with a parameter per placeholder", () => {
  checkStatement("usbPolicyLevelsSql", usbPolicyLevelsSql, usbPolicyLevelsParams("6f1d1f9e-3d3a-4a5b-8f0e-1b2c3d4e5f60"));
  // The fleet key is the prefix every other key is built on, so the join that reads it is the plain one.
  assert.match(usbPolicyLevelsSql, /LEFT JOIN settings f ON f\.\[key\] = \$2/);
  for (const level of ["cabinet", "site", "client"]) {
    assert.ok(usbPolicyLevelsSql.includes(`N'.${level}.'`), `the join for the ${level} level is missing`);
  }
});

test("a scope's existence is asked the way that scope's table can answer it", () => {
  const id = "6f1d1f9e-3d3a-4a5b-8f0e-1b2c3d4e5f60";
  checkStatement("usbScopeExistsSql.client", usbScopeExistsSql.client, usbScopeExistsParams(id));
  checkStatement("usbScopeExistsSql.site", usbScopeExistsSql.site, usbScopeExistsParams(id));
  checkStatement("usbScopeExistsSql.cabinet", usbScopeExistsSql.cabinet, usbScopeExistsParams(id));
  assert.match(usbScopeExistsSql.client, /removed_at IS NULL/);
  assert.match(usbScopeExistsSql.site, /removed_at IS NULL/);
  // Not removed_at: cabinets has no such column, and asking for it fails the statement outright.
  assert.match(usbScopeExistsSql.cabinet, /status <> 'removed'/);
  assert.equal(/removed_at/.test(usbScopeExistsSql.cabinet), false);
});

test("the stored-document statements read and clear exactly the one settings row", () => {
  checkStatement("usbPolicyRowSql", usbPolicyRowSql, usbPolicyRowParams("cabinet", "6f1d1f9e-3d3a-4a5b-8f0e-1b2c3d4e5f60"));
  checkStatement("usbPolicyDeleteSql", usbPolicyDeleteSql, usbPolicyDeleteParams("fleet", null));
  assert.match(usbPolicyRowSql, /FROM settings/);
  assert.match(usbPolicyDeleteSql, /^DELETE FROM settings/);
  // The settings key is nvarchar(450); every key the layer builds has to fit it.
  const longest = usbPolicySettingKey("cabinet", "6f1d1f9e-3d3a-4a5b-8f0e-1b2c3d4e5f60");
  assert.ok(longest.length <= 450, `a settings key is ${longest.length} characters, over the column's 450`);
});

test("the issue catalogue asks for the keys the rules actually raise", () => {
  checkStatement("usbIssueCatalogSql", usbIssueCatalogSql, usbIssueCatalogParams());
  const raised = USB_RULE_IDS.map(ruleId => USB_ISSUE_KEYS[ruleId]);
  for (const key of raised) assert.ok(usbIssueCatalogSql.includes(`'${key}'`), `the catalogue does not ask for ${key}, which ${USB_RULE_IDS.join("/")} raises`);
  assert.equal(raised.length, new Set(raised).size, "two rules share one issue key");
});

test("the incident read and the resolution update speak the same signature the rules build", () => {
  const id = "6f1d1f9e-3d3a-4a5b-8f0e-1b2c3d4e5f60";
  checkStatement("usbOpenIncidentsSql", usbOpenIncidentsSql, usbOpenIncidentsParams(id));
  checkStatement("usbResolveIncidentSql", usbResolveIncidentSql, usbResolveIncidentParams(id, "usb:absent:UNIT-1", "text"));
  // The read selects the incidents the rules build, and the update seeks the same way the read does.
  assert.match(usbOpenIncidentsSql, new RegExp(`a\\.signature LIKE '${USB_INCIDENT_SIGNATURE_PREFIX}%'`));
  assert.match(usbResolveIncidentSql, /a\.cabinet_id = \$1 AND a\.signature = \$2/);
  assert.equal(usbIncidentKey("usb-absent", "UNIT-1").startsWith(USB_INCIDENT_SIGNATURE_PREFIX), true, "an incident key does not start with the prefix the read filters on");
  // Closing an incident is one update over the open rows only, exactly as alerts.ts closes an offline alert.
  assert.match(usbResolveIncidentSql, /SET state = 'resolved', resolved_at = SYSUTCDATETIME\(\), resolution = \$3/);
  assert.match(usbResolveIncidentSql, /a\.state <> 'resolved'/);
});

test("a statement that names a column no table has is refused by this test's own checker", () => {
  // The checker is only worth as much as its own failure mode: feed it the mistake it caught, and watch it fail.
  assert.throws(
    () => checkStatement("bogus", "SELECT 1 AS ok FROM cabinets WHERE id = $1 AND removed_at IS NULL", ["id"]),
    /cabinets has no column removed_at/,
  );
  assert.throws(
    () => checkStatement("bogus", "SELECT [value] FROM settings WHERE [key] = $1 AND [nothing_like_this] = $2", ["a", "b"]),
    /settings has no column nothing_like_this/,
  );
  assert.throws(
    () => checkStatement("bogus", "SELECT [value] FROM settings WHERE [key] = $3", ["a"]),
    /3 placeholders but carries 1 parameters/,
  );
});
