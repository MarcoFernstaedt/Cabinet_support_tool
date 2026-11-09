// The update store (docs/spec/07-upgrade-channel.md "Signing flow" step 3; docs/platform/archive/second-architecture.md): signed agent
// releases, each a manifest exactly as the build pipeline had it signed, its detached signature, and the package zip. The
// server checks the signature against the release keys it knows of and the zip against the manifest, so a broken or forged
// release is refused at the door, but none of this is the protection: the server never holds the signing key, and every
// agent checks everything again with the key compiled into it.
//
// A release is one version for one Windows architecture. The architecture is deliberately not a field of the signed
// manifest: that schema is closed, and every already-installed agent validates the manifest with the copy of the schema it
// was built with, so a new field there would make the fleet refuse a manifest it should have accepted. It is declared on the
// record when the release is added, and then checked against the package's own bytes when the package arrives, so a release
// can only ever be served to a cabinet whose agent can actually run it.
import { createHash, createPublicKey, randomUUID, verify, type KeyObject } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { SCHEMA_DIR } from "@mashura/cabinet-contracts/load";
import { consumeStepUpToken } from "../auth/stepup.js";
import { ContractError, releaseFiles, type UpgradeManifest, type UpgradeSignature } from "../contracts.js";
import { audit, lock, safeJson, transaction, type Pool, type Queryable } from "../db/db.js";
import { Refused } from "./errors.js";
import { isArchitecture, missingReleasePrograms, packageArchitecture, PackageArchitectureError, type Architecture } from "./package-architecture.js";
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

/** A release row's package file: the version alone would collide once two architectures share a version, so both name it. */
const packagePath = (store: ReleaseStore, version: string, architecture: string) => join(store.dir, `agent-${version}-${architecture}.zip`);

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
 * go up within one architecture - the x86 and x64 lines are ordered separately, so neither blocks the other -
 * and a rollback is a new release with a higher version.
 */
export async function addRelease(pool: Pool, keys: ReleaseKeys, adminId: string, manifestBase64: string, signature: UpgradeSignature, architecture: Architecture, stepUpToken: Authority): Promise<string> {
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
    await lock(c, "agent_releases");
    // Both rules are per architecture: the x86 and x64 lines are ordered independently, so a version added for one is no
    // reason to refuse it for the other, and neither line can hold the other one back.
    const versions = (await c.query<{ version: string }>("SELECT version FROM agent_releases WHERE architecture = $1 AND state <> 'refused'", [architecture])).rows.map(r => r.version);
    if (versions.includes(manifest.version)) throw new Refused("version_exists", 409, `version ${manifest.version} is already in the update store for ${architecture}`);
    const newest = versions.sort(compareVersions).at(-1);
    if (newest && compareVersions(manifest.version, newest) <= 0)
      throw new Refused("version_not_newer", 409, `releases only go up: ${manifest.version} is not newer than ${newest} for ${architecture} (a rollback is a new release with a higher version)`);
    // A version whose package was refused may be added again (with the right package).
    const releasedAt = new Date(manifest.releasedAt);
    if (Number.isNaN(releasedAt.getTime())) throw new Refused("invalid_manifest", 422, "the signed manifest does not match its contract");
    // The table lock above makes this check-then-write safe. An existing row is replaced only when it was refused.
    await c.query(`IF EXISTS (SELECT 1 FROM agent_releases WHERE [version] = $1 AND [architecture] = $2)
                     UPDATE agent_releases SET manifest = $3, signature = $4, key_id = $5, minimum_version = $6, sha256 = $7, size_bytes = $8, released_at = $9,
                       notes = $10, state = 'awaiting_package', refusal = NULL, added_by = $11, added_at = SYSUTCDATETIME()
                     WHERE [version] = $1 AND [architecture] = $2 AND state = 'refused'
                   ELSE
                     INSERT INTO agent_releases ([version], [architecture], manifest, signature, key_id, minimum_version, sha256, size_bytes, released_at, notes, state, added_by)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'awaiting_package', $11)`,
      [manifest.version, architecture, bytes, safeJson(signature), signature.keyId, manifest.minimumVersion, manifest.sha256, manifest.sizeBytes, releasedAt, manifest.notes ?? null, adminId]);
    await audit(c, { actorKind: "user", actorId: adminId, action: "release.add", targetKind: "release", targetId: manifest.version, outcome: "succeeded",
      details: { version: manifest.version, architecture, minimumVersion: manifest.minimumVersion, sha256: manifest.sha256, sizeBytes: manifest.sizeBytes, keyId: signature.keyId, ...viaCli(stepUpToken) } });
    return manifest.version;
  });
}

