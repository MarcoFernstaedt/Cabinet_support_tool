// Creates the test fleet: clients, sites (1 to 6 cabinets each, as clinics are), cabinets with their own client
// certificates issued by the server's development issuing key, and a few cabinets that never connect (commands to
// offline cabinets). Each site is in one of ten regions, so a regional outage takes whole sites down.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createPool } from "../../src/db/db.js";
import { developmentIssuingKey, issueAgentCertificate } from "../../src/pki/issuing.js";
import { csrFor, ecKey } from "../helpers.js";
import { seeded } from "./metrics.js";

export interface StateAgent { cabinetId: string; keyPem: string; certPem: string; site: number; region: number }
export interface State { caPem: string; userId: string; clientIds: string[]; siteIds: string[]; agents: StateAgent[]; offline: string[] }

export const REGIONS = 10;

export async function setup(count: number, statePath: string, offlineCount = Math.max(5, Math.round(count * 0.02)), seed = 1): Promise<void> {
  const url = process.env.DATABASE_URL, pki = process.env.DEV_PKI_DIR;
  if (!url || !pki) throw new Error("setup needs DATABASE_URL and DEV_PKI_DIR (the server's own).");
  if (!(Number.isInteger(count) && count > 0 && count <= 50_000)) throw new Error("--count must be 1 to 50000.");
  const key = await developmentIssuingKey(pki);
  const pool = await createPool(url, 4);
  const rand = seeded(seed);
  const tag = new Date().toISOString().replace(/[:.]/g, "-");
  const userId = randomUUID();
  await pool.query("INSERT INTO users (id, username, name, role) VALUES ($1, $2, 'Load test', 'tier1')", [userId, `load.${Date.now()}.${Math.floor(Math.random() * 1e6)}`]);

  // Sites of 1 to 6 cabinets (mean about 3), 500 cabinets to a client.
  const sizes: number[] = [];
  for (let left = count; left > 0;) { const n = Math.min(left, 1 + Math.floor(rand() * 6)); sizes.push(n); left -= n; }
  const clientIds: string[] = [];
  for (let c = 0; c < Math.ceil(count / 500); c++) {
    const id = randomUUID();
    await pool.query("INSERT INTO clients (id, name) VALUES ($1, $2)", [id, `Load test ${tag} ${c + 1}`]);
    clientIds.push(id);
  }
  const siteIds = sizes.map(() => randomUUID());
  const siteClientIndex: number[] = [];
  for (let s = 0, start = 0; s < sizes.length; start += sizes[s]!, s++) siteClientIndex.push(Math.min(clientIds.length - 1, Math.floor(start / 500)));
  const siteClient = (s: number): string => clientIds[siteClientIndex[s]!]!;
  for (let i = 0; i < siteIds.length; i += 300) {
    const chunk = siteIds.slice(i, i + 300);
    const values = chunk.map((_, j) => `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3})`).join(", ");
    await pool.query(`INSERT INTO sites (id, client_id, name) VALUES ${values}`, chunk.flatMap((id, j) => [id, siteClient(i + j), `Load site ${String(i + j).padStart(5, "0")}`]));
  }
  const offlineSite = randomUUID();
  await pool.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Load site (never connected)')", [offlineSite, clientIds[0]]);

  const agents: StateAgent[] = [];
  const offline: string[] = [];
  let site = 0, inSite = 0;
  const rows: unknown[][] = [];
  const certRows: unknown[][] = [];
  const flush = async (): Promise<void> => {
    if (rows.length === 0) return;
    await pool.query(`INSERT INTO cabinets (id, site_id, name, role, status) VALUES ${rows.map((_, j) => `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3}, 'standalone', 'active')`).join(", ")}`, rows.flat());
    await pool.query(`INSERT INTO cabinet_certificates (serial, cabinet_id, not_after) VALUES ${certRows.map((_, j) => `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3})`).join(", ")}`, certRows.flat());
    rows.length = 0; certRows.length = 0;
  };
  for (let i = 0; i < count + offlineCount; i++) {
    const cabinetId = randomUUID();
    const k = ecKey();
    const cert = await issueAgentCertificate(key, csrFor(k), cabinetId);
    const isOffline = i >= count;
    const siteId = isOffline ? offlineSite : siteIds[site]!;
    rows.push([cabinetId, siteId, `Load cabinet ${String(i).padStart(5, "0")}`]);
    certRows.push([cert.serialHex, cabinetId, cert.notAfter]);
    if (isOffline) offline.push(cabinetId);
    else {
      agents.push({ cabinetId, keyPem: k.keyPem, certPem: cert.pem, site, region: site % REGIONS });
      if (++inSite >= sizes[site]!) { site++; inSite = 0; }
    }
    if (rows.length >= 200) await flush();
    if ((i + 1) % 1000 === 0) console.log(`  ${i + 1} of ${count + offlineCount} cabinets`);
  }
  await flush();
  await pool.end();
  writeFileSync(statePath, JSON.stringify({ caPem: key.certificatePem, userId, clientIds, siteIds, agents, offline } satisfies State), { mode: 0o600 });
  console.log(`Set up ${count} cabinets in ${siteIds.length} sites and ${clientIds.length} clients, plus ${offlineCount} that never connect; identities in ${statePath}. ` +
    "The file holds private keys: delete it after the test.");
}
