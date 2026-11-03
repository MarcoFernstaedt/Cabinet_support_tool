import test from "node:test";
import assert from "node:assert/strict";
import { sqlCheckRows, sqlResultText, type DatabaseOutput } from "../src/lib/sql-check.ts";

const answered: DatabaseOutput = {
  port: 1433, address: "10.20.0.20", result: "sql_server", tcp: { connected: true, ms: 2 },
  prelogin: { answered: true, ms: 3.1, serverVersion: "16.0.4305", encryption: "off" },
  tls: { completed: false, ms: 6.4, protocol: null, problems: ["name_mismatch", "untrusted_chain"],
    certificate: { subject: "CN=SSL_Self_Signed_Fallback", issuer: "CN=SSL_Self_Signed_Fallback", notAfter: "2036-10-01T00:00:00Z", sha256: "a".repeat(64), selfSigned: true } },
  error: null,
};
const labels = (o: DatabaseOutput) => sqlCheckRows(o).map(([k]) => k);

test("a SQL Server that answered shows every step it reached", () => {
  const rows = new Map(sqlCheckRows(answered));
  for (const k of ["Address", "Result", "TCP", "Pre-login", "Server version", "Encryption", "TLS handshake", "Certificate", "Certificate problems"]) assert.ok(rows.has(k), k);
  assert.match(rows.get("Server version")!, /16\.0\.4305/);
  assert.match(rows.get("Certificate")!, /self-signed/);
  assert.ok(!rows.has("Stopped because"));
});

test("a port that did not connect shows no later step and says why it stopped", () => {
  const o: DatabaseOutput = { port: 1433, address: "10.20.0.20", result: "no_answer", tcp: { connected: false, ms: null }, prelogin: null, tls: null, error: "No answer on TCP port 1433 within 5 seconds." };
  assert.deepEqual(labels(o), ["Address", "Result", "TCP", "Stopped because"]);
});

test("no sync cabinet and unknown values never come out blank", () => {
  const o: DatabaseOutput = { port: 1433, address: null, result: "no_sync_cabinet", tcp: { connected: false, ms: null }, prelogin: null, tls: null, error: "no sync cabinet" };
  for (const [k, v] of sqlCheckRows(o)) assert.ok(v.trim().length > 0, k);
  assert.equal(sqlResultText("something_new"), "something_new");
  const odd = { ...answered, prelogin: { ...answered.prelogin!, encryption: "weird" as never }, tls: { ...answered.tls!, problems: ["new_problem" as never] } };
  for (const [k, v] of sqlCheckRows(odd)) assert.ok(v.trim().length > 0, k);
});
