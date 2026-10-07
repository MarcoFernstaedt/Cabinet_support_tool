// The approved software library (docs/spec/05-server-spec.md): the only way files reach a cabinet.
// An Admin uploads a driver package or an MSI; the server checks hash, signature and trusted publisher
// before anyone can approve it; a different Admin approves; approved packages are stored read-only and
// are never changed (a change is a new version); retiring blocks further installs.
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import type pg from "pg";
import { audit, safeJson, transaction, type Queryable } from "../db/db.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { PackageRefused, verifyPackage } from "../packages/verify.js";
import type { TrustList } from "../packages/trust.js";
import { Refused } from "./errors.js";

export interface PackageStore { dir: string; maxBytes: number; trust: TrustList; }

export interface PackageMeta { name: string; version: string; vendor: string; packageType: "driver" | "msi"; hardwareIds: string[]; notes?: string; }

const COLUMNS = `p.id, p.name, p.version, p.vendor, p.type, p.hardware_ids, p.notes, p.state, p.sha256, p.size_bytes, p.signer, p.detail, p.refusal,
  p.uploaded_by, ub.name AS uploaded_by_name, p.uploaded_at, p.approved_by, ab.name AS approved_by_name, p.approved_at, p.retired_by, rb.name AS retired_by_name, p.retired_at`;
const FROM = `FROM packages p JOIN users ub ON ub.id = p.uploaded_by LEFT JOIN users ab ON ab.id = p.approved_by LEFT JOIN users rb ON rb.id = p.retired_by`;

type Row = Record<string, unknown> & { id: string; uploaded_at: Date; approved_at: Date | null; retired_at: Date | null };
const view = (r: Row) => ({
  id: r.id, name: r.name, version: r.version, vendor: r.vendor, type: r.type, hardwareIds: r.hardware_ids, notes: r.notes, state: r.state,
  sha256: r.sha256, sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes), signer: r.signer, detail: r.detail, refusal: r.refusal,
  uploadedBy: { id: r.uploaded_by, name: r.uploaded_by_name }, uploadedAt: r.uploaded_at.toISOString(),
  approvedBy: r.approved_by ? { id: r.approved_by, name: r.approved_by_name } : null, approvedAt: r.approved_at?.toISOString() ?? null,
  retiredBy: r.retired_by ? { id: r.retired_by, name: r.retired_by_name } : null, retiredAt: r.retired_at?.toISOString() ?? null,
});

export async function listPackages(db: Queryable, onlyApproved: boolean) {
  const rows = (await db.query<Row>(`SELECT ${COLUMNS} ${FROM} ${onlyApproved ? "WHERE p.state = 'approved'" : ""} ORDER BY p.uploaded_at DESC LIMIT 500`)).rows;
  return rows.map(view);
}

export async function packageById(db: Queryable, id: string) {
  const r = (await db.query<Row>(`SELECT ${COLUMNS} ${FROM} WHERE p.id = $1`, [id])).rows[0];
  return r ? view(r) : null;
}

/** A step-up token from the console, or null for the operator CLI on the server host (recorded as such). */
type Authority = string | null;
const viaCli = (a: Authority) => (a === null ? { via: "cli" } : {});

/** Step 1: what the package is. The file follows. Needs step-up. */
export async function startUpload(pool: pg.Pool, adminId: string, meta: PackageMeta, stepUpToken: Authority): Promise<string> {
  return transaction(pool, async c => {
    if (stepUpToken !== null) await consumeStepUpToken(c, stepUpToken, adminId, "package.upload", "fleet");
    const exists = (await c.query("SELECT 1 FROM packages WHERE name = $1 AND version = $2", [meta.name, meta.version])).rows[0];
    if (exists) throw new Refused("version_exists", 409, "that version already exists; changing a package means uploading a new version");
    const id = randomUUID();
    await c.query(`INSERT INTO packages (id, name, version, vendor, type, hardware_ids, notes, state, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, 'uploading', $8)`,
      [id, meta.name, meta.version, meta.vendor, meta.packageType, safeJson(meta.hardwareIds), meta.notes ?? null, adminId]);
    await audit(c, { actorKind: "user", actorId: adminId, action: "package.upload.start", outcome: "succeeded", details: { packageId: id, ...meta, ...viaCli(stepUpToken) } });
    return id;
  });
}

/** One verification at a time: a package is read into memory to check it. */
let verifying: Promise<unknown> = Promise.resolve();

/**
 * Step 2: the file, streamed to disk with a size cap, then checked. A package that fails is refused and
 * deleted; one that passes is stored read-only under its hash and waits for a second Admin.
 */
