// Replacing a cabinet (docs/spec/05-server-spec.md "Replacing a cabinet"). When a drive fails, the agent is installed again on the new
// drive and its enrollment is approved as "this replaces <cabinet>". In the approval's transaction:
//   - the old cabinet is retired: its certificate is revoked, its open alerts are resolved, and its record keeps its history; when the
//     new cabinet takes its name, the old one is renamed "<name> (replaced <date>)";
//   - the new cabinet takes its place: its sync link (a satellite), its satellites (a sync cabinet) and its Admin-set sync address;
//   - the old cabinet's own settings are copied: scanner IDs, watched services, file-facts paths, the in-office flag, its approved
//     programs (waiting for the Admin's signature when signing is on), its USB watch policy and its cabinet baseline.
// What it re-applies on the machine itself is queued here and runs once the new agent reports (replacement-reapply.ts).
import { audit, notify, type Queryable } from "../db/db.js";
import { closeReplacedCabinetAlerts } from "./alerts.js";
import { REVOCATION_CHANNEL } from "../agent-api/revocations.js";
import { copyCabinetList } from "./approved-apps.js";
import type { ListSigningKeys } from "./approved-list-signing.js";
import { copyCabinetBaseline } from "./baselines.js";
import { Refused } from "./errors.js";
import { upsertSetting } from "./settings.js";
// The cabinets rows themselves are written by their owners: cabinets.ts, and sync-cabinets.ts for the sync link (D129).
import { LIVE_LINK, moveSatellites } from "./sync-cabinets.js";
import { renameCabinet, retireCabinet, revokeCabinetCertificates } from "./cabinets.js";
import { checkStoredUsbPolicy, usbPolicyAuditEntry, usbPolicySettingKey } from "./usb-policy.js";
import { readUsbPolicyRow } from "./usb-store.js";
import { queueReapply } from "./replacement-reapply.js";

/** The old cabinet as the replacement reads it, under lock. */
export interface OldCabinet {
  id: string; siteId: string; name: string; role: string;
  /** Its live sync link (a satellite), or null. */
  syncCabinetId: string | null;
  syncAddress: string | null; syncAddressSource: string | null;
  scannerHardwareIds: string | null; watchedServices: string | null; filefactsPaths: string | null; inOffice: boolean;
}

/**
 * Reads the cabinet to be replaced and checks it can be: an active cabinet at the approval's site, with the same role, not replaced
 * already. Locked until the approval commits, so two approvals cannot both replace it.
 */
export async function lockReplaced(c: Queryable, cabinetId: string, siteId: string, role: string): Promise<OldCabinet> {
  const r = (await c.query<{ id: string; site_id: string; name: string; role: string; status: string; live_sync: string | null; sync_address: string | null;
    sync_address_source: string | null; scanner_hardware_ids: string | null; watched_services: string | null; filefacts_paths: string | null; in_office: boolean }>(
    `SELECT k.id, k.site_id, k.name, k.role, k.status, CASE WHEN ${LIVE_LINK} THEN k.sync_cabinet_id END AS live_sync, k.sync_address, k.sync_address_source,
            k.scanner_hardware_ids, k.watched_services, k.filefacts_paths, k.in_office
       FROM cabinets k WITH (UPDLOCK, ROWLOCK) WHERE k.id = $1`, [cabinetId])).rows[0];
  if (!r || r.status !== "active") throw new Refused("not_replaceable", 409, "only an active cabinet can be replaced",
    { reason: "That cabinet is not active (it may have been replaced or removed already). Choose another, or approve without replacing." });
  if (r.site_id.toLowerCase() !== siteId.toLowerCase()) throw new Refused("replacement_elsewhere", 409, "a replacement goes to the replaced cabinet's site",
    { reason: "The cabinet it replaces is at another site. Approve it at that cabinet's client and site." });
  if (r.role !== role) throw new Refused("replacement_role_differs", 409, "a replacement has the replaced cabinet's role",
    { reason: `The cabinet it replaces is a ${r.role} cabinet. Approve the replacement with the same role.` });
  return { id: r.id, siteId: r.site_id, name: r.name, role: r.role, syncCabinetId: r.live_sync, syncAddress: r.sync_address, syncAddressSource: r.sync_address_source,
    scannerHardwareIds: r.scanner_hardware_ids, watchedServices: r.watched_services, filefactsPaths: r.filefacts_paths, inOffice: !!r.in_office };
}

