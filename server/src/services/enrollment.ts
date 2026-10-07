// Bootstrap tokens, enrollment requests, the pending queue and approval
// (docs/spec/05-server-spec.md "Enrollment and certificates").
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { EnrollRequest, EnrollStatus } from "../contracts.js";
import { audit, safeJson, transaction, type Queryable } from "../db/db.js";
import { issueAgentCertificate } from "../pki/issuing.js";
import type { IssuingKey } from "../pki/x509.js";
import { CsrError, verifyCsr } from "../pki/x509.js";
import { Refused } from "./errors.js";

export const TOKEN_DAYS = 7;
const hashToken = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

/** Creates a single-use bootstrap token. The token is returned once and only its hash is stored. */
export async function createBootstrapToken(pool: pg.Pool, userId: string, days = TOKEN_DAYS): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + days * 86_400_000);
  await transaction(pool, async c => {
    await c.query("INSERT INTO bootstrap_tokens (id, token_hash, created_by, expires_at) VALUES ($1, $2, $3, $4)", [id, hashToken(token), userId, expiresAt]);
    await audit(c, { actorKind: "user", actorId: userId, action: "token.create", targetKind: "token", targetId: id, outcome: "succeeded", details: { expiresAt: expiresAt.toISOString() } });
  });
  return { token, expiresAt };
}

/**
 * Stores an enrollment request and consumes its token. Any problem with the
 * token gets the same answer, so the endpoint does not reveal whether a
 * token exists, was used or expired.
 */
export async function submitEnrollment(pool: pg.Pool, request: EnrollRequest, sourceAddress: string): Promise<string> {
  try { verifyCsr(request.csr); }
  catch (e) { if (e instanceof CsrError) throw new Refused("invalid_request", 400, e.message); throw e; }
  return transaction(pool, async c => {
    const token = (await c.query<{ id: string }>(
      "UPDATE bootstrap_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING id",
      [hashToken(request.bootstrapToken)])).rows[0];
    if (!token) {
      throw new Refused("enrollment_refused", 403, "unknown, used or expired bootstrap token");
    }
    const id = randomUUID();
    await c.query("INSERT INTO enrollment_requests (id, token_id, csr, fingerprints, source_address, status) VALUES ($1, $2, $3, $4, $5, 'pending')",
      [id, token.id, request.csr, safeJson(request.fingerprints), sourceAddress]);
    await audit(c, { actorKind: "agent", actorId: request.fingerprints.hostname, action: "enrollment.submit", targetKind: "enrollment", targetId: id, outcome: "succeeded",
      details: { hostname: request.fingerprints.hostname, serialNumber: request.fingerprints.serialNumber, source: sourceAddress } });
    return id;
  });
}

export async function enrollmentStatus(db: Queryable, requestId: string): Promise<Omit<EnrollStatus, "serverTime"> | null> {
  const row = (await db.query<{ status: string; certificate_pem: string | null; cabinet_id: string | null }>(
    "SELECT status, certificate_pem, cabinet_id FROM enrollment_requests WHERE id = $1", [requestId])).rows[0];
  if (!row) return null;
  if (row.status === "issued") return { requestId, status: "issued", certificate: row.certificate_pem!, cabinetId: row.cabinet_id! };
  return { requestId, status: row.status === "rejected" ? "rejected" : "pending" };
}

export interface PendingRequest { id: string; createdAt: Date; sourceAddress: string | null; fingerprints: EnrollRequest["fingerprints"]; }

export async function pendingRequests(db: Queryable): Promise<PendingRequest[]> {
  return (await db.query<{ id: string; created_at: Date; source_address: string | null; fingerprints: EnrollRequest["fingerprints"] }>(
    "SELECT id, created_at, source_address, fingerprints FROM enrollment_requests WHERE status = 'pending' ORDER BY created_at")).rows
    .map(r => ({ id: r.id, createdAt: r.created_at, sourceAddress: r.source_address, fingerprints: r.fingerprints }));
}

export interface Approval { clientName: string; siteName: string; cabinetName: string; role: "sync" | "satellite" | "standalone"; }

/** Approves a pending request: places the cabinet, signs its certificate and records both. */
export async function approveEnrollment(pool: pg.Pool, key: IssuingKey, requestId: string, approval: Approval, userId: string): Promise<{ cabinetId: string; serial: string }> {
  return transaction(pool, async c => {
    const request = (await c.query<{ csr: string; fingerprints: EnrollRequest["fingerprints"] }>(
      "SELECT csr, fingerprints FROM enrollment_requests WHERE id = $1 AND status = 'pending' FOR UPDATE", [requestId])).rows[0];
    if (!request) throw new Refused("not_pending", 409, "that enrollment request is not pending");
    await c.query("INSERT INTO clients (id, name) VALUES ($1, $2) ON CONFLICT (name) WHERE removed_at IS NULL DO NOTHING", [randomUUID(), approval.clientName]);
    const client = (await c.query<{ id: string }>("SELECT id FROM clients WHERE name = $1 AND removed_at IS NULL", [approval.clientName])).rows[0]!;
    await c.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, $3) ON CONFLICT (client_id, name) WHERE removed_at IS NULL DO NOTHING", [randomUUID(), client.id, approval.siteName]);
    const site = (await c.query<{ id: string }>("SELECT id FROM sites WHERE client_id = $1 AND name = $2 AND removed_at IS NULL", [client.id, approval.siteName])).rows[0]!;
    const cabinetId = randomUUID();
    try {
      await c.query(`INSERT INTO cabinets (id, site_id, name, role, status, hostname, serial_number, agent_version)
                     VALUES ($1, $2, $3, $4, 'active', $5, $6, $7)`,
        [cabinetId, site.id, approval.cabinetName, approval.role, request.fingerprints.hostname, request.fingerprints.serialNumber, request.fingerprints.agentVersion]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new Refused("name_taken", 409, "a cabinet with that name already exists at that site");
      throw e;
    }
    const certificate = await issueAgentCertificate(key, request.csr, cabinetId);
    await c.query("INSERT INTO cabinet_certificates (serial, cabinet_id, not_after) VALUES ($1, $2, $3)", [certificate.serialHex, cabinetId, certificate.notAfter]);
    await c.query(`UPDATE enrollment_requests SET status = 'issued', cabinet_id = $2, certificate_serial = $3, certificate_pem = $4, decided_by = $5, decided_at = now()
                   WHERE id = $1`, [requestId, cabinetId, certificate.serialHex, certificate.pem, userId]);
    await audit(c, { actorKind: "user", actorId: userId, action: "enrollment.approve", targetKind: "cabinet", targetId: cabinetId, outcome: "succeeded",
      details: { requestId, ...approval, certificateSerial: certificate.serialHex } });
    return { cabinetId, serial: certificate.serialHex };
  });
}

export async function rejectEnrollment(pool: pg.Pool, requestId: string, userId: string): Promise<void> {
  await transaction(pool, async c => {
    const r = await c.query("UPDATE enrollment_requests SET status = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1 AND status = 'pending'", [requestId, userId]);
    if (r.rowCount !== 1) throw new Refused("not_pending", 409, "that enrollment request is not pending");
    await audit(c, { actorKind: "user", actorId: userId, action: "enrollment.reject", targetKind: "enrollment", targetId: requestId, outcome: "succeeded" });
  });
}
