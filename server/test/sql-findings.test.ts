// The SQL connectivity ladder's findings (D15): what each database.connectivity answer says, and that the module declares exactly the causes
// the rule can raise.
import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseConnectivityOutput } from "@mashura/cabinet-contracts/types";
import type { NetworkEvidence } from "../src/diagnose/network-findings.js";
import { sqlFindings, type DatabaseRun } from "../src/diagnose/sql-findings.js";
import { runNetworkModule, sqlLadderModule } from "../src/diagnose/network-module.js";

const base = (databases: DatabaseRun[], role = "satellite"): NetworkEvidence => ({
  cabinet: { id: "k", name: "Exam 1", role }, policy: { domain: true, private: true, public: true },
  sync: { address: "10.21.9.20", ports: [1433], cabinet: { id: "s", name: "Pharmacy Sync", online: true, minutesSilent: 0, profiles: null } },
  tests: [], databases,
});
const run = (output?: Partial<DatabaseConnectivityOutput>, failure?: string): DatabaseRun => ({
  key: "sync-sql-1433", label: "SQL Server on the sync cabinet", params: { port: 1433 },
  ...(output ? { output: { port: 1433, address: "10.21.9.20", result: "sql_server", tcp: { connected: true, ms: 1 }, prelogin: null, tls: null, error: null, ...output } as DatabaseConnectivityOutput } : { failure: failure ?? "no answer" }),
});
const tls = (problems: ("name_mismatch" | "untrusted_chain" | "missing")[]) => ({ completed: false, ms: 5, protocol: null, problems,
  certificate: { subject: "CN=SSL_Self_Signed_Fallback", issuer: "CN=SSL_Self_Signed_Fallback", notAfter: "2036-10-01T00:00:00Z", sha256: "a".repeat(64), selfSigned: true } });
const ids = (e: NetworkEvidence) => sqlFindings(e).map(f => `${f.id}:${f.severity}`);

test("SQL Server answering is ok, with its version and certificate in the evidence, and says no sign-in was tried", () => {
  const f = sqlFindings(base([run({ prelogin: { answered: true, ms: 3, serverVersion: "16.0.4305", encryption: "off" }, tls: tls(["name_mismatch", "untrusted_chain"]) })]));
  assert.deepEqual(f.map(x => `${x.id}:${x.severity}:${x.layer}`), ["sql-ok:ok:sync"]);
  assert.ok(f[0]!.evidence.some(s => s.includes("16.0.4305")));
  assert.ok(f[0]!.evidence.some(s => s.includes("CN=SSL_Self_Signed_Fallback")));
  assert.ok(f[0]!.evidence.some(s => s.includes("No sign-in")));
});

test("required encryption with a certificate a checking client would not trust is noted; with encryption off it is not", () => {
  const required = { prelogin: { answered: true, ms: 3, serverVersion: "16.0.4305", encryption: "required" as const } };
  assert.deepEqual(ids(base([run({ ...required, tls: tls(["untrusted_chain"]) })])), ["sql-ok:ok", "sql-cert:info"]);
  assert.deepEqual(ids(base([run({ ...required, tls: tls([]) })])), ["sql-ok:ok"], "a trusted certificate says nothing more");
  assert.deepEqual(ids(base([run({ prelogin: { answered: true, ms: 3, serverVersion: "16.0.4305", encryption: "off" }, tls: tls(["untrusted_chain"]) })])), ["sql-ok:ok"]);
});

test("a port that answers but not as SQL Server is a problem; a closed or silent port is left to the port tests", () => {
  assert.deepEqual(ids(base([run({ result: "not_sql_server", prelogin: { answered: false, ms: null, serverVersion: null, encryption: null }, error: "x" })])), ["sql-not-sql:problem"]);
  for (const result of ["refused", "no_answer", "unreachable", "no_sync_cabinet"] as const)
    assert.deepEqual(ids(base([run({ result, tcp: { connected: false, ms: null } })])), [], result);
});

test("a check that did not come back says so; a sync cabinet itself and a plan without the check say nothing", () => {
  assert.deepEqual(ids(base([run(undefined, "no answer within 2 minutes")])), ["sql-nc:info"]);
  assert.deepEqual(ids(base([run({ prelogin: { answered: true, ms: 3, serverVersion: "16.0.4305", encryption: "off" } })], "sync")), []);
  const { databases: _none, ...older } = base([]);
  assert.deepEqual(ids(older), [], "a diagnosis made before the ladder existed");
});

test("the ladder module declares exactly the causes its rule can raise, and the diagnosis runs it after the network module", () => {
  const declared = sqlLadderModule().hypotheses.map(h => h.findingKey).sort();
  assert.deepEqual(declared, ["sql-cert", "sql-nc", "sql-not-sql"]);
  for (const h of sqlLadderModule().hypotheses) {
    const raised = [
      ...sqlFindings(base([run({ result: "not_sql_server", prelogin: { answered: false, ms: null, serverVersion: null, encryption: null } })])),
      ...sqlFindings(base([run({ prelogin: { answered: true, ms: 3, serverVersion: "16.0.4305", encryption: "required" }, tls: tls(["untrusted_chain"]) })])),
      ...sqlFindings(base([run(undefined)])),
    ].filter(f => f.id === h.findingKey);
    assert.ok(raised.length > 0, `${h.findingKey} can be raised`);
    assert.ok(raised.every(f => f.severity === h.severity), `${h.findingKey} is raised at its declared severity`);
  }
  const all = runNetworkModule(base([run({ result: "not_sql_server", prelogin: { answered: false, ms: null, serverVersion: null, encryption: null } })]));
  assert.ok(all.some(f => f.id === "sql-not-sql"), "the network diagnosis's findings include the ladder's");
});
