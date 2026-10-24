// Test releases made the way the build pipeline makes them: a P-256 release key (the KMS key in production), a manifest
// signed over its exact bytes, a package zip, and an upgrade-keys folder laid out like contracts/trust/upgrade.
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.js";
import { machineFor, packageArchitecture, type Architecture } from "../src/services/package-architecture.js";
import { type Identity, TestPki, pe, zip } from "./package-pki.js";

export interface ReleaseKey { privateKey: KeyObject; spki: Buffer; keyId: string }

export function releaseKey(): ReleaseKey {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  return { privateKey, spki, keyId: createHash("sha256").update(spki).digest("hex") };
}

const pem = (der: Buffer) => `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;

/** An upgrade trust folder: the release keys, and (for the test agent) the agent publisher under a test root, its signer and chain. */
export function keysFolder(keys: ReleaseKey[], pki?: TestPki, signer?: Identity): string {
  const dir = tempDir();
  const publishers = pki ? [{ commonName: "Mashura Agent Code Signing", organization: "Mashura", root: createHash("sha256").update(pki.root.cert.raw).digest("hex"), rootFile: "agent-root.pem" }] : [];
  writeFileSync(join(dir, "upgrade-keys.json"), JSON.stringify({ version: 1, publishers,
    keys: keys.map((k, i) => ({ keyId: k.keyId, name: `test key ${i}`, publicKey: k.spki.toString("base64") })) }, null, 2));
  if (pki) {
    writeFileSync(join(dir, "agent-root.pem"), pem(pki.root.cert.raw));
    writeFileSync(join(dir, "chain.pem"), pem(pki.intermediate.cert.raw));
    if (signer) writeFileSync(join(dir, "agent-signer.pem"), pem(signer.cert.raw));
  }
  return dir;
}

/** The agent's programs as test binaries the test agent's simulated Authenticode understands, all built for one Windows: the
 *  server reads the machine out of every .exe, so a kit package has to be one the derivation really can read. */
export function agentPackage(architecture: Architecture = "windows-x64", extra: [string, Buffer][] = [], marker = "MZ|signed:agent-signer"): Buffer {
  const program = pe(marker, machineFor(architecture));
  return zip([
    ["Cabinet.Agent.Broker/Cabinet.Agent.Broker.exe", program],
    ["Cabinet.Agent.Harness/cabinet-harness.exe", program],
    ["Cabinet.Agent.Network/Cabinet.Agent.Network.exe", program],
    ["Cabinet.Agent.Updater/Cabinet.Agent.Updater.exe", program],
    ["Cabinet.Agent.Network/notes.json", Buffer.from("{}")],
    ...extra,
  ]);
}

export interface Release { version: string; architecture: Architecture; manifest: string; manifestBytes: Buffer; signature: { keyId: string; algorithm: "ecdsa-p256-sha256"; signature: string }; zip: Buffer }

/** A release as the pipeline makes it: the architecture the caller declares defaults to the one the package's own programs
 *  are built for, which is what the server checks the declaration against - a test that means a mismatch names it. */
export function makeRelease(key: ReleaseKey, version: string, pkg: Buffer = agentPackage(), over: Record<string, unknown> = {},
  architecture: Architecture = packageArchitecture(pkg)): Release {
  const manifest = { product: "mashura-cabinet-agent", version, minimumVersion: "0.0.1", sha256: createHash("sha256").update(pkg).digest("hex"),
    sizeBytes: pkg.length, releasedAt: "2026-10-08T12:00:00Z", ...over };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  return { version, architecture, manifest: manifestBytes.toString("base64"), manifestBytes, zip: pkg,
    signature: { keyId: key.keyId, algorithm: "ecdsa-p256-sha256", signature: sign("sha256", manifestBytes, { key: key.privateKey, dsaEncoding: "der" }).toString("base64") } };
}
