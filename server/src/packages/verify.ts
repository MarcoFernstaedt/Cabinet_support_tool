// The server's first gate for the software library (docs/spec/05-server-spec.md): hash, signature and
// trusted publisher, before any Admin can approve a package. The agent repeats every check itself.
import { createHash } from "node:crypto";
import { PackageRefused } from "./asn1.js";
import { checkDriverPackage } from "./driver.js";
import { checkMsi } from "./msi.js";
import type { PackageType, TrustList } from "./trust.js";

export interface Verified { sha256: string; size: number; signer: string; detail: string; }

export function verifyPackage(file: Buffer, type: PackageType, trust: TrustList): Verified {
  const sha256 = createHash("sha256").update(file).digest("hex");
  if (type === "driver") {
    const r = checkDriverPackage(file, trust);
    return { sha256, size: file.length, signer: r.signer.name, detail: `${r.files} files, ${r.infs.length} INF` };
  }
  if (type === "msi") return { sha256, size: file.length, signer: checkMsi(file, trust).signer.name, detail: "MSI installer" };
  throw new PackageRefused("verification_failed", "Only driver packages and MSI installers are accepted.");
}

export { PackageRefused };
