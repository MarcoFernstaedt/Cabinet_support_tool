// Bootstrap tokens, enrollment requests, the pending queue and approval
// (docs/spec/05-server-spec.md "Enrollment and certificates").
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { EnrollRequest, EnrollStatus } from "../contracts.js";
import { audit, isUniqueViolation, safeJson, transaction, type Pool, type Queryable } from "../db/db.js";
import { issueAgentCertificate } from "../pki/issuing.js";
import type { IssuingKey } from "../pki/x509.js";
import { CsrError, verifyCsr } from "../pki/x509.js";
import { Refused } from "./errors.js";
import { assertSyncCabinetAt, linkUnassigned } from "./sync-cabinets.js";
import { applyScannerChoice, type ScannerChoice } from "./client-scanner.js";
import type { ListSigningKeys } from "./approved-list-signing.js";
import { approvedFor, attachChoices, attachToSite, type Scope } from "./baselines.js";
import { fleetPolicy, writeSitePolicy, type FirewallPolicy } from "./firewall-policy.js";
import { fleetTimeZone, type TimeZoneId } from "./time.js";
import { parseJson } from "./settings.js";

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
   * A satellite's sync cabinet: an active sync cabinet at the same site. Left out, the satellite is linked to the site's only sync
   * cabinet, or stays incomplete when the site has none yet; a site with several needs the choice made here. Only a satellite names one.
   */
  syncCabinetId?: string;
  /** For a new client only: whether it uses a fingerprint scanner, with its service when it does (client-scanner.ts). */
  scanner?: ScannerChoice;
  /**
   * The baseline decision. The console route and the command line always pass one (the contract requires it); the server's own callers
   * (tests, the demo) may leave it out, and the cabinet then shows "Baseline required" until a baseline applies to it.
   */
  baseline?: BaselineDecision;
  /** For a new site only: its own firewall policy and time zone; null or left out, it inherits them (05-server-spec.md "Site policies"). */
  sitePolicies?: { firewall?: FirewallPolicy | null; timeZone?: TimeZoneId | null };
}

/** The baseline decision every approval carries (docs/spec/15-baselines-and-config.md "Baselines at enrollment"). */
export type BaselineDecision = { use: "inherited" } | { use: "attach"; versionId: string } | { use: "capture" };

/** What became of the baseline decision, for the console to say. */
export interface ApprovalBaseline { decision: BaselineDecision["use"] | null; inForce: { kind: string; name: string; version: number }[]; captureWaiting: boolean }

const noBaseline = () => new Refused("no_approved_baseline", 409, "no approved baseline applies to this cabinet's site, client or the fleet",
  { reason: "No approved baseline applies here yet. Choose an approved baseline to attach to the site, or capture this cabinet's configuration as the site's baseline draft." });

/** The scopes a cabinet at this client and site falls under before it has reported its model. */
const placeScopes = (clientId: string | null, siteId: string | null): Scope[] =>
  [{ kind: "global", id: null }, ...(clientId ? [{ kind: "client" as const, id: clientId.toLowerCase() }] : []), ...(siteId ? [{ kind: "site" as const, id: siteId.toLowerCase() }] : [])];

// This one carries `reason`, the sentence the console shows (console/src/lib/api.ts describeError): a refusal an Admin has to act on
// says what to do, not just that it happened.
const chooseSyncCabinet = () => new Refused("choose_sync_cabinet", 409, "this site has several sync cabinets; choose the one this satellite reaches",
  { reason: "This site has several sync cabinets. Choose the one this satellite reaches." });