/** The temporary file one upload writes to: named for that upload alone, so two uploads of one release never share a file, and
 *  naming the architecture too, so an interrupted upload left in .incoming says which release it was for. */
export function uploadTempName(version: string, architecture: string, nonce: string): string {
  return `agent-${version}-${architecture}.${nonce}.zip`;
}

/** The lock that makes publishing one release's package single-writer (adding a release takes the wider "agent_releases" lock). */
export function releaseLock(version: string, architecture: string): string {
  return `agent_release:${version}:${architecture}`;
}

/** The refusals that mean "these bytes can never be this release's package", so the release goes back with the reason. */
const BAD_PACKAGE: readonly string[] = ["hash_mismatch", "architecture_mismatch", "package_architecture_unknown", "package_not_a_release"];

/**
 * Publishes a finished upload. Under the release's own lock the row is read again, and the statement that makes it ready names every
 * condition once more (still waiting for its package, still the uploader's, the same hash and size) and must change exactly one row:
 * however the world looked when the upload began, only this caller's own, unchanged release can be published here. The file is put in place
 * inside that same lock, so an upload that started earlier cannot land on top of one that has just been published.
 */
async function publishReleasePackage(pool: Pool, store: ReleaseStore, o: { adminId: string; version: string; architecture: string; sha256: string; size: number; temp: string }): Promise<void> {
  const final = packagePath(store, o.version, o.architecture);
  let renamed = false;
  try {
    await transaction(pool, async c => {
      await lock(c, releaseLock(o.version, o.architecture));
      const current = (await c.query<{ state: string; added_by: string; sha256: string; size_bytes: string }>(
        "SELECT state, added_by, sha256, size_bytes FROM agent_releases WITH (UPDLOCK) WHERE version = $1 AND architecture = $2", [o.version, o.architecture])).rows[0];
      if (!current) throw new Refused("not_found", 404, "no such release");
      if (current.added_by !== o.adminId) throw new Refused("not_yours", 403, "only the Admin who added this release can upload its package");
      if (current.state !== "awaiting_package") throw new Refused("not_awaiting_package", 409, "this release is not waiting for its package");
      if (current.sha256 !== o.sha256 || Number(current.size_bytes) !== o.size) throw new Refused("release_changed", 409, "the signed manifest changed while the package was uploading");
      const changed = await c.query(
        `UPDATE agent_releases SET state = 'ready', package_at = SYSUTCDATETIME()
          WHERE version = $1 AND architecture = $2 AND state = 'awaiting_package' AND added_by = $3 AND sha256 = $4 AND size_bytes = $5`,
        [o.version, o.architecture, o.adminId, o.sha256, o.size]);
      if ((changed.rowCount ?? 0) !== 1) throw new Refused("release_changed", 409, "the release changed while the package was uploading");
      await rename(o.temp, final);
      renamed = true;
      await chmod(final, 0o444); // stored read-only, never changed
      await audit(c, { actorKind: "user", actorId: o.adminId, action: "release.package", targetKind: "release", targetId: o.version, outcome: "succeeded",
        details: { version: o.version, architecture: o.architecture, sha256: o.sha256, size: o.size } });
    });
  } catch (e) {
    // The row went back with its transaction, so the file must not stay where a reader could take it for this release's package.
    if (renamed) await rm(final, { force: true });
    throw e;
  }
}

/** Step 2: the package zip, streamed with a size cap and hashed on the way; it must be exactly what the manifest names, and
 *  its programs must be built for the architecture the release was added under. */
