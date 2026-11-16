// Certificate issuing for the agent API. All signing goes through
// IssuingKey.signTbs: the development key below, or the KMS in production.
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { issue, issuerOf, verifyCsr, type IssuedCertificate, type IssuingKey } from "./x509.js";

export const AGENT_CERT_DAYS = 90;
/** Agents renew once less than this much validity remains. */
export const AGENT_RENEW_DAYS = 30;
const DAY = 86_400_000;

/**
 * DEVELOPMENT ONLY. A P-256 issuing key in a local folder, standing in for
 * the KMS key the production server will use. Refuses to run when NODE_ENV is
 * production. The folder must stay outside the repository (see .gitignore).
 */
export async function developmentIssuingKey(dir: string): Promise<IssuingKey> {
  if (process.env.NODE_ENV === "production") throw new Error("The development issuing key cannot be used in production. Configure the KMS issuing key.");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = join(dir, "dev-issuing-ca.key.pem");
  const certPath = join(dir, "dev-issuing-ca.cert.pem");
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const spki = publicKey.export({ format: "der", type: "spki" });
    const now = Date.now();
    const ca = await issue(
      { kind: "ca", commonName: "Mashura Cabinet Platform DEVELOPMENT ONLY issuing CA", organization: "Mashura (development)",
        notBefore: new Date(now - 60_000), notAfter: new Date(now + 5 * 365 * DAY) },
      spki, async tbs => sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" }), { name: Buffer.alloc(0), spki });
    writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    writeFileSync(certPath, ca.pem);
  }
  const privateKey = createPrivateKey(readFileSync(keyPath));
  const certificatePem = readFileSync(certPath, "utf8");
  return { certificatePem, signTbs: async tbs => sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" }) };
}

/** A client certificate for one cabinet: CN and SAN URI carry the cabinet ID; usable only for TLS client authentication. */
export async function issueAgentCertificate(key: IssuingKey, csrPem: string, cabinetId: string, now = new Date()): Promise<IssuedCertificate> {
  const csr = verifyCsr(csrPem);
  return issue(
    { kind: "agent", commonName: cabinetId, organization: "Mashura cabinet agent", uri: `urn:mashura:cabinet:${cabinetId}`,
      notBefore: new Date(now.getTime() - 5 * 60_000), notAfter: new Date(now.getTime() + AGENT_CERT_DAYS * DAY) },
    csr.spki, key.signTbs, issuerOf(key.certificatePem));
}

/** DEVELOPMENT ONLY: a TLS server certificate for the agent API, so agents can pin the same issuing CA. */
export async function developmentServerCertificate(key: IssuingKey, dir: string, hostnames: string[]): Promise<{ certPem: string; keyPem: string }> {
  const certPath = join(dir, "dev-agent-api.cert.pem");
  const keyPath = join(dir, "dev-agent-api.key.pem");
  const wanted = JSON.stringify(hostnames);
  const namesPath = join(dir, "dev-agent-api.names.json");
  if (existsSync(certPath) && existsSync(keyPath) && existsSync(namesPath) && readFileSync(namesPath, "utf8") === wanted)
    return { certPem: readFileSync(certPath, "utf8"), keyPem: readFileSync(keyPath, "utf8") };
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const now = Date.now();
  const ips = hostnames.filter(h => /^\d{1,3}(\.\d{1,3}){3}$/.test(h));
  const cert = await issue(
    { kind: "server", commonName: hostnames[0] ?? "localhost", organization: "Mashura (development)",
      dnsNames: hostnames.filter(h => !ips.includes(h)), ipAddresses: ips,
      notBefore: new Date(now - 60_000), notAfter: new Date(now + 365 * DAY) },
    publicKey.export({ format: "der", type: "spki" }), key.signTbs, issuerOf(key.certificatePem));
  const keyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  writeFileSync(keyPath, keyPem, { mode: 0o600 });
  writeFileSync(certPath, cert.pem);
  writeFileSync(namesPath, wanted);
  return { certPem: cert.pem, keyPem };
}

/** Fresh acceptance PKI: one self-signed CA directly signs the server leaf.
 * The agent builds its own chain from the leaf alone and this pinned CA.
 * Serve the complete leaf-first chain; never reuse a cached demo CA.
 */
export async function developmentPlatformPki(dir: string, hostnames: string[]): Promise<{
  rootPem: string; issuingKey: IssuingKey; tls: { certPem: string; keyPem: string };
}> {
  if (process.env.NODE_ENV === "production") throw new Error("Development PKI cannot be used in production");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const freshDir = mkdtempSync(join(dir, "acceptance-pki-"));
  const issuingKey = await developmentIssuingKey(freshDir);
  const tls = await developmentServerCertificate(issuingKey, freshDir, hostnames);
  // The issuing CA is itself the root and the agent's platform-ca.pem.
  return { rootPem: issuingKey.certificatePem, issuingKey,
    tls: { ...tls, certPem: tls.certPem + issuingKey.certificatePem } };
}
