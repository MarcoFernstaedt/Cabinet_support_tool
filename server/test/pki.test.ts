import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createServer, connect } from "node:tls";
import * as der from "../src/pki/der.js";
import { CsrError, verifyCsr } from "../src/pki/x509.js";
import { developmentPlatformPki, developmentIssuingKey, developmentServerCertificate, issueAgentCertificate, AGENT_CERT_DAYS } from "../src/pki/issuing.js";
import { csrFor, ecKey, tempDir } from "./helpers.js";

const CABINET = "9b2d7c1e-5a4f-4e3b-8c2d-1f0e9a8b7c6d";

test("the development CA is self-signed, a CA, and clearly marked", async () => {
  const key = await developmentIssuingKey(tempDir());
  const ca = new X509Certificate(key.certificatePem);
  assert.equal(ca.ca, true);
  assert.ok(ca.subject.includes("DEVELOPMENT ONLY"));
  assert.ok(ca.verify(ca.publicKey));
});

test("the development key refuses to run in production", async () => {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try { await assert.rejects(developmentIssuingKey(tempDir()), /production/); }
  finally { if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before; }
});

test("an agent certificate names the cabinet, is for client auth only, and chains to the CA", async () => {
  const key = await developmentIssuingKey(tempDir());
  const issued = await issueAgentCertificate(key, csrFor(ecKey(), "ignored-subject"), CABINET);
  const cert = new X509Certificate(issued.pem);
  assert.ok(cert.subject.includes(`CN=${CABINET}`), "the server, not the request, decides the subject");
  assert.ok(cert.verify(new X509Certificate(key.certificatePem).publicKey));
  assert.ok(cert.checkIssued(new X509Certificate(key.certificatePem)));
  assert.equal(cert.ca, false);
  assert.deepEqual(cert.keyUsage, ["1.3.6.1.5.5.7.3.2"]);
  assert.ok(cert.subjectAltName?.includes(`URI:urn:mashura:cabinet:${CABINET}`));
  const days = (issued.notAfter.getTime() - Date.now()) / 86_400_000;
  assert.ok(days > AGENT_CERT_DAYS - 1 && days <= AGENT_CERT_DAYS);
  assert.match(issued.serialHex, /^[0-9A-F]+$/);
});

test("openssl agrees the issued certificates are valid", { skip: !existsSync("/usr/bin/openssl") }, async () => {
  const dir = tempDir();
  const key = await developmentIssuingKey(dir);
  const agentKey = ecKey();
  const issued = await issueAgentCertificate(key, csrFor(agentKey), CABINET);
  writeFileSync(join(dir, "agent.pem"), issued.pem);
  const out = execFileSync("/usr/bin/openssl", ["verify", "-CAfile", join(dir, "dev-issuing-ca.cert.pem"), "-purpose", "sslclient", join(dir, "agent.pem")]).toString();
  assert.match(out, /OK/);
  const server = await developmentServerCertificate(key, dir, ["localhost", "127.0.0.1"]);
  writeFileSync(join(dir, "server.pem"), server.certPem);
  assert.match(execFileSync("/usr/bin/openssl", ["verify", "-CAfile", join(dir, "dev-issuing-ca.cert.pem"), "-purpose", "sslserver", join(dir, "server.pem")]).toString(), /OK/);
  // A request openssl itself made is accepted.
  execFileSync("/usr/bin/openssl", ["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", join(dir, "o.key"), "-out", join(dir, "o.csr"), "-subj", "/CN=x"]);
  await issueAgentCertificate(key, (await import("node:fs")).readFileSync(join(dir, "o.csr"), "utf8"), CABINET);
});

