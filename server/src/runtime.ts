// Shared start-up for the server and the operator CLI.
import { readFileSync } from "node:fs";
import type { Config } from "./config.js";
import { developmentIssuingKey, developmentServerCertificate } from "./pki/issuing.js";
import type { IssuingKey } from "./pki/x509.js";

/**
 * The issuing key. Milestone 2 has only the development key; the KMS-backed
 * IssuingKey replaces this one function (docs/spec/07-upgrade-channel.md).
 */
export async function issuingKey(config: Config): Promise<IssuingKey> {
  if (config.devPkiDir) return developmentIssuingKey(config.devPkiDir);
  throw new Error("No issuing key configured. Set DEV_PKI_DIR for development; the KMS issuing key is configured separately and never enters the repository.");
}

export async function agentApiTls(config: Config, key: IssuingKey): Promise<{ certPem: string; keyPem: string }> {
  if (config.tls.certFile && config.tls.keyFile)
    return { certPem: readFileSync(config.tls.certFile, "utf8"), keyPem: readFileSync(config.tls.keyFile, "utf8") };
  if (config.devPkiDir) return developmentServerCertificate(key, config.devPkiDir, config.agentApi.hostnames);
  throw new Error("Set AGENT_TLS_CERT_FILE and AGENT_TLS_KEY_FILE.");
}
