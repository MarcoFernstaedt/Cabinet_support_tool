// The update store (docs/spec/07-upgrade-channel.md "Signing flow" step 3): signed agent releases, each a manifest
// exactly as the build pipeline had it signed, its detached signature, and the package zip. The server checks the
// signature against the release keys it knows of and the zip against the manifest, so a broken or forged release is
// refused at the door, but none of this is the protection: the server never holds the signing key, and every agent
// checks everything again with the key compiled into it.
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type pg from "pg";
import { SCHEMA_DIR } from "@mashura/cabinet-contracts/load";
import { consumeStepUpToken } from "../auth/stepup.js";
import { ContractError, releaseFiles, type UpgradeManifest, type UpgradeSignature } from "../contracts.js";
import { audit, safeJson, transaction, type Queryable } from "../db/db.js";
import { Refused } from "./errors.js";
import { raiseSecurityAlert } from "./security.js";

export const PRODUCT = "mashura-cabinet-agent";
export const MAX_MANIFEST_BYTES = 4096;

// ---- Versions ------------------------------------------------------------------------------------

const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:-([0-9A-Za-z.-]{1,32}))?$/;

export function isVersion(v: unknown): v is string {
  return typeof v === "string" && VERSION.test(v) && !(v.split("-")[1] ?? "x").split(".").some(id => id === "");
}

/** Semantic-version order: negative when a is older than b. A pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION.exec(a), pb = VERSION.exec(b);
  if (!pa || !pb) throw new Error("not a version");
  for (let i = 1; i <= 3; i++) { const d = Number(pa[i]) - Number(pb[i]); if (d !== 0) return Math.sign(d); }
  const ra = pa[4], rb = pb[4];
  if (ra === rb) return 0;
  if (ra === undefined) return 1;
  if (rb === undefined) return -1;
  const xa = ra.split("."), xb = rb.split(".");
  for (let i = 0; i < Math.min(xa.length, xb.length); i++) {
    const na = /^[0-9]+$/.test(xa[i]!), nb = /^[0-9]+$/.test(xb[i]!);
    const d = na && nb ? Math.sign(Number(xa[i]) - Number(xb[i])) : na ? -1 : nb ? 1 : xa[i]! < xb[i]! ? -1 : xa[i]! > xb[i]! ? 1 : 0;
    if (d !== 0) return d;
  }
  return Math.sign(xa.length - xb.length);
}

// ---- Release keys --------------------------------------------------------------------------------

/** The release keys the agent compiles in (contracts/trust/upgrade), or a test folder laid out the same way. */
export class ReleaseKeys {
  private constructor(private readonly keys: Map<string, KeyObject>) {}

  get count(): number { return this.keys.size; }

  static fromFolder(folder = join(SCHEMA_DIR, "..", "trust", "upgrade")): ReleaseKeys {
    const parsed = JSON.parse(readFileSync(join(folder, "upgrade-keys.json"), "utf8")) as unknown;
    const list = releaseFiles.keys.parse(parsed);
    const keys = new Map<string, KeyObject>();
    for (const k of list.keys) {
      const der = Buffer.from(k.publicKey, "base64");
      if (createHash("sha256").update(der).digest("hex") !== k.keyId) throw new Error(`Release key ${k.name}: its keyId is not the hash of the key.`);
      const key = createPublicKey({ key: der, format: "der", type: "spki" });
      if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error(`Release key ${k.name} is not a P-256 key.`);
      keys.set(k.keyId, key);
    }
    return new ReleaseKeys(keys);
  }

  /** Whether the signature over the manifest's exact bytes verifies with a held key. */
  verify(manifest: Buffer, signature: UpgradeSignature): { ok: true } | { ok: false; why: string } {
    if (this.keys.size === 0) return { ok: false, why: "no release key is configured, so no release can be accepted" };
    if (signature.algorithm !== "ecdsa-p256-sha256") return { ok: false, why: "unsupported signature algorithm" };
    const key = this.keys.get(signature.keyId);
    if (!key) return { ok: false, why: "the manifest is signed with a key the agents do not hold" };
    try {
      return verify("sha256", manifest, { key, dsaEncoding: "der" }, Buffer.from(signature.signature, "base64"))
        ? { ok: true } : { ok: false, why: "the manifest's signature does not verify" };
    } catch {
      return { ok: false, why: "the manifest's signature does not verify" };
    }
  }
}

export interface ReleaseStore { dir: string; maxBytes: number; keys: ReleaseKeys }

const packagePath = (store: ReleaseStore, version: string) => join(store.dir, `agent-${version}.zip`);

// ---- Adding a release ----------------------------------------------------------------------------

type Authority = string | null;
const viaCli = (a: Authority) => (a === null ? { via: "cli" } : {});

