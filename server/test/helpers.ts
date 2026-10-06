// Test helpers: certificate requests built with Node's own crypto, temp folders.
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as der from "../src/pki/der.js";
import { OID, toPem } from "../src/pki/x509.js";

export const tempDir = (): string => mkdtempSync(join(tmpdir(), "cabinet-server-test-"));

export interface TestKey { privateKey: KeyObject; publicKey: KeyObject; keyPem: string; }

export function ecKey(curve = "prime256v1"): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: curve });
  return { privateKey, publicKey, keyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString() };
}

/** A PKCS#10 request like the agent sends (it builds the same with .NET's CertificateRequest). */
export function csrFor(key: TestKey, commonName = "cabinet-agent", tamper = false): string {
  const info = der.sequence(
    der.integer(0),
    der.sequence(der.set(der.sequence(der.oid(OID.commonName), der.utf8(commonName)))),
    key.publicKey.export({ format: "der", type: "spki" }),
    der.context(0, Buffer.alloc(0)),
  );
  const isRsa = key.publicKey.asymmetricKeyType === "rsa";
  const signature = sign("sha256", info, isRsa ? key.privateKey : { key: key.privateKey, dsaEncoding: "der" });
  if (tamper) signature[signature.length - 1] = signature[signature.length - 1]! ^ 0xff;
  return toPem(der.sequence(info, der.sequence(der.oid(isRsa ? OID.rsaSha256 : OID.ecdsaSha256), ...(isRsa ? [der.nullValue()] : [])), der.bitString(signature)), "CERTIFICATE REQUEST");
}
