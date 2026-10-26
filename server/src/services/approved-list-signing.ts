// The signed approved list (docs/spec/09-open-decisions.md "Signing the approved list"). The cabinet's copy of the list is
// written by the agent's network service, which can be taken over; a list signed with an Admin's key, checked by the broker
// against keys compiled into the agent, is one that process cannot forge. This module is the format and the check:
//
//  - the server writes one level's list as a small JSON document (listDocumentBytes) when an Admin saves it;
//  - the Admin signs those exact bytes on their own computer (agent/install/Sign-ApprovedList.ps1), so the private key never
//    reaches the server;
//  - openSignedList checks the signature first and only then reads the document. The server uses it to refuse a wrong
//    signature at upload; the agent runs the same check again (Cabinet.Agent.Core ApprovedListTrust) and is the one that counts.
//
// The keys are the public halves in contracts/trust/approved-list, the same file the agent compiles in. The release key never
// signs a list: the document's product field and a separate key keep the two apart.
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_DIR } from "@mashura/cabinet-contracts/load";
import { approvedListFiles, ContractError, type ApprovedList, type ApprovedListSignature } from "../contracts.js";

export const LIST_PRODUCT = "mashura-approved-list";
/** The largest document accepted: 32 entries at their longest fit in well under this. */
export const MAX_LIST_DOCUMENT_BYTES = 32 * 1024;

/** The Admin list-signing keys the agent compiles in (contracts/trust/approved-list), or a test folder laid out the same way. */
export class ListSigningKeys {
  private constructor(private readonly keys: Map<string, KeyObject>) {}

  /** No keys: signing is not switched on, and lists apply as they did before it existed. */
  get count(): number { return this.keys.size; }
  get keyIds(): string[] { return [...this.keys.keys()]; }

  static fromFolder(folder = join(SCHEMA_DIR, "..", "trust", "approved-list")): ListSigningKeys {
    const list = approvedListFiles.keys.parse(JSON.parse(readFileSync(join(folder, "approved-list-keys.json"), "utf8")) as unknown);
    const keys = new Map<string, KeyObject>();
    for (const k of list.keys) {
      const der = Buffer.from(k.publicKey, "base64");
      if (createHash("sha256").update(der).digest("hex") !== k.keyId) throw new Error(`List-signing key ${k.name}: its keyId is not the hash of the key.`);
      const key = createPublicKey({ key: der, format: "der", type: "spki" });
      if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error(`List-signing key ${k.name} is not a P-256 key.`);
      keys.set(k.keyId, key);
    }
    return new ListSigningKeys(keys);
  }

  /** Whether the signature over these exact bytes verifies with a held key, and if not, whether the key or the signature is wrong. */
  verify(bytes: Buffer, signature: ApprovedListSignature): "ok" | "key" | "signature" {
    const key = this.keys.get(signature.keyId);
    if (!key) return "key";
    try { return verify("sha256", bytes, { key, dsaEncoding: "der" }, Buffer.from(signature.signature, "base64")) ? "ok" : "signature"; }
    catch { return "signature"; }
  }
}

/** The fields one level's list is signed with. */
export interface ListDocumentFields {
  level: ApprovedList["level"];
  scopeId: string | null;
  version: number;
  issuedAt: string;
  entries: ApprovedList["entries"];
}

/**
 * The exact bytes an Admin signs for one level's list. Written once, when the list is saved, and stored as written: nothing
 * re-serialises it later, so the bytes the Admin signed are the bytes every cabinet checks.
 */
export function listDocumentBytes(fields: ListDocumentFields): Buffer {
  const document: ApprovedList = { product: LIST_PRODUCT, level: fields.level, scopeId: fields.scopeId, version: fields.version,
    issuedAt: fields.issuedAt, entries: fields.entries };
  approvedListFiles.document.parse(document);
  const bytes = Buffer.from(JSON.stringify(document), "utf8");
  if (bytes.length > MAX_LIST_DOCUMENT_BYTES) throw new Error("the approved list is larger than a signed list may be");
  return bytes;
}

export type OpenedList =
  | { ok: true; bytes: Buffer; document: ApprovedList }
  | { ok: false; reason: "key" | "signature" | "document"; why: string };

/**
 * Checks a signed list: the base64 is canonical and small, the signature verifies with a pinned key over those exact bytes,
 * and only then is the document parsed and held to its contract. The order matters: nothing in an unsigned document is read.
 */
export function openSignedList(keys: ListSigningKeys, documentBase64: string, signature: ApprovedListSignature): OpenedList {
  const bytes = Buffer.from(documentBase64, "base64");
  // Canonical base64 only, so the bytes checked are exactly the bytes stored and sent on.
  if (bytes.length === 0 || bytes.length > MAX_LIST_DOCUMENT_BYTES || bytes.toString("base64") !== documentBase64)
    return { ok: false, reason: "document", why: `the list is not canonical base64 of at most ${MAX_LIST_DOCUMENT_BYTES} bytes` };
  if (!approvedListFiles.signature.is(signature)) return { ok: false, reason: "signature", why: "the signature is not an ECDSA P-256 list signature" };
  const signed = keys.verify(bytes, signature);
  if (signed === "key") return { ok: false, reason: "key", why: "the list is signed with a key the agents do not hold" };
  if (signed === "signature") return { ok: false, reason: "signature", why: "the list's signature does not verify" };
  let document: ApprovedList;
  try { document = approvedListFiles.document.parse(JSON.parse(bytes.toString("utf8")) as unknown); }
  catch (e) { return { ok: false, reason: "document", why: e instanceof ContractError ? "the signed list does not match its contract" : "the signed list is not JSON" }; }
  if (document.product !== LIST_PRODUCT) return { ok: false, reason: "document", why: "the signed document is not an approved list" };
  return { ok: true, bytes, document };
}