export async function receiveReleasePackage(pool: Pool, store: ReleaseStore, adminId: string, version: string, architecture: string, body: Readable) {
  if (!isVersion(version) || !isArchitecture(architecture)) throw new Refused("not_found", 404, "no such release");
  const row = (await pool.query<{ state: string; sha256: string; size_bytes: string; added_by: string }>(
    "SELECT state, sha256, size_bytes, added_by FROM agent_releases WHERE version = $1 AND architecture = $2", [version, architecture])).rows[0];
  if (!row) throw new Refused("not_found", 404, "no such release");
  // Checked here before a byte is read (the route checks it too) and once more, with the row count, when the package is published.
  if (row.added_by !== adminId) throw new Refused("not_yours", 403, "only the Admin who added this release can upload its package");
  if (row.state !== "awaiting_package") throw new Refused("not_awaiting_package", 409, "this release is not waiting for its package");
  const expected = Number(row.size_bytes);
  await mkdir(join(store.dir, ".incoming"), { recursive: true, mode: 0o700 });
  // A file of this upload's own, created with O_EXCL: a leftover of an interrupted run, or another upload of the same release, can never be
  // mistaken for this upload's bytes, and a half-written file is never read as a package.
  const temp = join(store.dir, ".incoming", uploadTempName(version, architecture, randomUUID()));
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
    await pipeline(body, cap, createWriteStream(temp, { flags: "wx", mode: 0o600 }));
    const digest = hash.digest("hex");
    if (size !== expected || digest !== row.sha256) throw new Refused("hash_mismatch", 422, "the package does not match the signed manifest's hash and size");
    // What is on disk is what was hashed, before anything is published.
    if ((await stat(temp)).size !== size) throw new Refused("hash_mismatch", 422, "the package on disk is not the one that was uploaded");
    // The pipeline declares the architecture; the programs inside the package are what it really is. A package that is not
    // the release's own architecture can never be handed to a cabinet of this one, so the mismatch (and a package whose
    // programs cannot be read at all) is refused here, and nothing is published: no file is stored and the row goes back
    // with the reason, so the release may be added again with the right package.
    let derived: Architecture;
    try { derived = packageArchitecture(await readFile(temp)); }
    catch (e) {
      if (!(e instanceof PackageArchitectureError)) throw e;
      throw new Refused("package_architecture_unknown", 422, `the package's architecture cannot be told: ${e.message}`);
    }
    if (derived !== architecture) throw new Refused("architecture_mismatch", 422, `the package's programs are built for ${derived}, but this release is ${architecture}`);
    // A package the updater cannot install must be refused here, not on a cabinet: the machine would report the
    // missing program long after the rollout had been started, and the failure would be charged to the cabinet.
    const missing = missingReleasePrograms(await readFile(temp));
    if (missing.length > 0)
      throw new Refused("package_not_a_release", 422,
        `the package is not a release package: the updater installs one folder per program at the zip root and this package has no ${missing.join(", ")}. `
        + "The installer bundle (CabinetAgent/{install,out}) installs a cabinet but can never be updated to; build the release package with agent/install/New-AgentRelease.ps1.");
    await publishReleasePackage(pool, store, { adminId, version, architecture, sha256: digest, size, temp });
  } catch (e) {
    await rm(temp, { force: true });
    const reason = e instanceof Refused ? `${e.code}: ${e.message}` : "the upload did not complete";
    const refusal = e instanceof Refused && BAD_PACKAGE.includes(e.code);
    await transaction(pool, async c => {
      if (refusal)
        await c.query("UPDATE agent_releases SET state = 'refused', refusal = $3 WHERE version = $1 AND architecture = $2 AND state = 'awaiting_package'", [version, architecture, reason]);
      await audit(c, { actorKind: "user", actorId: adminId, action: "release.package", targetKind: "release", targetId: version, outcome: "refused", details: { version, architecture, reason } });
    });
    throw e;
  }
  return (await listReleases(pool)).find(r => r.version === version && r.architecture === architecture)!;
}

