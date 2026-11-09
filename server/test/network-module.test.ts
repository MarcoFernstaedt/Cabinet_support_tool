// The network diagnosis as a diagnostic module (docs/platform/archive/diagnostic-engine-execution.md, "The foundation in detail", item 4). The
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
import { NETWORK_RULES, networkModule, sqlLadderModule } from "../src/diagnose/network-module.js";
import { AGENT_NETWORK_TESTS_PER_MINUTE, plannedTests } from "../src/diagnose/network.js";
import { loadRegistry } from "../src/diagnose/registry.js";
import { crashModule } from "../src/services/crash-incidents.js";
import { findingKey } from "../src/services/known-fixes.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const source = ["network-findings.ts", "network-observations.ts"].map(f => readFileSync(join(root, "server", "src", "diagnose", f), "utf8")).join("\n");
const PORTS = [445, 1433, 8080, 9100];
const full = plannedTests(4, PORTS);

test("the module is checked, names only the server's rules, and is registered as built", () => {
  const m = networkModule();
  assert.equal(m.id, "network-diagnosis");
  assert.deepEqual(m.procedure.filter(p => p.kind === "rule").map(p => p.rule), Object.keys(NETWORK_RULES));
  const r = loadRegistry(new Map([...cabinetModules(), m, sqlLadderModule(), crashModule()].map(x => [x.id, x])));
  assert.equal(r.capabilities.find(c => c.id === "network-diagnosis")?.status, "built");
});

test("the module declares exactly the reads the diagnosis plans, apart from one TCP test per configured sync port", () => {
  const key = (x: { operation: string; params: Record<string, unknown> }) => `${x.operation} ${JSON.stringify(x.params)}`;
  const planned: { operation: string; params: Record<string, unknown> }[] = [{ operation: "network.config", params: {} }, { operation: "firewall.state", params: {} }, ...full.tests, ...full.traces];
  const perPort = planned.filter(r => r.params.method === "tcp");
  assert.deepEqual(perPort.map(r => r.params.port), PORTS, "the port tests are the configured ports, and only those");
  // Four DNS servers and four ports would be 11 tests, over the agent's limit, so the module's reads are compared with a plan that
  // keeps all four DNS servers (one port); the next test covers what is left out when both are at four.
  const allDns = plannedTests(4, [PORTS[0]!]);
  const declared: { operation: string; params: Record<string, unknown> }[] = [{ operation: "network.config", params: {} }, { operation: "firewall.state", params: {} }, ...allDns.tests, ...allDns.traces];
  assert.deepEqual(networkModule().signals.reads.map(key).sort(), declared.filter(r => r.params.method !== "tcp").map(key).sort());
  // A sync cabinet itself plans no sync tests; one DNS server plans one DNS test.
  const own = plannedTests(1, null);
  assert.deepEqual(own.tests.map(t => t.key), ["gateway", "dns-0", "platform"]);
  assert.deepEqual(own.traces.map(t => t.key), ["trace-platform"]);
});

test("no plan asks the agent for more network tests than it takes in a minute, and DNS servers are what is left out, never ports", () => {
  for (const ports of [null, [], [445], [445, 1433], [445, 1433, 8080], PORTS, [...PORTS, 9200]]) {
    for (let dns = 1; dns <= 4; dns++) {
      const p = plannedTests(dns, ports);
      // The SQL connectivity ladder's check counts against the same limit.
      assert.ok(p.tests.length + p.databases.length <= AGENT_NETWORK_TESTS_PER_MINUTE, `${dns} DNS, ${JSON.stringify(ports)}: ${p.tests.length} tests + ${p.databases.length}`);
      assert.equal(p.databases.length, (ports ?? []).slice(0, 4).includes(1433) ? 1 : 0, "the SQL check runs exactly when 1433 is one of the tested sync ports");
      assert.ok(p.tests.every(t => t.operation === "network.test"));
      const tcp = p.tests.filter(t => t.params.method === "tcp").map(t => t.params.port);
      assert.deepEqual(tcp, (ports ?? []).slice(0, 4), "every configured port up to four is tested");
      const dnsKeys = p.tests.filter(t => t.key.startsWith("dns-")).map(t => t.key);
      assert.deepEqual(dnsKeys, dnsKeys.map((_, i) => `dns-${i}`), "the DNS servers kept are the first ones");
      assert.ok(dnsKeys.length >= 1, "at least one DNS server is always tested");
    }
  }
  // Four DNS servers and four ports, 1433 among them, with the SQL check: two DNS servers fit. Without 1433, three.
  assert.equal(plannedTests(4, PORTS).tests.filter(t => t.key.startsWith("dns-")).length, 2);
  assert.equal(plannedTests(4, PORTS).tests.length + plannedTests(4, PORTS).databases.length, AGENT_NETWORK_TESTS_PER_MINUTE);
  assert.equal(plannedTests(4, [445, 8080, 9100, 3306]).tests.filter(t => t.key.startsWith("dns-")).length, 3);
});

test("the SQL connectivity ladder declares exactly the read the diagnosis plans, and is registered as built", () => {
  const m = sqlLadderModule();
  assert.equal(m.id, "sql-connectivity-ladder");
  const key = (x: { operation: string; params: Record<string, unknown> }) => `${x.operation} ${JSON.stringify(x.params)}`;
  assert.deepEqual(m.signals.reads.map(key), plannedTests(1, [1433]).databases.map(key));
  assert.deepEqual(plannedTests(1, [8080]).databases, [], "no 1433, no SQL check");
  assert.deepEqual(plannedTests(1, null).databases, [], "a sync cabinet itself checks nothing");
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
