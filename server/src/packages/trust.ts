// The trusted publisher list (contracts/trust), the same file the agent compiles in. A signer is
// trusted when its common name and organization match an entry exactly and its chain, built only
// from the certificates in the signature, ends at that entry's pinned root.
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAjv, ref, SCHEMA_DIR } from "@mashura/cabinet-contracts/load";
import { list, oid, read, value } from "./asn1.js";

export type PackageType = "driver" | "msi";
export interface Publisher { name: string; commonName: string; organization: string; root: string; packageTypes: PackageType[]; reason: string; }
export interface TrustedPublishers { version: number; roots: { name: string; sha256: string; file: string }[]; publishers: Publisher[]; }

export class TrustList {
  private readonly roots = new Map<string, X509Certificate>();

  constructor(readonly list: TrustedPublishers, rootsBySha: Map<string, X509Certificate>) {
    for (const r of list.roots) {
      const cert = rootsBySha.get(r.sha256);
      if (!cert || sha256(cert.raw) !== r.sha256) throw new Error(`The trusted root ${r.name} does not match its pinned hash.`);
      this.roots.set(r.sha256, cert);
    }
  }

  /** contracts/trust, or another folder with the same layout (tests). */
  static fromFolder(folder = join(SCHEMA_DIR, "..", "trust")): TrustList {
    const parsed = JSON.parse(readFileSync(join(folder, "trusted-publishers.json"), "utf8")) as unknown;
    const validate = createAjv().getSchema(ref("agent/trusted-publishers.schema.json"))!;
    if (!validate(parsed)) throw new Error("The trusted publisher list does not match its contract.");
    const tp = parsed as TrustedPublishers;
    return new TrustList(tp, new Map(tp.roots.map(r => {
      const c = new X509Certificate(readFileSync(join(folder, r.file)));
      return [sha256(c.raw), c] as const;
    })));
  }

  /** The publisher entry this signer matches for the package type, or null. */
  match(signer: X509Certificate, certificates: X509Certificate[], type: PackageType): Publisher | null {
    const { cn, o } = names(signer);
    for (const p of this.list.publishers) {
      if (!p.packageTypes.includes(type) || cn !== p.commonName || o !== p.organization) continue;
      if (chainsTo(signer, certificates, this.roots.get(p.root)!)) return p;
    }
    return null;
  }
}

export const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** Walks issuer by issuer, checking each signature, until the pinned root (validity dates are Windows' check, with the timestamp). */
function chainsTo(leaf: X509Certificate, pool: X509Certificate[], root: X509Certificate): boolean {
  let current = leaf;
  const candidates = [...pool, root];
  for (let depth = 0; depth < 8; depth++) {
    if (current.raw.equals(root.raw)) return true;
    const issuer = candidates.find(c => !c.raw.equals(current.raw) && current.checkIssued(c) && (c.ca || c.raw.equals(root.raw)) && safeVerify(current, c));
    if (!issuer) return false;
    if (issuer.raw.equals(root.raw)) return true;
    current = issuer;
  }
  return false;
}

function safeVerify(cert: X509Certificate, issuer: X509Certificate): boolean {
  try { return cert.verify(issuer.publicKey); } catch { return false; }
}

/** The subject's common name and organization, read from the certificate's encoding (exact, single values). */
export function names(cert: X509Certificate): { cn: string | null; o: string | null } {
  const tbs = list(list(read(cert.raw))[0]!);
  let i = 0;
  if (tbs[0]!.tag === 0xa0) i++;
  const subject = tbs[i + 4]!;
  let cn: string | null = null, o: string | null = null;
  for (const rdn of list(subject, 64)) for (const atv of list(rdn)) {
    const [t, v] = list(atv);
    const type = oid(t!);
    const text = v!.tag === 0x1e ? value(v!).swap16().toString("utf16le") : value(v!).toString("utf8");
    if (type === "2.5.4.3") cn = text;
    if (type === "2.5.4.10") o = text;
  }
  return { cn, o };
}