test("a real mutual-TLS handshake works with the issued certificates", async () => {
  const dir = tempDir();
  const key = await developmentIssuingKey(dir);
  const serverCert = await developmentServerCertificate(key, dir, ["localhost"]);
  const agentKey = ecKey();
  const agentCert = await issueAgentCertificate(key, csrFor(agentKey), CABINET);
  const server = createServer({ key: serverCert.keyPem, cert: serverCert.certPem, ca: key.certificatePem, requestCert: true, rejectUnauthorized: true },
    socket => { socket.end(String((socket.getPeerCertificate() as { subject?: { CN?: string } }).subject?.CN)); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const reply = await new Promise<string>((resolve, reject) => {
    const s = connect({ host: "127.0.0.1", port, servername: "localhost", ca: key.certificatePem, key: agentKey.keyPem, cert: agentCert.pem }, () => {});
    let data = ""; s.on("data", d => (data += d)); s.on("end", () => resolve(data)); s.on("error", reject);
  });
  server.close();
  assert.equal(reply, CABINET);
});

test("hostile and unacceptable certificate requests are refused", async () => {
  const key = await developmentIssuingKey(tempDir());
  const good = csrFor(ecKey());
  const rsa1024 = generateKeyPairSync("rsa", { modulusLength: 1024 });
  const cases: [string, string][] = [
    ["empty", ""],
    ["not PEM", "hello"],
    ["tampered signature", csrFor(ecKey(), "x", true)],
    ["weak RSA key", csrFor({ ...rsa1024, keyPem: "" })],
    ["wrong curve", csrFor(ecKey("secp256k1"))],
    ["truncated", good.slice(0, 200) + "\n-----END CERTIFICATE REQUEST-----\n"],
    ["garbage DER", "-----BEGIN CERTIFICATE REQUEST-----\n" + Buffer.from([0x30, 0x84, 0xff, 0xff, 0xff, 0xff]).toString("base64") + "\n-----END CERTIFICATE REQUEST-----\n"],
    ["deep nesting", "-----BEGIN CERTIFICATE REQUEST-----\n" + Buffer.from(Array(40).fill([0x30, 0x80]).flat()).toString("base64") + "\n-----END CERTIFICATE REQUEST-----\n"],
    ["huge", "-----BEGIN CERTIFICATE REQUEST-----\n" + "A".repeat(20_000) + "\n-----END CERTIFICATE REQUEST-----\n"],
  ];
  for (const [label, pem] of cases) {
    assert.throws(() => verifyCsr(pem), CsrError, label);
    await assert.rejects(issueAgentCertificate(key, pem, CABINET), CsrError, label);
  }
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.ok(verifyCsr(csrFor({ ...rsa, keyPem: "" })), "RSA 2048 is accepted");
});

test("the DER decoder refuses malformed lengths and trailing bytes", () => {
  for (const bytes of [[0x30], [0x30, 0x05, 0x01], [0x30, 0x80, 0x00, 0x00], [0x02, 0x01, 0x00, 0xff], [0x1f, 0x01, 0x00]])
    assert.throws(() => der.decode(Buffer.from(bytes)), der.DerError);
  assert.equal(der.oidToString(der.decode(der.oid("1.2.840.10045.4.3.2"))), "1.2.840.10045.4.3.2");
  assert.deepEqual(der.decode(der.integer(0)).value, Buffer.from([0]));
  assert.deepEqual(der.decode(der.integer(128)).value, Buffer.from([0, 128]));
});


test("acceptance PKI pins the self-signed direct issuer and serves exactly leaf plus CA", async () => {
  const { rootPem, issuingKey, tls } = await developmentPlatformPki(tempDir(), ["localhost", "127.0.0.1"]);
  const root = new X509Certificate(rootPem);
  const issuing = new X509Certificate(issuingKey.certificatePem);
  assert.equal(root.subject, root.issuer);
  assert.ok(root.ca && root.verify(root.publicKey));
  assert.equal(issuing.subject, issuing.issuer);
  assert.equal(issuingKey.certificatePem, rootPem);
  assert.ok(issuing.checkIssued(root) && issuing.verify(root.publicKey));
  assert.equal(tls.certPem.match(/BEGIN CERTIFICATE/g)?.length, 2);
  const leaf = new X509Certificate(tls.certPem);
  assert.ok(leaf.checkIssued(issuing) && leaf.verify(issuing.publicKey));
  assert.equal(leaf.checkHost("localhost"), "localhost");
  assert.equal(leaf.checkIP("127.0.0.1"), "127.0.0.1");
});

test("acceptance leaf validates with only platform-ca.pem and no supplied intermediate", { skip: !existsSync("/usr/bin/openssl") }, async () => {
  const dir = tempDir();
  const { rootPem, tls } = await developmentPlatformPki(dir, ["localhost"]);
  writeFileSync(join(dir, "platform-ca.pem"), rootPem);
  // Deliberately discard the server's supplied chain, as AgentApiClient does.
  writeFileSync(join(dir, "leaf.pem"), new X509Certificate(tls.certPem).toString());
  assert.match(execFileSync("/usr/bin/openssl", ["verify", "-CAfile", join(dir, "platform-ca.pem"),
    "-no-CApath", "-no-CAstore", "-purpose", "sslserver", "-verify_hostname", "localhost", join(dir, "leaf.pem")]).toString(), /OK/);
});

test("acceptance TLS validates using only the root and rejects wrong hosts and roots", async () => {
  const { rootPem, tls } = await developmentPlatformPki(tempDir(), ["localhost", "127.0.0.1"]);
  const server = createServer({ cert: tls.certPem, key: tls.keyPem }, socket => socket.end("trusted"));
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  async function request(ca: string, servername: string) {
    return new Promise<string>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port, ca, servername, rejectUnauthorized: true });
      let data = "";
      socket.on("data", chunk => data += chunk);
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
  }
  try {
    assert.equal(await request(rootPem, "localhost"), "trusted");
    assert.equal(await request(rootPem, "127.0.0.1"), "trusted");
    await assert.rejects(request(rootPem, "wrong.example"), /does not match/);
    const stranger = await developmentIssuingKey(tempDir());
    await assert.rejects(request(stranger.certificatePem, "localhost"));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