/** Reads and checks a manifest: the signature first, then its contract. Throws Refused. */
export function checkManifest(keys: ReleaseKeys, manifestBase64: string, signature: UpgradeSignature): { bytes: Buffer; manifest: UpgradeManifest } {
  const bytes = Buffer.from(manifestBase64, "base64");
  // Canonical base64 only, so the bytes checked are exactly the bytes stored and served.
  if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES || bytes.toString("base64") !== manifestBase64)
    throw new Refused("invalid_manifest", 422, "the manifest is not canonical base64 of at most 4 KB");
  const signed = keys.verify(bytes, signature);
  if (!signed.ok) throw new Refused("signature_invalid", 422, signed.why);
  let manifest: UpgradeManifest;
  try { manifest = releaseFiles.manifest.parse(JSON.parse(bytes.toString("utf8"))); }
  catch (e) { throw new Refused("invalid_manifest", 422, e instanceof ContractError ? "the signed manifest does not match its contract" : "the signed manifest is not JSON"); }
  if (manifest.product !== PRODUCT) throw new Refused("invalid_manifest", 422, "the signed manifest is not for the cabinet agent");
  if (compareVersions(manifest.minimumVersion, manifest.version) >= 0) throw new Refused("invalid_manifest", 422, "the minimum version must be older than the release");
  return { bytes, manifest };
}

/**
 * Step 1: the signed manifest and its signature, with step-up. A release with a bad signature is refused,
 * audited and raised as a security alert (someone tried to put code in front of the fleet). Versions only ever
 * go up: a rollback is a new release with a higher version.
 */
export async function addRelease(pool: pg.Pool, keys: ReleaseKeys, adminId: string, manifestBase64: string, signature: UpgradeSignature, stepUpToken: Authority): Promise<string> {
  let checked: ReturnType<typeof checkManifest>;
  try { checked = checkManifest(keys, manifestBase64, signature); }
  catch (e) {
    if (!(e instanceof Refused)) throw e;
    await transaction(pool, async c => {
      if (stepUpToken !== null) await consumeStepUpToken(c, stepUpToken, adminId, "release.add", "fleet");
      await audit(c, { actorKind: "user", actorId: adminId, action: "release.add", outcome: "refused", details: { reason: `${e.code}: ${e.message}`, keyId: signature.keyId, ...viaCli(stepUpToken) } });
      if (e.code === "signature_invalid")
        await raiseSecurityAlert(c, { kind: "signature_failure", signature: `release_signature|${signature.keyId}`, userId: adminId,
          title: "An agent release with an invalid signature was uploaded", detail: { reason: e.message, keyId: signature.keyId } });
    });
    throw e;
  }
  const { bytes, manifest } = checked;
  return transaction(pool, async c => {
    if (stepUpToken !== null) await consumeStepUpToken(c, stepUpToken, adminId, "release.add", "fleet");
    await c.query("LOCK TABLE agent_releases IN SHARE ROW EXCLUSIVE MODE");
    const versions = (await c.query<{ version: string }>("SELECT version FROM agent_releases WHERE state <> 'refused'")).rows.map(r => r.version);
    if (versions.includes(manifest.version)) throw new Refused("version_exists", 409, "that version is already in the update store");
    const newest = versions.sort(compareVersions).at(-1);
    if (newest && compareVersions(manifest.version, newest) <= 0)
      throw new Refused("version_not_newer", 409, `releases only go up: ${manifest.version} is not newer than ${newest} (a rollback is a new release with a higher version)`);
    // A version whose package was refused may be added again (with the right package).
    await c.query(`INSERT INTO agent_releases (version, manifest, signature, key_id, minimum_version, sha256, size_bytes, released_at, notes, state, added_by)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'awaiting_package', $10)
                   ON CONFLICT (version) DO UPDATE SET manifest = EXCLUDED.manifest, signature = EXCLUDED.signature, key_id = EXCLUDED.key_id,
                     minimum_version = EXCLUDED.minimum_version, sha256 = EXCLUDED.sha256, size_bytes = EXCLUDED.size_bytes, released_at = EXCLUDED.released_at,
                     notes = EXCLUDED.notes, state = 'awaiting_package', refusal = NULL, added_by = EXCLUDED.added_by, added_at = now()
                   WHERE agent_releases.state = 'refused'`,
      [manifest.version, bytes, safeJson(signature), signature.keyId, manifest.minimumVersion, manifest.sha256, manifest.sizeBytes, manifest.releasedAt, manifest.notes ?? null, adminId]);
    await audit(c, { actorKind: "user", actorId: adminId, action: "release.add", targetKind: "release", targetId: manifest.version, outcome: "succeeded",
      details: { version: manifest.version, minimumVersion: manifest.minimumVersion, sha256: manifest.sha256, sizeBytes: manifest.sizeBytes, keyId: signature.keyId, ...viaCli(stepUpToken) } });
    return manifest.version;
  });
}

