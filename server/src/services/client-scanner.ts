// The fingerprint scanner as a per-client choice (docs/spec/05-server-spec.md "Fingerprint scanner per client").
//
// On: the client's cabinets watch for the scanner, its checks run and its alerts open. Switching it on (at a new client's first approval,
// or on the client's page) puts the scanner's service on the client's approved list, as a change waiting for the Admin's signature when
// signing is on, and on the client's watched services; it may also set the client's scanner hardware IDs. The broker restarts a watched
// service only once the signed list approves it, so watching starts with the signature.
// Off: the agent is told not to look for a scanner, scanner events open no alert, open scanner alerts are resolved, the diagnosis skips
// the scanner, and the service comes off the client's watched list. The approved list is left alone: taking an entry off needs the same
// signature as putting one on, and an approved service nobody watches does nothing by itself.
import { consumeStepUpToken } from "../auth/stepup.js";
import { audit, safeJson, transaction, type Pool, type Queryable } from "../db/db.js";
import { closeClientIssueAlerts } from "./alerts.js";
import { ensureClientEntry, normalizeEntry, readLevelState } from "./approved-apps.js";
import type { ListSigningKeys } from "./approved-list-signing.js";
import { Refused } from "./errors.js";
import { compareVersions } from "./releases.js";
import { ISSUE } from "./rules.js";
import { parseJson } from "./settings.js";

/** The choice as the contract shapes it (common.schema.json#/$defs/clientScannerChoice). */
export interface ScannerChoice {
  enabled: boolean;
  service?: { key: string; kind: string; name: string; path: string; serviceName?: string };
  hardwareIds?: string[] | null;
}

/** The first agent version that knows the heartbeat answer's scanner.watch (the answer's contract is closed; an older agent would refuse it). */
export const SCANNER_WATCH_FROM_AGENT = "0.3.1-0";
export function knowsScannerWatch(agentVersion: string): boolean {
  try { return compareVersions(agentVersion, SCANNER_WATCH_FROM_AGENT) >= 0; } catch { return false; }
}

/** The resolution an open scanner alert gets when its client stops using a scanner. */
const NOT_USED = "The client does not use a fingerprint scanner.";
/** The most services a watched list holds (the watched-services contract). */
const MAX_WATCHED = 16;

/**
 * Applies a choice to one client, in the caller's transaction (the caller has checked the role and the step-up). Returns what became of
 * the scanner's approved-list entry when it was switched on.
 */
