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
import { insertCabinet, recordIssuedCertificate } from "./cabinets.js";
import { applyScannerChoice, type ScannerChoice } from "./client-scanner.js";
import type { ListSigningKeys } from "./approved-list-signing.js";
import { approvedFor, attachChoices, attachToSite, recordEnrollmentDecision, type Scope } from "./baselines.js";
import { fleetPolicy, writeSitePolicy, type FirewallPolicy } from "./firewall-policy.js";
import { fleetTimeZone, writeSiteTimeZone, type TimeZoneId } from "./time.js";
import { insertClient, insertSite } from "./admin.js";
import { parseJson } from "./settings.js";
import { completeReplacement, freeName, lockReplaced, type OldCabinet } from "./replacement.js";
import { noteRevocation } from "../agent-api/revocations.js";

export const TOKEN_DAYS = 7;
const hashToken = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

/** The bounds of a site installer's token (F6.R1, decision-log D35): how many cabinets it is for, and for how long. */
export const SITE_TOKEN = { maxCabinets: 100, defaultCabinets: 10, maxDays: 30, defaultDays: TOKEN_DAYS } as const;

/** What a site installer is for: one site, optionally one role, and how many cabinets for how many days. */
export interface SiteScope { siteId: string; role?: "sync" | "satellite" | "standalone" | undefined; cabinets?: number | undefined; days?: number | undefined }

/**
 * Creates a bootstrap token. The token is returned once and only its hash is stored. Without a site it is for one cabinet, as always;
 * with one (a site installer) it is for up to `cabinets` cabinets of that site and role, until it runs out, expires or is revoked.
 */