/** Step 2: the package zip, streamed with a size cap and hashed on the way; it must be exactly what the manifest names. */
export async function receiveReleasePackage(pool: pg.Pool, store: ReleaseStore, adminId: string, version: string, body: Readable) {
  if (!isVersion(version)) throw new Refused("not_found", 404, "no such release");
  const row = (await pool.query<{ state: string; sha256: string; size_bytes: string }>("SELECT state, sha256, size_bytes FROM agent_releases WHERE version = $1", [version])).rows[0];
  if (!row) throw new Refused("not_found", 404, "no such release");
  if (row.state !== "awaiting_package") throw new Refused("not_awaiting_package", 409, "this release is not waiting for its package");
  const expected = Number(row.size_bytes);
  await mkdir(join(store.dir, ".incoming"), { recursive: true, mode: 0o700 });
  const temp = join(store.dir, ".incoming", `agent-${version}.zip`);
  const hash = createHash("sha256");
  let size = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _e, done) {
      size += chunk.length;
      if (size > Math.min(expected, store.maxBytes)) done(new Refused("hash_mismatch", 422, "the package is larger than the signed manifest says"));
      else { hash.update(chunk); done(null, chunk); }
    },
  });
  try {
    await pipeline(body, cap, createWriteStream(temp, { mode: 0o600 }));
    const digest = hash.digest("hex");
    if (size !== expected || digest !== row.sha256) throw new Refused("hash_mismatch", 422, "the package does not match the signed manifest's hash and size");
    const final = packagePath(store, version);
    await rename(temp, final);
    await chmod(final, 0o444); // stored read-only, never changed
    await transaction(pool, async c => {
      await c.query("UPDATE agent_releases SET state = 'ready', package_at = now() WHERE version = $1 AND state = 'awaiting_package'", [version]);
      await audit(c, { actorKind: "user", actorId: adminId, action: "release.package", targetKind: "release", targetId: version, outcome: "succeeded", details: { version, sha256: digest, size } });
    });
  } catch (e) {
    await rm(temp, { force: true });
    const reason = e instanceof Refused ? `${e.code}: ${e.message}` : "the upload did not complete";
    await transaction(pool, async c => {
      if (e instanceof Refused && e.code === "hash_mismatch")
        await c.query("UPDATE agent_releases SET state = 'refused', refusal = $2 WHERE version = $1 AND state = 'awaiting_package'", [version, reason]);
      await audit(c, { actorKind: "user", actorId: adminId, action: "release.package", targetKind: "release", targetId: version, outcome: "refused", details: { version, reason } });
    });
    throw e;
  }
  return (await listReleases(pool)).find(r => r.version === version)!;
}

export async function listReleases(db: Queryable) {
  const rows = (await db.query<{ version: string; minimum_version: string; sha256: string; size_bytes: string; released_at: Date; notes: string | null; state: string;
    refusal: string | null; key_id: string; added_by: string; added_by_name: string; added_at: Date; package_at: Date | null }>(
    `SELECT r.version, r.minimum_version, r.sha256, r.size_bytes, r.released_at, r.notes, r.state, r.refusal, r.key_id, r.added_by, u.name AS added_by_name, r.added_at, r.package_at
       FROM agent_releases r JOIN users u ON u.id = r.added_by`)).rows;
  return rows.sort((a, b) => compareVersions(b.version, a.version)).map(r => ({
    version: r.version, minimumVersion: r.minimum_version, sha256: r.sha256, sizeBytes: Number(r.size_bytes), releasedAt: r.released_at.toISOString(), notes: r.notes,
    state: r.state, refusal: r.refusal, keyId: r.key_id, addedBy: { id: r.added_by, name: r.added_by_name }, addedAt: r.added_at.toISOString(),
    packageAt: r.package_at?.toISOString() ?? null,
  }));
}

// ---- What an agent may download ------------------------------------------------------------------

/** A release is served only to a cabinet a running (or just paused) rollout has offered it to. */
async function offeredTo(db: Queryable, cabinetId: string, version: string): Promise<boolean> {
  return !!(await db.query(
    `SELECT 1 FROM rollout_targets t JOIN rollouts r ON r.id = t.rollout_id
      WHERE t.cabinet_id = $1 AND r.version = $2 AND t.state = 'offered' AND r.state IN ('running', 'paused')`, [cabinetId, version])).rows[0];
}

export async function releaseForAgent(db: Queryable, cabinetId: string, version: string): Promise<{ manifest: string; signature: UpgradeSignature } | null> {
  if (!isVersion(version) || !(await offeredTo(db, cabinetId, version))) return null;
  const r = (await db.query<{ manifest: Buffer; signature: UpgradeSignature }>("SELECT manifest, signature FROM agent_releases WHERE version = $1 AND state = 'ready'", [version])).rows[0];
  return r ? { manifest: r.manifest.toString("base64"), signature: r.signature } : null;
}

export async function releasePackageForAgent(db: Queryable, store: ReleaseStore, cabinetId: string, version: string): Promise<{ path: string; size: number } | null> {
  if (!isVersion(version) || !(await offeredTo(db, cabinetId, version))) return null;
  if (!(await db.query("SELECT 1 FROM agent_releases WHERE version = $1 AND state = 'ready'", [version])).rows[0]) return null;
  const path = packagePath(store, version);
  try { return { path, size: (await stat(path)).size }; } catch { return null; }
}