/** Frees the old cabinet's name for its replacement: "<name> (replaced YYYY-MM-DD)", made unique at the site if it has to be. */
export async function freeName(c: Queryable, old: OldCabinet, now = new Date()): Promise<string> {
  const stamp = ` (replaced ${now.toISOString().slice(0, 10)})`;
  let name = old.name.slice(0, 128 - stamp.length) + stamp;
  if ((await c.query("SELECT 1 AS x FROM cabinets WHERE site_id = $1 AND name = $2", [old.siteId, name])).rows.length > 0) {
    const more = ` ${old.id.slice(0, 8)}`;
    name = old.name.slice(0, 128 - stamp.length - more.length) + stamp.slice(0, -1) + more + ")";
  }
  await renameCabinet(c, old.id, name);
  return name;
}

/**
 * Everything after the new cabinet exists: its place, the old cabinet's settings, and the old cabinet retired. The caller has inserted
 * the new cabinet with the copied columns and its replaces_cabinet_id, and calls noteRevocation() after the commit.
 */
export async function completeReplacement(c: Queryable, userId: string, old: OldCabinet, newId: string, newName: string, signing?: ListSigningKeys) {
  // A sync cabinet's satellites follow it to the new one.
  const moved = old.role === "sync" ? await moveSatellites(c, old.id, newId) : 0;
  // The old cabinet's own approved programs, USB watch policy and baseline.
  const apps = await copyCabinetList(c, userId, old.id, newId, signing);
  const usbRaw = await readUsbPolicyRow(c, "cabinet", old.id);
  const usb = checkStoredUsbPolicy(usbRaw);
  if (usb.ok) {
    await upsertSetting(c, usbPolicySettingKey("cabinet", newId), { version: 1, policy: usb.stored.policy }, userId);
    await audit(c, usbPolicyAuditEntry({ level: "cabinet", scopeId: newId, userId, version: 1, before: null, after: usb.stored.policy }));
  }
  const baseline = await copyCabinetBaseline(c, userId, old.id, newId);

  // The old cabinet is retired: no certificate, no open alerts, its history kept.
  await retireCabinet(c, old.id);
  await revokeCabinetCertificates(c, old.id);
  await notify(c, REVOCATION_CHANNEL, old.id);
  const resolution = `Replaced by ${newName}.`;
  // alerts.ts closes them and audits each closure by this user, in this transaction (D101).
  const closed = await closeReplacedCabinetAlerts(c, userId, old.id, newId, resolution);
  const copied = { scannerIds: old.scannerHardwareIds !== null, watchedServices: old.watchedServices !== null, filefactsPaths: old.filefactsPaths !== null,
    inOffice: old.inOffice, approvedApps: apps, usbPolicy: usb.ok, baseline: baseline?.versionId ?? null };
  // The settings on the machine (firewall, time zone, drawer, DNS, address), put back once the new agent reports.
  await queueReapply(c, newId, old.id, userId);
  await audit(c, { actorKind: "user", actorId: userId, action: "cabinet.replace", targetKind: "cabinet", targetId: newId, outcome: "succeeded",
    details: { replaces: old.id, oldName: old.name, satellitesMoved: moved, alertsResolved: closed.length, copied } });
  await audit(c, { actorKind: "user", actorId: userId, action: "cabinet.revoke", targetKind: "cabinet", targetId: old.id, outcome: "succeeded", details: { replacedBy: newId } });
  return { replaces: old.id, satellitesMoved: moved, alertsResolved: closed.length, copied };
}
