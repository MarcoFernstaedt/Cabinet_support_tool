// The network diagnosis as a diagnostic module (docs/platform/diagnostic-engine-execution.md, "The foundation in detail", item 4). The
// diagnosis now runs the module's rule step instead of calling networkFindings by hand; its behaviour is unchanged, which the existing
// network tests prove (they are not edited). These tests keep the module honest against the code: the same reads the diagnosis plans,
// every finding the checks can raise declared as a cause (a check that only ever reports "ok" is not a cause), and every fix button
// the checks offer declared as a repair with its verification.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cabinetModules } from "../src/diagnose/cabinet-findings.js";
import { NETWORK_RULES, networkModule } from "../src/diagnose/network-module.js";
import { plannedTests } from "../src/diagnose/network.js";
import { loadRegistry } from "../src/diagnose/registry.js";
import { findingKey } from "../src/services/known-fixes.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const source = ["network-findings.ts", "network-observations.ts"].map(f => readFileSync(join(root, "server", "src", "diagnose", f), "utf8")).join("\n");
const PORTS = [445, 1433, 8080, 9100];
const full = plannedTests(4, PORTS);

test("the module is checked, names only the server's rules, and is registered as built", () => {
  const m = networkModule();
  assert.equal(m.id, "network-diagnosis");
  assert.deepEqual(m.procedure.filter(p => p.kind === "rule").map(p => p.rule), Object.keys(NETWORK_RULES));
  const r = loadRegistry(new Map([...cabinetModules(), m].map(x => [x.id, x])));
  assert.equal(r.capabilities.find(c => c.id === "network-diagnosis")?.status, "built");
});

test("the module declares exactly the reads the diagnosis plans, apart from one TCP test per configured sync port", () => {
  const key = (x: { operation: string; params: Record<string, unknown> }) => `${x.operation} ${JSON.stringify(x.params)}`;
  const planned: { operation: string; params: Record<string, unknown> }[] = [{ operation: "network.config", params: {} }, { operation: "firewall.state", params: {} }, ...full.tests, ...full.traces];
  const perPort = planned.filter(r => r.params.method === "tcp");
  assert.deepEqual(perPort.map(r => r.params.port), PORTS, "the port tests are the configured ports, and only those");
  assert.deepEqual(networkModule().signals.reads.map(key).sort(), planned.filter(r => r.params.method !== "tcp").map(key).sort());
  // A sync cabinet itself plans no sync tests; one DNS server plans one DNS test.
  const own = plannedTests(1, null);
  assert.deepEqual(own.tests.map(t => t.key), ["gateway", "dns-0", "platform"]);
  assert.deepEqual(own.traces.map(t => t.key), ["trace-platform"]);
});

/** Every `add({ id: …, severity: … })` in the checks, with each id's placeholders filled in from the planned tests. */
function raised(): { key: string; ok: boolean }[] {
  const out: { key: string; ok: boolean }[] = [];
  const marker = "add({ id: ";
  for (let i = source.indexOf(marker); i >= 0; i = source.indexOf(marker, i + 1)) {
    const from = i + marker.length, quote = source[from]!;
    const id = source.slice(from + 1, source.indexOf(quote, from + 1));
    const rest = source.slice(source.indexOf(quote, from + 1) + 1, source.indexOf(quote, from + 1) + 40);
    const ok = rest.startsWith(', severity: "ok"');
    const fills = id.includes("${t.key}") ? (id.startsWith("dns-") ? full.tests.filter(t => t.key.startsWith("dns-")) : full.tests.filter(t => t.key.startsWith("sync-"))).map(t => id.replace("${t.key}", t.key))
      : id.includes("${where}") ? ["sync", "platform"].map(w => id.replace("${where}", w))
      : [id.replace("${a.interfaceIndex}", "3")];
    for (const f of fills) { assert.ok(!f.includes("${"), `unfilled placeholder in ${id}`); out.push({ key: findingKey(f), ok }); }
  }
  return out;
}

test("every finding the checks can raise is a declared cause, and every declared cause is one they can raise", () => {
  const all = raised();
  assert.ok(all.length > 40, "the scan finds the checks");
  const causes = new Set(all.filter(r => !r.ok).map(r => r.key));
  assert.deepEqual([...causes].sort(), networkModule().hypotheses.map(h => h.findingKey).sort());
  // Passed checks are not causes: dns-ok, sync-ok, baseline-ok, obs-ping-ok, obs-arp-ok and obs-dhcp only ever say "ok".
  for (const k of ["dns-ok", "sync-ok", "baseline-ok", "obs-ping-ok", "obs-arp-ok", "obs-dhcp"]) assert.ok(!causes.has(k), k);
});

/** How the console turns each kind of network fix into a catalog operation (console/src/components/NetworkFix.tsx). */
const KIND_OPERATION: Record<string, string> = { apply_policy: "firewall.applyPolicy", set_dns: "network.setDns", renew_lease: "network.renewLease", use_dhcp: "network.setIp", set_static: "network.setIp" };

test("every fix the checks offer is a declared repair, run as the console runs it, and verified by a read", () => {
  const fix = readFileSync(join(root, "console", "src", "components", "NetworkFix.tsx"), "utf8");
  for (const [kind, op] of Object.entries(KIND_OPERATION)) assert.ok(fix.includes(`case "${kind}": return { operation: "${op}"`), `${kind} runs ${op}`);
  const kinds = new Set<string>();
  const marker = 'action: { kind: "';
  for (let i = source.indexOf(marker); i >= 0; i = source.indexOf(marker, i + 1)) kinds.add(source.slice(i + marker.length, source.indexOf('"', i + marker.length)));
  kinds.delete("open");
  assert.deepEqual([...kinds].sort(), Object.keys(KIND_OPERATION).sort(), "every fix kind the checks offer is known here");
  const offered = new Set([...kinds].map(k => KIND_OPERATION[k]!));
  const m = networkModule();
  assert.deepEqual([...new Set(m.remediation.map(r => r.operation))].sort(), [...offered].sort());
  for (const r of m.remediation) assert.notEqual(r.verification.kind, "none", r.id);
  // The sync cabinet's firewall is changed on the sync cabinet, so it is verified by reaching it, not by this cabinet's firewall.
  assert.deepEqual(m.remediation.find(r => r.forHypotheses.includes("sync_firewall"))?.verification, { kind: "functional", read: "sync_ping" });
});