export async function createBootstrapToken(pool: Pool, userId: string, days: number = TOKEN_DAYS, site?: SiteScope): Promise<{ token: string; expiresAt: Date; id: string; cabinets: number }> {
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const lifeDays = site ? site.days ?? SITE_TOKEN.defaultDays : days;
  const cabinets = site ? site.cabinets ?? SITE_TOKEN.defaultCabinets : 1;
  if (site && (!Number.isInteger(cabinets) || cabinets < 1 || cabinets > SITE_TOKEN.maxCabinets))
    throw new Refused("invalid_request", 400, `a site installer is for 1 to ${SITE_TOKEN.maxCabinets} cabinets`);
  if (site && (!Number.isInteger(lifeDays) || lifeDays < 1 || lifeDays > SITE_TOKEN.maxDays))
    throw new Refused("invalid_request", 400, `a site installer lasts 1 to ${SITE_TOKEN.maxDays} days`);
  const expiresAt = new Date(Date.now() + lifeDays * 86_400_000);
  await transaction(pool, async c => {
    if (site && !(await c.query("SELECT 1 AS x FROM sites WHERE id = $1 AND removed_at IS NULL", [site.siteId])).rows[0])
      throw new Refused("not_found", 404, "no such site");
    await c.query("INSERT INTO bootstrap_tokens (id, token_hash, created_by, expires_at, site_id, role, max_uses) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [id, hashToken(token), userId, expiresAt, site?.siteId ?? null, site?.role ?? null, cabinets]);
    await audit(c, { actorKind: "user", actorId: userId, action: "token.create", targetKind: "token", targetId: id, outcome: "succeeded",
      details: { expiresAt: expiresAt.toISOString(), ...(site ? { siteId: site.siteId.toLowerCase(), role: site.role ?? null, cabinets } : {}) } });
  });
  return { token, expiresAt, id, cabinets };
}

/** Stops a site installer's token now: no cabinet can enroll with it after this. Requests it already made stay pending. */
export async function revokeBootstrapToken(pool: Pool, userId: string, tokenId: string): Promise<void> {
  await transaction(pool, async c => {
    const r = await c.query("UPDATE bootstrap_tokens SET revoked_at = SYSUTCDATETIME(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL AND site_id IS NOT NULL", [tokenId, userId]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no site installer token to revoke");
    await audit(c, { actorKind: "user", actorId: userId, action: "token.revoke", targetKind: "token", targetId: tokenId.toLowerCase(), outcome: "succeeded" });
  });
}

export interface SiteToken { id: string; siteId: string; site: string; client: string; role: string | null; cabinets: number; used: number; expiresAt: string; createdAt: string; revokedAt: string | null }

/** The site installers made in the last 30 days, newest first, with how many of their cabinets have used them. */
export async function siteTokens(db: Queryable): Promise<SiteToken[]> {
  return (await db.query<{ id: string; site_id: string; site: string; client: string; role: string | null; max_uses: number; uses: number; expires_at: Date; created_at: Date; revoked_at: Date | null }>(
    `SELECT TOP (200) t.id, t.site_id, s.name AS site, c.name AS client, t.role, t.max_uses, t.uses, t.expires_at, t.created_at, t.revoked_at
       FROM bootstrap_tokens t JOIN sites s ON s.id = t.site_id JOIN clients c ON c.id = s.client_id
      WHERE t.created_at > DATEADD(day, -30, SYSUTCDATETIME()) ORDER BY t.created_at DESC`)).rows
    .map(r => ({ id: r.id.toLowerCase(), siteId: r.site_id.toLowerCase(), site: r.site, client: r.client, role: r.role, cabinets: Number(r.max_uses), used: Number(r.uses),
      expiresAt: r.expires_at.toISOString(), createdAt: r.created_at.toISOString(), revokedAt: r.revoked_at?.toISOString() ?? null }));
}

/**
 * Stores an enrollment request and consumes its token. Any problem with the
 * token gets the same answer, so the endpoint does not reveal whether a
 * token exists, was used or expired.
 */
/**
 * Whether a site installer's token may still enroll a cabinet (not used up, not revoked, not expired): what a fleet install script shows
 * to download the agent package. Read only, never counted as a use: the cabinet's enrollment is what uses it. A one-cabinet token is
 * not accepted, since a fleet install script is only ever made for a site.
 */
export async function siteTokenUsable(db: Queryable, token: string): Promise<{ id: string; siteId: string } | null> {
  const r = (await db.query<{ id: string; site_id: string }>(
    `SELECT id, site_id FROM bootstrap_tokens
      WHERE token_hash = $1 AND site_id IS NOT NULL AND uses < max_uses AND revoked_at IS NULL AND expires_at > SYSUTCDATETIME()`,
    [hashToken(token)])).rows[0];
  return r ? { id: r.id.toLowerCase(), siteId: r.site_id.toLowerCase() } : null;
}

export async function submitEnrollment(pool: Pool, request: EnrollRequest, sourceAddress: string): Promise<string> {
  return transaction(pool, async c => {
    // The token is checked before the certificate request, so nobody without a token makes the server verify signatures.
    // A bad request does not use the token up: the row is locked, and only a valid request marks it used.
    // A site installer's token takes up to max_uses cabinets; the lock makes two cabinets at once count as two (F6.R1).
    const token = (await c.query<{ id: string; site_id: string | null }>(
      `SELECT id, site_id FROM bootstrap_tokens WITH (UPDLOCK, ROWLOCK)
        WHERE token_hash = $1 AND uses < max_uses AND revoked_at IS NULL AND expires_at > SYSUTCDATETIME()`,
      [hashToken(request.bootstrapToken)])).rows[0];
    if (!token) {
      throw new Refused("enrollment_refused", 403, "unknown, used or expired bootstrap token");
    }
    try { verifyCsr(request.csr); }
    catch (e) { if (e instanceof CsrError) throw new Refused("invalid_request", 400, e.message); throw e; }
    // used_at is when it was used up: at once for a one-cabinet token, at its last cabinet for a site installer's.
    await c.query("UPDATE bootstrap_tokens SET uses = uses + 1, used_at = CASE WHEN uses + 1 >= max_uses THEN SYSUTCDATETIME() ELSE used_at END WHERE id = $1", [token.id]);
    const id = randomUUID();
    await c.query("INSERT INTO enrollment_requests (id, token_id, csr, fingerprints, source_address, status) VALUES ($1, $2, $3, $4, $5, 'pending')",
      [id, token.id, request.csr, safeJson(request.fingerprints), sourceAddress]);
    await audit(c, { actorKind: "agent", actorId: request.fingerprints.hostname, action: "enrollment.submit", targetKind: "enrollment", targetId: id, outcome: "succeeded",
      details: { hostname: request.fingerprints.hostname, serialNumber: request.fingerprints.serialNumber, source: sourceAddress, tokenId: token.id.toLowerCase(),
        ...(token.site_id ? { siteId: token.site_id.toLowerCase() } : {}) } });
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

/** Where a request's site installer said it belongs: a suggestion the approval form starts from, checked again on approval. */
export interface IntendedPlace { client: string; site: string; role: string | null }
export interface PendingRequest { id: string; createdAt: Date; sourceAddress: string | null; fingerprints: EnrollRequest["fingerprints"]; intended?: IntendedPlace }

export async function pendingRequests(db: Queryable): Promise<PendingRequest[]> {
  return (await db.query<{ id: string; created_at: Date; source_address: string | null; fingerprints: EnrollRequest["fingerprints"]; client: string | null; site: string | null; role: string | null }>(
    `SELECT r.id, r.created_at, r.source_address, r.fingerprints, c.name AS client, s.name AS site, t.role
       FROM enrollment_requests r LEFT JOIN bootstrap_tokens t ON t.id = r.token_id LEFT JOIN sites s ON s.id = t.site_id AND s.removed_at IS NULL
       LEFT JOIN clients c ON c.id = s.client_id AND c.removed_at IS NULL
      WHERE r.status = 'pending' ORDER BY r.created_at`)).rows
    .map(r => ({ id: r.id, createdAt: r.created_at, sourceAddress: r.source_address, fingerprints: r.fingerprints,
      ...(r.client && r.site ? { intended: { client: r.client, site: r.site, role: r.role } } : {}) }));
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
  /** The active cabinet this one replaces (05-server-spec.md "Replacing a cabinet"): same site, same role. */
  replacesCabinetId?: string;
}

/** The baseline decision every approval carries (docs/spec/15-baselines-and-config.md "Baselines at enrollment"). */
export type BaselineDecision = { use: "inherited" } | { use: "attach"; versionId: string } | { use: "capture" };

/** What became of the baseline decision, for the console to say. */
export interface ApprovalBaseline { decision: BaselineDecision["use"] | null; inForce: { kind: string; name: string; version: number }[]; captureWaiting: boolean }

const noBaseline = () => new Refused("no_approved_baseline", 409, "no approved baseline applies to this cabinet's site, client, role or the fleet",
  { reason: "No approved baseline applies here yet. Choose an approved baseline to attach to the site, or capture this cabinet's configuration as the site's baseline draft." });

/** The scopes a cabinet of this role at this client and site falls under before it has reported its model. */
const placeScopes = (role: string | null, clientId: string | null, siteId: string | null): Scope[] =>
  [{ kind: "global", id: null }, ...(role ? [{ kind: "role" as const, id: role }] : []), ...(clientId ? [{ kind: "client" as const, id: clientId.toLowerCase() }] : []), ...(siteId ? [{ kind: "site" as const, id: siteId.toLowerCase() }] : [])];

// This one carries `reason`, the sentence the console shows (console/src/lib/api.ts describeError): a refusal an Admin has to act on
// says what to do, not just that it happened.
const chooseSyncCabinet = () => new Refused("choose_sync_cabinet", 409, "this site has several sync cabinets; choose the one this satellite reaches",
  { reason: "This site has several sync cabinets. Choose the one this satellite reaches." });

/** Approves a pending request: places the cabinet, links it into the site's sync arrangement, signs its certificate and records it all. */
export async function approveEnrollment(pool: Pool, key: IssuingKey, requestId: string, approval: Approval, userId: string, signing?: ListSigningKeys):
  Promise<{ cabinetId: string; serial: string; siteId: string; baseline: ApprovalBaseline; replacement: Awaited<ReturnType<typeof completeReplacement>> | null }> {
  if (approval.syncCabinetId !== undefined && approval.role !== "satellite")
    throw new Refused("sync_not_allowed", 400, "only a satellite is given a sync cabinet", { reason: "Only a satellite is given a sync cabinet." });
  const result = await transaction(pool, async c => {
    const request = (await c.query<{ csr: string; fingerprints: EnrollRequest["fingerprints"]; token_site: string | null; token_role: string | null }>(
      `SELECT r.csr, r.fingerprints, t.site_id AS token_site, t.role AS token_role FROM enrollment_requests r WITH (UPDLOCK, ROWLOCK)
         LEFT JOIN bootstrap_tokens t ON t.id = r.token_id WHERE r.id = $1 AND r.status = 'pending'`, [requestId])).rows[0];
    if (!request) throw new Refused("not_pending", 409, "that enrollment request is not pending");
    // Whether this approval creates the client: only a new client takes a scanner choice; an existing one keeps its own setting.
    const existed = !!(await c.query("SELECT 1 AS x FROM clients WITH (UPDLOCK, HOLDLOCK) WHERE name = $1 AND removed_at IS NULL", [approval.clientName])).rows[0];
    if (existed && approval.scanner) throw new Refused("scanner_for_existing_client", 409, "this client already exists; change its fingerprint scanner setting on the client's page",
      { reason: "This client already exists. Its fingerprint scanner setting is changed on the client's page, not with an approval." });
    // Created through its owner unless a live client of that name exists: the read above holds its lock, and a concurrent insert that
    // wins the race anyway is the same outcome.
    if (!existed) {
      try { await insertClient(c, randomUUID(), approval.clientName); } catch (e) { if (!isUniqueViolation(e)) throw e; }
    }
    const client = (await c.query<{ id: string; demo: boolean }>("SELECT id, demo FROM clients WHERE name = $1 AND removed_at IS NULL", [approval.clientName])).rows[0]!;
    // A real cabinet never joins a simulated client: turning demo mode off deletes those, and its data would be mixed with the simulation.
    if (client.demo) throw new Refused("demo_client", 409, "that is a simulated demo client; file the cabinet under a real client");
    // A new client's scanner, set up with the approval that creates it, in the same transaction.
    const scanner = !existed && approval.scanner ? await applyScannerChoice(c, userId, client.id, approval.scanner, signing) : null;
    // Whether this approval creates the site: only a new site takes its policies here; an existing one keeps its own (changed on its page).
    const siteExisted = !!(await c.query("SELECT 1 AS x FROM sites WITH (UPDLOCK, HOLDLOCK) WHERE client_id = $1 AND name = $2 AND removed_at IS NULL", [client.id, approval.siteName])).rows[0];
    if (siteExisted && approval.sitePolicies) throw new Refused("site_policies_for_existing_site", 409, "this site already exists; change its policies on the site's page",
      { reason: "This site already exists. Its firewall policy and time zone are changed on the site's page, not with an approval." });
    if (!siteExisted) {
      try { await insertSite(c, randomUUID(), client.id, approval.siteName); } catch (e) { if (!isUniqueViolation(e)) throw e; }
    }
    const site = (await c.query<{ id: string }>("SELECT id FROM sites WHERE client_id = $1 AND name = $2 AND removed_at IS NULL", [client.id, approval.siteName])).rows[0]!;
    // A cabinet installed with a site installer belongs to that site, and to its role when the installer named one (F6.R1). Placing it
    // anywhere else is refused: the installer was made for there, and the person who made it confirmed that with a code.
    if (request.token_site && request.token_site.toLowerCase() !== site.id.toLowerCase())
      throw new Refused("not_this_site", 409, "this cabinet was installed with another site's installer",
        { reason: "This cabinet was installed with another site's installer. Approve it at that site, or reject it." });
    if (request.token_role && request.token_role !== approval.role)
      throw new Refused("not_this_role", 409, `this cabinet's installer is for ${request.token_role} cabinets`,
        { reason: `This cabinet's installer is for ${request.token_role} cabinets. Approve it with that role, or reject it.` });
    // A new site's own policies, confirmed with this approval and written with it (each audited as its own change).
    if (!siteExisted && approval.sitePolicies?.firewall) await writeSitePolicy(c, userId, site.id, approval.sitePolicies.firewall);
    if (!siteExisted && approval.sitePolicies?.timeZone) await writeSiteTimeZone(c, userId, site.id, approval.sitePolicies.timeZone, { enrollment: requestId });

    // The cabinet this one replaces, read and checked under lock before anything is written.
    const old: OldCabinet | null = approval.replacesCabinetId ? await lockReplaced(c, approval.replacesCabinetId, site.id, approval.role) : null;
    // A satellite's sync cabinet, decided before the cabinet exists so a refusal leaves nothing behind. The site's sync cabinets are
    // read under lock: a sync cabinet approved at the same moment cannot change the answer between this read and the insert.
    let syncCabinetId: string | null = null;
    if (approval.role === "satellite") {
      if (approval.syncCabinetId === undefined && old?.syncCabinetId) {
        // A replacement reaches the sync cabinet the old one reached.
        syncCabinetId = old.syncCabinetId;
      } else if (approval.syncCabinetId !== undefined) {
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
    // A replacement that takes the old cabinet's name frees it first (the old record keeps its history under "<name> (replaced <date>)").
    if (old && old.name.toLowerCase() === approval.cabinetName.trim().toLowerCase()) await freeName(c, old);
    // A cabinet name is unique within its site (removed cabinets keep theirs): cabinets.ts, the table's owner, checks it in the insert
    // itself (D128), so of two approvals at the same moment one inserts and the other is refused.
    // A replacement starts with the old cabinet's own settings; an Admin-set sync address carries over (a reported one comes from the new report).
    const keepAddress = old?.role === "sync" && old.syncAddressSource === "admin";
    const inserted = await insertCabinet(c, { id: cabinetId, siteId: site.id, name: approval.cabinetName, role: approval.role,
      hostname: request.fingerprints.hostname, serialNumber: request.fingerprints.serialNumber, agentVersion: request.fingerprints.agentVersion,
      architecture: request.fingerprints.architecture ?? null, syncCabinetId, replacesCabinetId: old?.id ?? null,
      scannerHardwareIds: old?.scannerHardwareIds ?? null, watchedServices: old?.watchedServices ?? null,
      inOffice: old?.inOffice ? true : false, syncAddress: keepAddress ? old!.syncAddress : null, syncAddressSource: keepAddress ? "admin" : null });
    if (!inserted) throw new Refused("name_taken", 409, "a cabinet with that name already exists at that site");
    // The old cabinet's place, its own settings, and the old cabinet retired (its satellites follow it before any are linked below).
    const replacement = old ? await completeReplacement(c, userId, old, cabinetId, approval.cabinetName, signing) : null;
    // The site's first sync cabinet takes in the satellites that were waiting for one.
    const linked = approval.role === "sync" ? await linkUnassigned(c, site.id) : 0;
    // The baseline decision, checked and recorded with the cabinet. A refusal rolls the whole approval back.
    let inForce: ApprovalBaseline["inForce"] = [];
    if (approval.baseline) {
      const decision = approval.baseline;
      if (decision.use === "inherited") {
        const found = await approvedFor(c, placeScopes(approval.role, client.id, site.id));
        if (found.length === 0) throw noBaseline();
        inForce = found.map(o => ({ kind: o.kind, name: o.name, version: o.version }));
      } else if (decision.use === "attach") {
        const o = await attachToSite(c, userId, site.id, decision.versionId, `Attached when ${approval.cabinetName} was approved`);
        inForce = [{ kind: o.kind, name: o.name, version: o.version }];
      }
      await recordEnrollmentDecision(c, { cabinetId, siteId: site.id, decision: decision.use, decidedBy: userId,
        attachedVersionId: decision.use === "attach" ? decision.versionId : null });
    }
    const certificate = await issueAgentCertificate(key, request.csr, cabinetId);
    await recordIssuedCertificate(c, cabinetId, certificate.serialHex, certificate.notAfter);
    await c.query(`UPDATE enrollment_requests SET status = 'issued', cabinet_id = $2, certificate_serial = $3, certificate_pem = $4, decided_by = $5, decided_at = SYSUTCDATETIME()
                   WHERE id = $1`, [requestId, cabinetId, certificate.serialHex, certificate.pem, userId]);
    await audit(c, { actorKind: "user", actorId: userId, action: "enrollment.approve", targetKind: "cabinet", targetId: cabinetId, outcome: "succeeded",
      details: { requestId, ...approval, syncCabinetId, ...(scanner ? { scannerApproval: scanner.approval } : {}), ...(approval.role === "sync" ? { satellitesLinked: linked } : {}), certificateSerial: certificate.serialHex } });
    return { cabinetId, serial: certificate.serialHex, siteId: site.id,
      baseline: { decision: approval.baseline?.use ?? null, inForce, captureWaiting: approval.baseline?.use === "capture" }, replacement };
  });
  // Every server process forgets the connections the replaced cabinet had, once the approval has committed.
  if (result.replacement) noteRevocation();
  return result;
}

/**
 * What became of one cabinet in a batch approval: approved, with its cabinet, or refused, with the code and, when the refusal carries one,
 * the sentence written for the person (`reason`). A Refused's message is for logs and never sent: without a reason, the console explains
 * the code itself, as it does everywhere else (review of #188).
 */
export type BatchOutcome = { requestId: string; cabinet: string; outcome: "approved"; cabinetId: string } | { requestId: string; cabinet: string; outcome: "refused"; error: string; reason?: string };

/**
 * Approves several pending cabinets at one client and site, with one role and one baseline decision (F6.R2, decision-log D36). Each is
 * approved by approveEnrollment on its own, with its own audit entry, so one refusal (another site's installer, a taken name) does not
 * stop the others. An `attach` decision attaches the version with the first cabinet approved; the rest use it as the baseline in force.
 * A request listed twice is refused before anything runs. The batch itself is audited once, with what became of each.
 */
export async function approveBatch(pool: Pool, key: IssuingKey, common: Omit<Approval, "cabinetName" | "replacesCabinetId" | "scanner" | "sitePolicies">,
  cabinets: { requestId: string; cabinet: string }[], userId: string, signing?: ListSigningKeys): Promise<BatchOutcome[]> {
  const ids = cabinets.map(c => c.requestId.toLowerCase());
  if (new Set(ids).size !== ids.length) throw new Refused("invalid_request", 400, "a cabinet is listed twice in the batch");
  if (new Set(cabinets.map(c => c.cabinet.toLowerCase())).size !== cabinets.length) throw new Refused("invalid_request", 400, "two cabinets in the batch have the same name");
  const outcomes: BatchOutcome[] = [];
  let baseline = common.baseline;
  for (const c of cabinets) {
    try {
      const r = await approveEnrollment(pool, key, c.requestId.toLowerCase(), { ...common, ...(baseline ? { baseline } : {}), cabinetName: c.cabinet }, userId, signing);
      outcomes.push({ requestId: c.requestId.toLowerCase(), cabinet: c.cabinet, outcome: "approved", cabinetId: r.cabinetId.toLowerCase() });
      if (baseline?.use === "attach") baseline = { use: "inherited" };
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      outcomes.push({ requestId: c.requestId.toLowerCase(), cabinet: c.cabinet, outcome: "refused", error: e.code,
        ...(typeof e.extra?.reason === "string" ? { reason: e.extra.reason } : {}) });
    }
  }
  await transaction(pool, c => audit(c, { actorKind: "user", actorId: userId, action: "enrollment.approve_batch", targetKind: "enrollment", targetId: ids[0]!, outcome: "succeeded",
    details: { requests: ids, client: common.clientName, site: common.siteName, role: common.role, baseline: common.baseline ?? null,
      approved: outcomes.filter(o => o.outcome === "approved").length, refused: outcomes.filter(o => o.outcome === "refused").map(o => ({ requestId: o.requestId, error: (o as { error: string }).error })) } }));
  return outcomes;
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
export async function approvalBaselinePreview(db: Queryable, requestId: string, q: { client: string; site: string; role?: string | undefined }): Promise<ApprovalBaselinePreview> {
  if (!(await db.query("SELECT 1 AS x FROM enrollment_requests WHERE id = $1 AND status = 'pending'", [requestId])).rows[0])
    throw new Refused("not_pending", 409, "that enrollment request is not pending");
  const client = (await db.query<{ id: string }>("SELECT id FROM clients WHERE name = $1 AND removed_at IS NULL", [q.client])).rows[0] ?? null;
  const site = client ? (await db.query<{ id: string }>("SELECT id FROM sites WHERE client_id = $1 AND name = $2 AND removed_at IS NULL", [client.id, q.site])).rows[0] ?? null : null;
  const inForce = await approvedFor(db, placeScopes(q.role ?? null, client?.id ?? null, site?.id ?? null));
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