export async function listReleases(db: Queryable) {
  const rows = (await db.query<{ version: string; architecture: string; minimum_version: string; sha256: string; size_bytes: string; released_at: Date; notes: string | null; state: string;
    refusal: string | null; key_id: string; added_by: string; added_by_name: string; added_at: Date; package_at: Date | null }>(
    `SELECT r.version, r.architecture, r.minimum_version, r.sha256, r.size_bytes, r.released_at, r.notes, r.state, r.refusal, r.key_id, r.added_by, u.name AS added_by_name, r.added_at, r.package_at
       FROM agent_releases r JOIN users u ON u.id = r.added_by`)).rows;
  return rows.sort((a, b) => compareVersions(b.version, a.version) || a.architecture.localeCompare(b.architecture)).map(r => ({
    version: r.version, architecture: r.architecture, minimumVersion: r.minimum_version, sha256: r.sha256, sizeBytes: Number(r.size_bytes), releasedAt: r.released_at.toISOString(), notes: r.notes,
    state: r.state, refusal: r.refusal, keyId: r.key_id, addedBy: { id: r.added_by, name: r.added_by_name }, addedAt: r.added_at.toISOString(),
    packageAt: r.package_at?.toISOString() ?? null,
  }));
}

// ---- What an agent may download ------------------------------------------------------------------

/**
 * A cabinet's effective architecture: the one its agent reported, or windows-x64 for an agent built before the field
 * existed. The x86 installer has never been shipped to the field, so every cabinet still NULL was enrolled and has been
 * updated by a win-x64 agent: COALESCE here is what keeps those agents updating exactly as before
 * (server/migrations/0007_architecture.sql). A cabinet that does not exist has no architecture at all.
 */
async function cabinetArchitecture(db: Queryable, cabinetId: string): Promise<Architecture | null> {
  const row = (await db.query<{ architecture: string }>("SELECT COALESCE(architecture, 'windows-x64') AS architecture FROM cabinets WHERE id = $1", [cabinetId])).rows[0];
  return row ? (row.architecture as Architecture) : null;
}

/** A release is served only to a cabinet a running (or just paused) rollout of the same architecture has offered it to. */
async function offeredTo(db: Queryable, cabinetId: string, version: string, architecture: Architecture): Promise<boolean> {
  return !!(await db.query(
    `SELECT 1 FROM rollout_targets t JOIN rollouts r ON r.id = t.rollout_id
      WHERE t.cabinet_id = $1 AND r.version = $2 AND r.architecture = $3 AND t.state = 'offered' AND r.state IN ('running', 'paused')`, [cabinetId, version, architecture])).rows[0];
}

export async function releaseForAgent(db: Queryable, cabinetId: string, version: string): Promise<{ manifest: string; signature: UpgradeSignature } | null> {
  if (!isVersion(version)) return null;
  // The agent asks for a version; which release that is depends on the architecture its own programs were built for, so
  // an agent is never handed the other architecture's manifest.
  const architecture = await cabinetArchitecture(db, cabinetId);
  if (!architecture || !(await offeredTo(db, cabinetId, version, architecture))) return null;
  const r = (await db.query<{ manifest: Buffer; signature: UpgradeSignature }>("SELECT manifest, signature FROM agent_releases WHERE version = $1 AND architecture = $2 AND state = 'ready'", [version, architecture])).rows[0];
  return r ? { manifest: r.manifest.toString("base64"), signature: r.signature } : null;
}

export async function releasePackageForAgent(db: Queryable, store: ReleaseStore, cabinetId: string, version: string): Promise<{ path: string; size: number } | null> {
  if (!isVersion(version)) return null;
  const architecture = await cabinetArchitecture(db, cabinetId);
  if (!architecture || !(await offeredTo(db, cabinetId, version, architecture))) return null;
  if (!(await db.query("SELECT 1 FROM agent_releases WHERE version = $1 AND architecture = $2 AND state = 'ready'", [version, architecture])).rows[0]) return null;
  const path = packagePath(store, version, architecture);
  try { return { path, size: (await stat(path)).size }; } catch { return null; }
}