/** Approves a pending request: places the cabinet, links it into the site's sync arrangement, signs its certificate and records it all. */
export async function approveEnrollment(pool: Pool, key: IssuingKey, requestId: string, approval: Approval, userId: string, signing?: ListSigningKeys):
  Promise<{ cabinetId: string; serial: string; siteId: string; baseline: ApprovalBaseline }> {
  if (approval.syncCabinetId !== undefined && approval.role !== "satellite")
    throw new Refused("sync_not_allowed", 400, "only a satellite is given a sync cabinet", { reason: "Only a satellite is given a sync cabinet." });
  return transaction(pool, async c => {
    const request = (await c.query<{ csr: string; fingerprints: EnrollRequest["fingerprints"] }>(
      "SELECT csr, fingerprints FROM enrollment_requests WITH (UPDLOCK, ROWLOCK) WHERE id = $1 AND status = 'pending'", [requestId])).rows[0];
    if (!request) throw new Refused("not_pending", 409, "that enrollment request is not pending");
    // Whether this approval creates the client: only a new client takes a scanner choice; an existing one keeps its own setting.
    const existed = !!(await c.query("SELECT 1 AS x FROM clients WITH (UPDLOCK, HOLDLOCK) WHERE name = $1 AND removed_at IS NULL", [approval.clientName])).rows[0];
    if (existed && approval.scanner) throw new Refused("scanner_for_existing_client", 409, "this client already exists; change its fingerprint scanner setting on the client's page",
      { reason: "This client already exists. Its fingerprint scanner setting is changed on the client's page, not with an approval." });
    // Insert unless a live client of that name exists (a concurrent insert that wins the race is the same outcome).
    try {
      await c.query("IF NOT EXISTS (SELECT 1 FROM clients WITH (UPDLOCK, HOLDLOCK) WHERE name = $2 AND removed_at IS NULL) INSERT INTO clients (id, name) VALUES ($1, $2)", [randomUUID(), approval.clientName]);
    } catch (e) { if (!isUniqueViolation(e)) throw e; }
    const client = (await c.query<{ id: string; demo: boolean }>("SELECT id, demo FROM clients WHERE name = $1 AND removed_at IS NULL", [approval.clientName])).rows[0]!;
    // A real cabinet never joins a simulated client: turning demo mode off deletes those, and its data would be mixed with the simulation.
    if (client.demo) throw new Refused("demo_client", 409, "that is a simulated demo client; file the cabinet under a real client");
    // A new client's scanner, set up with the approval that creates it, in the same transaction.
    const scanner = !existed && approval.scanner ? await applyScannerChoice(c, userId, client.id, approval.scanner, signing) : null;
    // Whether this approval creates the site: only a new site takes its policies here; an existing one keeps its own (changed on its page).
    const siteExisted = !!(await c.query("SELECT 1 AS x FROM sites WITH (UPDLOCK, HOLDLOCK) WHERE client_id = $1 AND name = $2 AND removed_at IS NULL", [client.id, approval.siteName])).rows[0];
    if (siteExisted && approval.sitePolicies) throw new Refused("site_policies_for_existing_site", 409, "this site already exists; change its policies on the site's page",
      { reason: "This site already exists. Its firewall policy and time zone are changed on the site's page, not with an approval." });
    try {
      await c.query("IF NOT EXISTS (SELECT 1 FROM sites WITH (UPDLOCK, HOLDLOCK) WHERE client_id = $2 AND name = $3 AND removed_at IS NULL) INSERT INTO sites (id, client_id, name) VALUES ($1, $2, $3)",
        [randomUUID(), client.id, approval.siteName]);
    } catch (e) { if (!isUniqueViolation(e)) throw e; }
    const site = (await c.query<{ id: string }>("SELECT id FROM sites WHERE client_id = $1 AND name = $2 AND removed_at IS NULL", [client.id, approval.siteName])).rows[0]!;
    // A new site's own policies, confirmed with this approval and written with it (each audited as its own change).
    if (!siteExisted && approval.sitePolicies?.firewall) await writeSitePolicy(c, userId, site.id, approval.sitePolicies.firewall);
    if (!siteExisted && approval.sitePolicies?.timeZone) {
      await c.query("UPDATE sites SET time_zone = $2 WHERE id = $1", [site.id, approval.sitePolicies.timeZone]);
      await audit(c, { actorKind: "user", actorId: userId, action: "site.time_zone", targetKind: "site", targetId: site.id, outcome: "succeeded",
        details: { before: null, timeZone: approval.sitePolicies.timeZone, enrollment: requestId } });
    }

    // A satellite's sync cabinet, decided before the cabinet exists so a refusal leaves nothing behind. The site's sync cabinets are
    // read under lock: a sync cabinet approved at the same moment cannot change the answer between this read and the insert.
    let syncCabinetId: string | null = null;
    if (approval.role === "satellite") {
      if (approval.syncCabinetId !== undefined) {
        await assertSyncCabinetAt(c, approval.syncCabinetId, site.id);
        syncCabinetId = approval.syncCabinetId;
      } else {
        const syncs = (await c.query<{ id: string }>(
          "SELECT id FROM cabinets WITH (UPDLOCK, HOLDLOCK) WHERE site_id = $1 AND role = 'sync' AND status = 'active'", [site.id])).rows;
        if (syncs.length > 1) throw chooseSyncCabinet();
        syncCabinetId = syncs[0]?.id ?? null;
      }
    }

    const cabinetId = randomUUID();
    // A cabinet name is unique within its site (removed cabinets keep theirs). The check is in the insert itself, with a lock on the rows
    // it reads, so two approvals at the same moment cannot both pass: one inserts, the other sees the row and is refused.
    const insert = await c.query<{ id: string }>(`INSERT INTO cabinets (id, site_id, name, role, status, hostname, serial_number, agent_version, architecture, sync_cabinet_id)
                   SELECT $1, $2, $3, $4, 'active', $5, $6, $7, $8, $9
                   WHERE NOT EXISTS (SELECT 1 FROM cabinets WITH (UPDLOCK, HOLDLOCK) WHERE site_id = $2 AND name = $3)`,
      [cabinetId, site.id, approval.cabinetName, approval.role, request.fingerprints.hostname, request.fingerprints.serialNumber, request.fingerprints.agentVersion,
       request.fingerprints.architecture ?? null, syncCabinetId]);
    if (insert.rowCount !== 1) throw new Refused("name_taken", 409, "a cabinet with that name already exists at that site");
    // The site's first sync cabinet takes in the satellites that were waiting for one.
    const linked = approval.role === "sync" ? await linkUnassigned(c, site.id) : 0;
    // The baseline decision, checked and recorded with the cabinet. A refusal rolls the whole approval back.
    let inForce: ApprovalBaseline["inForce"] = [];
    if (approval.baseline) {
      const decision = approval.baseline;
      if (decision.use === "inherited") {
        const found = await approvedFor(c, placeScopes(client.id, site.id));
        if (found.length === 0) throw noBaseline();
        inForce = found.map(o => ({ kind: o.kind, name: o.name, version: o.version }));
      } else if (decision.use === "attach") {
        const o = await attachToSite(c, userId, site.id, decision.versionId, `Attached when ${approval.cabinetName} was approved`);
        inForce = [{ kind: o.kind, name: o.name, version: o.version }];
      }
      await c.query("INSERT INTO enrollment_baselines (cabinet_id, site_id, decision, decided_by, attached_version_id, capture_state) VALUES ($1, $2, $3, $4, $5, $6)",
        [cabinetId, site.id, decision.use, userId, decision.use === "attach" ? decision.versionId.toLowerCase() : null, decision.use === "capture" ? "waiting" : null]);
    }
    const certificate = await issueAgentCertificate(key, request.csr, cabinetId);
    await c.query("INSERT INTO cabinet_certificates (serial, cabinet_id, not_after) VALUES ($1, $2, $3)", [certificate.serialHex, cabinetId, certificate.notAfter]);
    await c.query(`UPDATE enrollment_requests SET status = 'issued', cabinet_id = $2, certificate_serial = $3, certificate_pem = $4, decided_by = $5, decided_at = SYSUTCDATETIME()
                   WHERE id = $1`, [requestId, cabinetId, certificate.serialHex, certificate.pem, userId]);
    await audit(c, { actorKind: "user", actorId: userId, action: "enrollment.approve", targetKind: "cabinet", targetId: cabinetId, outcome: "succeeded",
      details: { requestId, ...approval, syncCabinetId, ...(scanner ? { scannerApproval: scanner.approval } : {}), ...(approval.role === "sync" ? { satellitesLinked: linked } : {}), certificateSerial: certificate.serialHex } });
    return { cabinetId, serial: certificate.serialHex, siteId: site.id,
      baseline: { decision: approval.baseline?.use ?? null, inForce, captureWaiting: approval.baseline?.use === "capture" } };
  });
}