export async function applyScannerChoice(c: Queryable, userId: string, clientId: string, choice: ScannerChoice, signing?: ListSigningKeys):
  Promise<{ approval: "approved" | "waiting" | "written" | null; resolvedAlerts: number }> {
  const client = (await c.query<{ watched: string | null; service: string | null }>(
    "SELECT watched_services AS watched, scanner_service AS service FROM clients WITH (UPDLOCK, ROWLOCK) WHERE id = $1 AND removed_at IS NULL", [clientId])).rows[0];
  if (!client) throw new Refused("not_found", 404, "no such client");
  const own = parseJson<string[]>(client.watched);
  const fleet = parseJson<unknown>((await c.query<{ value: string | null }>("SELECT TOP (1) [value] FROM settings WHERE [key] = 'services.watched'")).rows[0]?.value ?? null);
  const watched = own ?? (Array.isArray(fleet) ? fleet as string[] : []);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  if (!choice.enabled) {
    // The service comes off the list the client's cabinets actually use: its own, else a copy of the fleet's without it.
    const service = client.service;
    const next = service && watched.some(n => same(n, service)) ? watched.filter(n => !same(n, service)) : null;
    await c.query("UPDATE clients SET fingerprint_scanner = 0, watched_services = COALESCE($2, watched_services) WHERE id = $1",
      [clientId, next === null ? null : safeJson(next)]);
    // Open scanner alerts of the client's cabinets go: nothing is watched any more, so nothing would ever close them. alerts.ts closes them
    // and audits each closure by this user, in this transaction (D100).
    const closed = await closeClientIssueAlerts(c, userId, clientId, ISSUE.scanner, NOT_USED);
    await audit(c, { actorKind: "user", actorId: userId, action: "client.fingerprint_scanner", targetKind: "client", targetId: clientId, outcome: "succeeded",
      details: { enabled: false, unwatched: next === null ? null : service, resolvedAlerts: closed.length } });
    return { approval: null, resolvedAlerts: closed.length };
  }

  // The contract required a service entry; the approved-list rules decide whether its path and name are acceptable.
  const entry = normalizeEntry(choice.service);
  if (!entry.ok || entry.entry.kind !== "service" || !entry.entry.serviceName)
    throw new Refused("invalid_params", 400, `the scanner's service was refused: ${entry.ok ? "not a service" : entry.reason}`);
  const serviceName = entry.entry.serviceName;
  const nextWatched = watched.some(n => same(n, serviceName)) ? watched : [...watched, serviceName];
  // Said about the list the client actually follows: its own, or the fleet's, which is the one to trim then.
  if (nextWatched.length > MAX_WATCHED) throw new Refused("too_many_items", 409, `the ${own ? "client's" : "fleet's"} watched services list already holds ${MAX_WATCHED} services`,
    { reason: own ? `The client already watches ${MAX_WATCHED} services. Remove one before adding the scanner's service.`
      : `This client follows the fleet's watched services list, which already holds ${MAX_WATCHED}. Remove one from the fleet list, or give the client its own list, before adding the scanner's service.` });
  await c.query(`UPDATE clients SET fingerprint_scanner = 1, scanner_service = $2, watched_services = $3
                 ${choice.hardwareIds ? ", scanner_hardware_ids = $4" : ""} WHERE id = $1`,
    [clientId, serviceName, safeJson(nextWatched), ...(choice.hardwareIds ? [safeJson(choice.hardwareIds)] : [])]);
  const approval = await ensureClientEntry(c, userId, clientId, entry.entry, signing);
  await audit(c, { actorKind: "user", actorId: userId, action: "client.fingerprint_scanner", targetKind: "client", targetId: clientId, outcome: "succeeded",
    details: { enabled: true, service: serviceName, approval, hardwareIds: choice.hardwareIds ?? null } });
  return { approval, resolvedAlerts: 0 };
}

/** Switches a client's scanner on or off (Admin, with an authenticator code bound to the exact choice). */
export async function setClientScanner(pool: Pool, user: { userId: string; role: string }, clientId: string, choice: ScannerChoice,
  stepUpToken: string, signing?: ListSigningKeys): Promise<{ approval: "approved" | "waiting" | "written" | null; resolvedAlerts: number }> {
  if (user.role !== "admin") throw new Refused("forbidden", 403, "only an Admin changes whether a client uses a fingerprint scanner");
  return transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, user.userId, "client.fingerprint_scanner", clientId, { scanner: choice });
    return applyScannerChoice(c, user.userId, clientId, choice, signing);
  });
}

/** What the client's page shows: whether the scanner is used, its service, and where that service stands on the approved list. */
export interface ClientScannerState {
  enabled: boolean;
  service: string | null;
  /** approved: the list in force approves it; waiting: a change awaiting the Admin's signature does; missing: neither does. */
  approval: "approved" | "waiting" | "missing" | null;
}

export async function clientScanner(db: Queryable, clientId: string): Promise<ClientScannerState | null> {
  const row = (await db.query<{ on: boolean; service: string | null }>(
    "SELECT fingerprint_scanner AS [on], scanner_service AS service FROM clients WHERE id = $1 AND removed_at IS NULL", [clientId])).rows[0];
  if (!row) return null;
  if (!row.on || !row.service) return { enabled: !!row.on, service: row.service, approval: null };
  const state = await readLevelState(db, "client", clientId);
  const fleet = state.list || state.pending ? null : (await readLevelState(db, "fleet", null)).list;
  const has = (list: { entries: { serviceName: string | null }[] } | null) => !!list?.entries.some(e => (e.serviceName ?? "").toLowerCase() === row.service!.toLowerCase());
  const approval = has(state.list) || has(fleet) ? "approved" : has(state.pending) ? "waiting" : "missing";
  return { enabled: true, service: row.service, approval };
}

/** Whether a cabinet's client uses a fingerprint scanner (for the paths that read one cabinet at a time). */
export async function scannerUsedFor(db: Queryable, cabinetId: string): Promise<boolean> {
  const r = (await db.query<{ on: boolean }>(
    "SELECT c.fingerprint_scanner AS [on] FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id WHERE k.id = $1", [cabinetId])).rows[0];
  return r ? !!r.on : true;
}
