// Creating clients and sites in bulk (F6.R4, decision-log D39). A list of rows, each a site and the client it belongs to, is previewed
// (what would be created and what already exists, no code) and then imported by an Admin with an authenticator code bound to the rows.
// A client or site that already exists is used as it is, so a list can be imported again after it is extended; a name is matched the
// way the database's unique indexes match it (case does not make a new client). The import is one transaction: every client and site
// is created with the same audit entry it has when created on its own, plus one `fleet.import` entry, or nothing is.
//
// Cabinets are not imported. A cabinet exists only once it has enrolled with its own key; a site installer for N cabinets (F6.R1) and
// batch approval (F6.R2) are how many cabinets arrive at once.
import { randomUUID } from "node:crypto";
import { consumeStepUpToken } from "../auth/stepup.js";
import { audit, auditMany, isUniqueViolation, transaction, type AuditEntry, type Pool, type Queryable } from "../db/db.js";
import { Refused } from "./errors.js";

export interface ImportRow { client: string; site: string }
export interface PlannedRow { client: string; site: string; clientId: string | null; siteId: string | null; newClient: boolean; newSite: boolean }
export interface ImportPlan { rows: PlannedRow[]; newClients: number; newSites: number }

/** The most rows one import takes; the contract holds the same limit. */
export const IMPORT_MAX_ROWS = 200;

const key = (name: string) => name.toLowerCase();

/** The rows checked for repeats: the same site of the same client twice is a mistake in the list, not something to merge. */
function checkRows(rows: readonly ImportRow[]): void {
  if (rows.length < 1 || rows.length > IMPORT_MAX_ROWS) throw new Refused("invalid_request", 400, `an import is 1 to ${IMPORT_MAX_ROWS} rows`);
  const seen = new Set<string>();
  for (const r of rows) {
    const k = JSON.stringify([key(r.client), key(r.site)]);
    if (seen.has(k)) throw new Refused("duplicate_row", 400, "the list names the same site of the same client twice");
    seen.add(k);
  }
}

/**
 * What the rows would do, read with locks when `lock` is set (inside the import's transaction, so two imports of the same new client
 * cannot both create it). A simulated demo client cannot be changed, so a row naming one refuses the whole list.
 */
async function plan(db: Queryable, rows: readonly ImportRow[], lock: boolean): Promise<ImportPlan> {
  checkRows(rows);
  const hint = lock ? "WITH (UPDLOCK, HOLDLOCK)" : "";
  const names = [...new Set(rows.map(r => r.client))];
  // The WITH clause gives the names the database's own collation, so they match the way clients_live_name does.
  const clients = (await db.query<{ id: string; name: string; demo: boolean | number }>(
    `SELECT c.id, c.name, c.demo FROM clients c ${hint} WHERE c.removed_at IS NULL AND c.name IN (SELECT n FROM OPENJSON($1) WITH (n nvarchar(128) '$'))`,
    [JSON.stringify(names)])).rows;
  if (clients.some(c => c.demo === true || c.demo === 1)) throw new Refused("demo_client", 409, "simulated demo clients cannot be changed");
  const clientId = new Map(clients.map(c => [key(c.name), c.id.toLowerCase()]));
  const sites = clients.length === 0 ? [] : (await db.query<{ id: string; client_id: string; name: string }>(
    `SELECT s.id, s.client_id, s.name FROM sites s ${hint} WHERE s.removed_at IS NULL AND s.client_id IN (SELECT i FROM OPENJSON($1) WITH (i uniqueidentifier '$'))`,
    [JSON.stringify(clients.map(c => c.id))])).rows;
  const siteId = new Map(sites.map(s => [JSON.stringify([s.client_id.toLowerCase(), key(s.name)]), s.id.toLowerCase()]));
  const newClients = new Set<string>();
  const out = rows.map(r => {
    const cid = clientId.get(key(r.client)) ?? null;
    const sid = cid ? siteId.get(JSON.stringify([cid, key(r.site)])) ?? null : null;
    if (!cid) newClients.add(key(r.client));
    return { client: r.client, site: r.site, clientId: cid, siteId: sid, newClient: !cid, newSite: !sid };
  });
  return { rows: out, newClients: newClients.size, newSites: out.filter(r => r.newSite).length };
}

/** What importing these rows would create and what already exists. Saves nothing. */
export const previewImport = (db: Queryable, rows: readonly ImportRow[]): Promise<ImportPlan> => plan(db, rows, false);

/**
 * Imports the rows: the code is consumed for exactly these rows, then every new client and site is created and audited, all in one
 * transaction. Nothing new to create is refused (`nothing_to_import`), so a mistaken re-import does not look like work done.
 */
export async function importClientsAndSites(pool: Pool, adminId: string, rows: readonly ImportRow[], stepUpToken: string): Promise<ImportPlan> {
  return transaction(pool, async c => {
    await consumeStepUpToken(c, stepUpToken, adminId, "fleet.import", "fleet", { rows });
    const p = await plan(c, rows, true);
    if (p.newSites === 0) throw new Refused("nothing_to_import", 409, "every client and site in the list already exists");
    const created = new Map<string, string>();
    const entries: AuditEntry[] = [];
    try {
      for (const r of p.rows) {
        if (!r.clientId) {
          r.clientId = created.get(key(r.client)) ?? null;
          if (!r.clientId) {
            r.clientId = randomUUID();
            created.set(key(r.client), r.clientId);
            await c.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [r.clientId, r.client]);
            entries.push({ actorKind: "user", actorId: adminId, action: "client.create", targetKind: "client", targetId: r.clientId, outcome: "succeeded", details: { name: r.client, via: "import" } });
          }
        }
        if (!r.siteId) {
          r.siteId = randomUUID();
          await c.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, $3)", [r.siteId, r.clientId, r.site]);
          entries.push({ actorKind: "user", actorId: adminId, action: "site.create", targetKind: "site", targetId: r.siteId, outcome: "succeeded", details: { clientId: r.clientId, name: r.site, via: "import" } });
        }
      }
    } catch (e) {
      // Only a name spelled differently from the one stored, in a way the database treats as the same (an accent rule, say), reaches here.
      if (isUniqueViolation(e)) throw new Refused("name_taken", 409, "a client or site in the list matches an existing one under another spelling");
      throw e;
    }
    await auditMany(c, entries);
    await audit(c, { actorKind: "user", actorId: adminId, action: "fleet.import", outcome: "succeeded",
      details: { rows: p.rows.length, newClients: p.newClients, newSites: p.newSites } });
    return p;
  });
}