export async function rejectEnrollment(pool: Pool, requestId: string, userId: string): Promise<void> {
  await transaction(pool, async c => {
    const r = await c.query("UPDATE enrollment_requests SET status = 'rejected', decided_by = $2, decided_at = SYSUTCDATETIME() WHERE id = $1 AND status = 'pending'", [requestId, userId]);
    if (r.rowCount !== 1) throw new Refused("not_pending", 409, "that enrollment request is not pending");
    await audit(c, { actorKind: "user", actorId: userId, action: "enrollment.reject", targetKind: "enrollment", targetId: requestId, outcome: "succeeded" });
  });
}

/** What the approval shows about baselines for a client and site: the approved baselines that already apply, and the ones that could be attached. */
export interface ApprovalBaselinePreview {
  inForce: { kind: string; name: string; version: number }[];
  /** Approved model baselines exist: one may also apply once the cabinet reports its model, which the approval cannot know yet. */
  modelBaselines: number;
  siteHasOwn: boolean;
  choices: { versionId: string; version: number; scope: string; name: string }[];
}

/** Reads only; the approval checks everything again. A client or site that does not exist yet has nothing of its own. */
export async function approvalBaselinePreview(db: Queryable, requestId: string, q: { client: string; site: string }): Promise<ApprovalBaselinePreview> {
  if (!(await db.query("SELECT 1 AS x FROM enrollment_requests WHERE id = $1 AND status = 'pending'", [requestId])).rows[0])
    throw new Refused("not_pending", 409, "that enrollment request is not pending");
  const client = (await db.query<{ id: string }>("SELECT id FROM clients WHERE name = $1 AND removed_at IS NULL", [q.client])).rows[0] ?? null;
  const site = client ? (await db.query<{ id: string }>("SELECT id FROM sites WHERE client_id = $1 AND name = $2 AND removed_at IS NULL", [client.id, q.site])).rows[0] ?? null : null;
  const inForce = await approvedFor(db, placeScopes(client?.id ?? null, site?.id ?? null));
  const modelBaselines = Number((await db.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM baselines b JOIN baseline_versions v ON v.baseline_id = b.id AND v.status = 'approved' WHERE b.scope_kind = 'model'")).rows[0]!.n);
  return { inForce: inForce.map(o => ({ kind: o.kind, name: o.name, version: o.version })), modelBaselines, siteHasOwn: inForce.some(o => o.kind === "site"),
    choices: await attachChoices(db) };
}

/** What a site would inherit, for the approval to pre-fill: its client's firewall policy and zone, else the fleet's. Reads only. */
export interface ApprovalSitePreview {
  siteExists: boolean;
  firewall: { policy: FirewallPolicy; source: "client" | "fleet" };
  timeZone: { zone: TimeZoneId | null; source: "client" | "fleet" | null };
}

export async function approvalSitePreview(db: Queryable, requestId: string, q: { client: string; site: string }): Promise<ApprovalSitePreview> {
  if (!(await db.query("SELECT 1 AS x FROM enrollment_requests WHERE id = $1 AND status = 'pending'", [requestId])).rows[0])
    throw new Refused("not_pending", 409, "that enrollment request is not pending");
  const client = (await db.query<{ id: string; firewall_policy: string | null; time_zone: TimeZoneId | null }>(
    "SELECT id, firewall_policy, time_zone FROM clients WHERE name = $1 AND removed_at IS NULL", [q.client])).rows[0] ?? null;
  const siteExists = !!client && !!(await db.query("SELECT 1 AS x FROM sites WHERE client_id = $1 AND name = $2 AND removed_at IS NULL", [client.id, q.site])).rows[0];
  const clientPolicy = parseJson<FirewallPolicy>(client?.firewall_policy ?? null);
  const fleetZone = await fleetTimeZone(db);
  return {
    siteExists,
    firewall: clientPolicy ? { policy: clientPolicy, source: "client" } : { policy: await fleetPolicy(db), source: "fleet" },
    timeZone: client?.time_zone ? { zone: client.time_zone, source: "client" } : { zone: fleetZone, source: fleetZone ? "fleet" : null },
  };
}