export async function receiveUpload(pool: pg.Pool, store: PackageStore, adminId: string, packageId: string, body: Readable): Promise<ReturnType<typeof view>> {
  const row = (await pool.query<{ type: "driver" | "msi"; state: string; uploaded_by: string }>("SELECT type, state, uploaded_by FROM packages WHERE id = $1", [packageId])).rows[0];
  if (!row) throw new Refused("not_found", 404, "no such package");
  if (row.state !== "uploading" || row.uploaded_by !== adminId) throw new Refused("not_uploading", 409, "this package is not waiting for your upload");
  const incoming = join(store.dir, ".incoming");
  await mkdir(incoming, { recursive: true, mode: 0o700 });
  const temp = join(incoming, packageId);
  let size = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _e, done) {
      size += chunk.length;
      if (size > store.maxBytes) done(new Refused("too_large", 413, "the package is larger than the size limit"));
      else done(null, chunk);
    },
  });
  try {
    await pipeline(body, cap, createWriteStream(temp, { mode: 0o600 }));
    const run = verifying.then(async () => verifyPackage(await readFile(temp), row.type, store.trust));
    verifying = run.catch(() => undefined);
    const verified = await run;
    const final = join(store.dir, `${verified.sha256}.pkg`);
    await rename(temp, final);
    await chmod(final, 0o444); // stored read-only
    await transaction(pool, async c => {
      await c.query(`UPDATE packages SET state = 'uploaded', sha256 = $2, size_bytes = $3, signer = $4, detail = $5 WHERE id = $1 AND state = 'uploading'`,
        [packageId, verified.sha256, verified.size, verified.signer, verified.detail]);
      await audit(c, { actorKind: "user", actorId: adminId, action: "package.upload", outcome: "succeeded",
        details: { packageId, sha256: verified.sha256, size: verified.size, signer: verified.signer } });
    });
  } catch (e) {
    await rm(temp, { force: true });
    const reason = e instanceof PackageRefused ? `${e.code}: ${e.message}` : e instanceof Refused ? `${e.code}: ${e.message}` : "the upload did not complete";
    await transaction(pool, async c => {
      await c.query("UPDATE packages SET state = 'refused', refusal = $2 WHERE id = $1 AND state = 'uploading'", [packageId, reason.slice(0, 500)]);
      await audit(c, { actorKind: "user", actorId: adminId, action: "package.upload", outcome: "refused", details: { packageId, reason: reason.slice(0, 500) } });
    });
    if (e instanceof PackageRefused) throw new Refused(e.code, 422, e.message, { reason: e.message });
    throw e;
  }
  return (await packageById(pool, packageId))!;
}

/** The two-person rule: a different Admin approves, with step-up. */
export async function approvePackage(pool: pg.Pool, adminId: string, packageId: string, stepUpToken: Authority): Promise<void> {
  await transaction(pool, async c => {
    if (stepUpToken !== null) await consumeStepUpToken(c, stepUpToken, adminId, "package.approve", packageId);
    const p = (await c.query<{ state: string; uploaded_by: string }>("SELECT state, uploaded_by FROM packages WHERE id = $1 FOR UPDATE", [packageId])).rows[0];
    if (!p) throw new Refused("not_found", 404, "no such package");
    if (p.uploaded_by === adminId) throw new Refused("same_person", 403, "the Admin who uploaded a package cannot approve it");
    if (p.state !== "uploaded") throw new Refused("not_pending", 409, "this package is not waiting for approval");
    await c.query("UPDATE packages SET state = 'approved', approved_by = $2, approved_at = now() WHERE id = $1", [packageId, adminId]);
    await audit(c, { actorKind: "user", actorId: adminId, action: "package.approve", outcome: "succeeded", details: { packageId, ...viaCli(stepUpToken) } });
  });
}

export async function retirePackage(pool: pg.Pool, adminId: string, packageId: string, stepUpToken: Authority): Promise<void> {
  await transaction(pool, async c => {
    if (stepUpToken !== null) await consumeStepUpToken(c, stepUpToken, adminId, "package.retire", packageId);
    const r = await c.query("UPDATE packages SET state = 'retired', retired_by = $2, retired_at = now() WHERE id = $1 AND state IN ('uploaded', 'approved')", [packageId, adminId]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such active package");
    await audit(c, { actorKind: "user", actorId: adminId, action: "package.retire", outcome: "succeeded", details: { packageId, ...viaCli(stepUpToken) } });
  });
}

/**
 * The agent API's download (docs/spec/03-protocol.md): served only while a package.install command for that
 * package and that cabinet is open, and only while the package is approved.
 */
export async function downloadablePath(db: Queryable, store: PackageStore, cabinetId: string, packageId: string): Promise<{ path: string; size: number } | null> {
  const r = (await db.query<{ sha256: string }>(
    `SELECT p.sha256 FROM packages p WHERE p.id = $2 AND p.state = 'approved' AND EXISTS (
       SELECT 1 FROM commands c WHERE c.cabinet_id = $1 AND c.operation = 'package.install' AND c.params->>'packageId' = $2::text
          AND c.status = 'delivered' AND c.delivered_at > now() - interval '30 minutes')`, [cabinetId, packageId])).rows[0];
  if (!r) return null;
  const path = join(store.dir, `${r.sha256}.pkg`);
  try { return { path, size: (await stat(path)).size }; } catch { return null; }
}
