// Test helpers: certificate requests built with Node's own crypto, temp folders.
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
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

/** Decodes an RFC 4648 base32 setup key (as the console shows it, spaces allowed). */
export function fromBase32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = text.replace(/\s+/g, "").toUpperCase().split("").map(ch => {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error(`not base32: ${ch}`);
    return v.toString(2).padStart(5, "0");
  }).join("");
  return Buffer.from((bits.match(/.{8}/g) ?? []).map(b => parseInt(b, 2)));
}

/** In a browser at "Set up your authenticator": reads the setup key, enters a code from it, and returns the secret. */
export async function setUpAuthenticatorInBrowser(page: { locator(s: string): { textContent(): Promise<string | null> }; getByLabel(l: RegExp | string): { fill(v: string): Promise<void> };
  getByRole(r: "button", o: { name: string }): { click(): Promise<void> } }, codeFor: (secret: Buffer) => string): Promise<Buffer> {
  const secret = fromBase32((await page.locator("code.secret").textContent()) ?? "");
  await page.getByLabel(/6-digit code/).fill(codeFor(secret));
  await page.getByRole("button", { name: "Turn on two-factor" }).click();
  return secret;
}

/** The session cookie ("name=value") from a reply's Set-Cookie header, which is one string or, once a device cookie is set too, a list. */
export const firstCookie = (set: unknown): string | undefined => { const s = Array.isArray(set) ? set[0] : set; return typeof s === "string" ? s.split(";")[0] : undefined; };

/** Where the console's setup page finds agent packages: a folder with a small stand-in package for each architecture. */
export function agentDownloads(port = 8443): { host: string; port: number; downloadDir: string } {
  const downloadDir = mkdtempSync(join(tmpdir(), "agent-download-"));
  for (const name of ["CabinetAgent-win-x64.zip", "CabinetAgent-win-x86.zip"]) writeFileSync(join(downloadDir, name), Buffer.from(`PK\u0003\u0004 ${name}`));
  return { host: "localhost", port, downloadDir };
}
