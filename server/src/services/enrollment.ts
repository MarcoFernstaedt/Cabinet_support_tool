// Bootstrap tokens, enrollment requests, the pending queue and approval
// (docs/spec/05-server-spec.md "Enrollment and certificates").
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { EnrollRequest, EnrollStatus } from "../contracts.js";
import { audit, isUniqueViolation, safeJson, transaction, type Pool, type Queryable } from "../db/db.js";
import { issueAgentCertificate } from "../pki/issuing.js";
import type { IssuingKey } from "../pki/x509.js";
import { CsrError, verifyCsr } from "../pki/x509.js";
import { writeSiteSync } from "./device-settings.js";
import { Refused } from "./errors.js";

export const TOKEN_DAYS = 7;
const hashToken = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

/** Creates a single-use bootstrap token. The token is returned once and only its hash is stored. */
export async function createBootstrapToken(pool: Pool, userId: string, days = TOKEN_DAYS): Promise<{ token: string; expiresAt: Date }> {
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
export async function submitEnrollment(pool: Pool, request: EnrollRequest, sourceAddress: string): Promise<string> {
  return transaction(pool, async c => {
    // The token is checked before the certificate request, so nobody without a token makes the server verify signatures.
    // A bad request does not use the token up: the row is locked, and only a valid request marks it used.
    const token = (await c.query<{ id: string }>(
      "SELECT id FROM bootstrap_tokens WITH (UPDLOCK, ROWLOCK) WHERE token_hash = $1 AND used_at IS NULL AND expires_at > SYSUTCDATETIME()",
      [hashToken(request.bootstrapToken)])).rows[0];
    if (!token) {
      throw new Refused("enrollment_refused", 403, "unknown, used or expired bootstrap token");
    }
    try { verifyCsr(request.csr); }
    catch (e) { if (e instanceof CsrError) throw new Refused("invalid_request", 400, e.message); throw e; }
    await c.query("UPDATE bootstrap_tokens SET used_at = SYSUTCDATETIME() WHERE id = $1", [token.id]);
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

export interface Approval {
  clientName: string; siteName: string; cabinetName: string; role: "sync" | "satellite" | "standalone";
  /**
   * The site's sync cabinet, captured while the cabinet that needs it is approved: a private IPv4 address, and
   * optionally the site's own TCP ports (omitted or null: the client's ports, else the fleet's). Ignored for a
   * `standalone`; refused for a `sync` and required (here or already set on the site) for a `satellite`.
   */
  sync?: { address: string; ports?: number[] | null };
}

// These three carry `reason`, the one sentence the console shows (console/src/lib/api.ts describeError): a refusal an
// Admin has to act on must say what to do, not just that it happened.
const syncExists = () => new Refused("sync_exists", 409,
  "this site already has a sync cabinet. A site has one: approve this cabinet as a satellite or standalone, or change the existing sync cabinet's role first.",
  { reason: "This site already has a sync cabinet, and a site has only one. Approve this cabinet as a satellite or standalone, or change the existing sync cabinet's role first." });
const satelliteNeedsSync = () => new Refused("satellite_needs_sync", 409,
  "a satellite needs the site's sync cabinet to reach. Enter the sync cabinet's private IPv4 address (10.x.x.x, 172.16-31.x.x or 192.168.x.x) with this approval, or approve the sync cabinet first and set the address on the site.",
  { reason: "A satellite needs the sync cabinet it reaches. Enter the sync cabinet's private IPv4 address (10.x, 172.16-31.x or 192.168.x) above, or approve the site's sync cabinet first." });

/** Approves a pending request: places the cabinet, signs its certificate and records both. */
export async function approveEnrollment(pool: Pool, key: IssuingKey, requestId: string, approval: Approval, userId: string): Promise<{ cabinetId: string; serial: string }> {
  return transaction(pool, async c => {
    const request = (await c.query<{ csr: string; fingerprints: EnrollRequest["fingerprints"] }>(
      "SELECT csr, fingerprints FROM enrollment_requests WITH (UPDLOCK, ROWLOCK) WHERE id = $1 AND status = 'pending'", [requestId])).rows[0];
    if (!request) throw new Refused("not_pending", 409, "that enrollment request is not pending");
    // Insert unless a live client of that name exists (a concurrent insert that wins the race is the same outcome).
    try {
      await c.query("IF NOT EXISTS (SELECT 1 FROM clients WITH (UPDLOCK, HOLDLOCK) WHERE name = $2 AND removed_at IS NULL) INSERT INTO clients (id, name) VALUES ($1, $2)", [randomUUID(), approval.clientName]);
    } catch (e) { if (!isUniqueViolation(e)) throw e; }
    const client = (await c.query<{ id: string; demo: boolean }>("SELECT id, demo FROM clients WHERE name = $1 AND removed_at IS NULL", [approval.clientName])).rows[0]!;
    // A real cabinet never joins a simulated client: turning demo mode off deletes those, and its data would be mixed with the simulation.
    if (client.demo) throw new Refused("demo_client", 409, "that is a simulated demo client; file the cabinet under a real client");
    try {
      await c.query("IF NOT EXISTS (SELECT 1 FROM sites WITH (UPDLOCK, HOLDLOCK) WHERE client_id = $2 AND name = $3 AND removed_at IS NULL) INSERT INTO sites (id, client_id, name) VALUES ($1, $2, $3)",
        [randomUUID(), client.id, approval.siteName]);
    } catch (e) { if (!isUniqueViolation(e)) throw e; }
    const site = (await c.query<{ id: string }>("SELECT id FROM sites WHERE client_id = $1 AND name = $2 AND removed_at IS NULL", [client.id, approval.siteName])).rows[0]!;
    // A sync cabinet is the endpoint its satellites reach, so it is never given a sync target. Refusing is kinder than
    // dropping the address: an Admin who typed one meant it to be used.
    if (approval.role === "sync" && approval.sync) throw new Refused("sync_not_allowed", 400,
      "a sync cabinet is the endpoint its satellites connect to, so it is not given a sync address. Leave the address empty, or approve this cabinet as a satellite.",
      { reason: "A sync cabinet is the endpoint its satellites connect to, so it is not given a sync address. Leave the address empty, or approve this cabinet as a satellite." });
    const cabinetId = randomUUID();
    const taken = new Refused("name_taken", 409, "a cabinet with that name already exists at that site");
    // A cabinet name is unique within its site (removed cabinets keep theirs), and a site has at most one live sync cabinet.
    // Both are checked in the insert itself with a lock on the rows it reads, so two approvals at the same moment cannot
    // both pass: one inserts, the other sees the row and is refused.
    const insert = await c.query<{ id: string }>(`INSERT INTO cabinets (id, site_id, name, role, status, hostname, serial_number, agent_version)
                   SELECT $1, $2, $3, $4, 'active', $5, $6, $7
                   WHERE NOT EXISTS (SELECT 1 FROM cabinets WITH (UPDLOCK, HOLDLOCK) WHERE site_id = $2 AND name = $3)
                   ${approval.role === "sync" ? "AND NOT EXISTS (SELECT 1 FROM cabinets WITH (UPDLOCK, HOLDLOCK) WHERE site_id = $2 AND role = 'sync' AND status <> 'removed')" : ""}`,
      [cabinetId, site.id, approval.cabinetName, approval.role, request.fingerprints.hostname, request.fingerprints.serialNumber, request.fingerprints.agentVersion]);
    if (insert.rowCount !== 1) {
      // Say which rule refused it: the two need different fixes.
      if (approval.role === "sync" && (await c.query("SELECT 1 FROM cabinets WHERE site_id = $1 AND role = 'sync' AND status <> 'removed'", [site.id])).rows[0]) throw syncExists();
      throw taken;
    }
    // The site's sync cabinet is captured with the approval that needs it, in the same transaction: an approval that
    // fails below leaves neither the cabinet nor the address behind.
    if (approval.sync && approval.role !== "sync") {
      await writeSiteSync(c, userId, site.id, { address: approval.sync.address, ports: approval.sync.ports ?? null });
    }
    if (approval.role === "satellite" &&
        !(await c.query<{ sync_address: string | null }>("SELECT sync_address FROM sites WHERE id = $1", [site.id])).rows[0]?.sync_address) {
      throw satelliteNeedsSync();
    }
    const certificate = await issueAgentCertificate(key, request.csr, cabinetId);
    await c.query("INSERT INTO cabinet_certificates (serial, cabinet_id, not_after) VALUES ($1, $2, $3)", [certificate.serialHex, cabinetId, certificate.notAfter]);
    await c.query(`UPDATE enrollment_requests SET status = 'issued', cabinet_id = $2, certificate_serial = $3, certificate_pem = $4, decided_by = $5, decided_at = SYSUTCDATETIME()
                   WHERE id = $1`, [requestId, cabinetId, certificate.serialHex, certificate.pem, userId]);
    await audit(c, { actorKind: "user", actorId: userId, action: "enrollment.approve", targetKind: "cabinet", targetId: cabinetId, outcome: "succeeded",
      details: { requestId, ...approval, certificateSerial: certificate.serialHex } });
    return { cabinetId, serial: certificate.serialHex };
  });
}

export async function rejectEnrollment(pool: Pool, requestId: string, userId: string): Promise<void> {
  await transaction(pool, async c => {
    const r = await c.query("UPDATE enrollment_requests SET status = 'rejected', decided_by = $2, decided_at = SYSUTCDATETIME() WHERE id = $1 AND status = 'pending'", [requestId, userId]);
    if (r.rowCount !== 1) throw new Refused("not_pending", 409, "that enrollment request is not pending");
    await audit(c, { actorKind: "user", actorId: userId, action: "enrollment.reject", targetKind: "enrollment", targetId: requestId, outcome: "succeeded" });
  });
}
