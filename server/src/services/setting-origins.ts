// Where each of a cabinet's settings comes from (F6.R5, decision-log D38). Every setting that has a parent scope is resolved when it is
// read, from the cabinet up through its site, its client (and, for watched services, its role) to the fleet default, so a new cabinet
// inherits whatever is set above it the moment it is approved: nothing is copied onto it. This read names, for each such setting, the
// level that applies, every level that sets it, and the levels whose stored value was rejected. It uses the same resolver each setting is
// enforced with, so the console cannot show one origin while the cabinet follows another.
import { type Queryable } from "../db/db.js";
import { appLevels } from "./approved-apps.js";
import { approvedFor, cabinetScopes } from "./baselines.js";
import { scannerLevels, syncPortsForSite } from "./device-settings.js";
import { Refused } from "./errors.js";
import { sitePolicy } from "./firewall-policy.js";
import { siteClockTolerance, siteTimeZone } from "./time.js";
import { checkStoredUsbPolicy } from "./usb-policy.js";
import { usbPolicyLevels } from "./usb-store.js";
import { watchLevels } from "./watched-services.js";

/** A level a setting can be set at. Not every setting has every level; `automatic` and `none` are what applies when no level sets it. */
export type OriginLevel = "cabinet" | "site" | "client" | "model" | "role" | "fleet";
export type OriginSource = OriginLevel | "default" | "automatic" | "none";

/** The settings with a parent scope, in the order the console lists them. A setting added with a parent scope belongs here. */
export const ORIGIN_SETTINGS = ["firewallPolicy", "networkBaseline", "timeZone", "clockTolerance", "syncPorts", "scannerUse", "scannerIds", "watchedServices", "approvedApps",
  "usbWatch", "configBaseline"] as const;
export type OriginSetting = (typeof ORIGIN_SETTINGS)[number];

export interface SettingOrigin {
  setting: OriginSetting;
  /** The level whose value applies, or what applies when no level sets it. */
  source: OriginSource;
  /** Every level that sets it, in the order the setting is resolved: the first one listed that is not rejected is the source. */
  setAt: OriginLevel[];
  /** Levels whose stored value is present but was refused when read: reported, never used. */
  rejected: OriginLevel[];
  /** How many entries apply, for the settings that are lists; null for the rest. */
  count: number | null;
}

/** The levels given that hold a value, in the order they are given: each call lists them in its setting's own order of precedence. */
const present = (levels: Partial<Record<OriginLevel, unknown>>) => (Object.keys(levels) as OriginLevel[]).filter(k => levels[k] !== null && levels[k] !== undefined);
/** The four-level settings (approved programs, file-facts paths, USB watch) resolve cabinet, site, client, fleet. */
const FOUR: OriginLevel[] = ["cabinet", "site", "client", "fleet"];
const inOrder = (order: OriginLevel[], levels: OriginLevel[]) => order.filter(l => levels.includes(l));

/** For one cabinet, where every setting with a parent scope comes from. A cabinet that does not exist (or was removed) is not found. */
export async function settingOrigins(db: Queryable, cabinetId: string): Promise<SettingOrigin[]> {
  const k = (await db.query<{ site_id: string }>("SELECT site_id FROM cabinets WHERE id = $1 AND status <> 'removed'", [cabinetId])).rows[0];
  if (!k) throw new Refused("not_found", 404, "no such cabinet");
  const siteId = k.site_id;
  const out: SettingOrigin[] = [];

  // The firewall policy has a built-in default at the fleet level: with nothing stored anywhere, the default applies.
  const fw = await sitePolicy(db, siteId);
  const fleetFw = (await db.query("SELECT 1 AS x FROM settings WHERE [key] = 'firewall.policy'")).rows.length > 0;
  out.push({ setting: "firewallPolicy", source: fw.source === "fleet" && !fleetFw ? "default" : fw.source,
    setAt: present({ site: fw.own, client: fw.client, fleet: fleetFw ? fw.fleet : null }), rejected: [], count: null });

  // The network baseline is set per site only.
  const net = (await db.query<{ b: string | null }>("SELECT network_baseline AS b FROM sites WHERE id = $1", [siteId])).rows[0]?.b ?? null;
  out.push({ setting: "networkBaseline", source: net ? "site" : "none", setAt: net ? ["site"] : [], rejected: [], count: null });

  const tz = await siteTimeZone(db, siteId);
  out.push({ setting: "timeZone", source: tz.source ?? "none", setAt: present({ site: tz.own, client: tz.client, fleet: tz.fleet }), rejected: [], count: null });

  // The clock tolerance has a built-in default (120 seconds) when no level sets one (D109).
  const tol = await siteClockTolerance(db, siteId);
  out.push({ setting: "clockTolerance", source: tol.source, setAt: present({ site: tol.own, client: tol.client, fleet: tol.fleet }), rejected: [], count: null });

  const ports = (await syncPortsForSite(db, siteId))!;
  out.push({ setting: "syncPorts", source: ports.source, setAt: present({ site: ports.site, client: ports.client, fleet: ports.fleet }), rejected: [],
    count: ports.effective.length });

  // Whether the cabinet looks for a fingerprint scanner at all is the client's choice, and only the client's.
  out.push({ setting: "scannerUse", source: "client", setAt: ["client"], rejected: [], count: null });

  const sc = await scannerLevels(db, cabinetId);
  const listed = (v: string[] | null) => v && v.length ? v : null; // the scanner treats an empty list as unset
  out.push({ setting: "scannerIds", source: sc.source, setAt: present({ cabinet: listed(sc.cabinet), site: listed(sc.site), client: listed(sc.client), fleet: listed(sc.fleet) }),
    rejected: [], count: sc.effective?.length ?? null });

  const w = await watchLevels(db, cabinetId);
  // The role's required services come last: they are the list when no level sets one (decision-log D34).
  out.push({ setting: "watchedServices", source: w.source, setAt: present({ cabinet: w.cabinet, site: w.site, client: w.client, fleet: w.fleet, role: w.role }),
    rejected: [], count: w.effective.length });

  const apps = await appLevels(db, cabinetId);
  out.push({ setting: "approvedApps", source: apps.source, setAt: inOrder(FOUR, [...present({ cabinet: apps.cabinet, site: apps.site, client: apps.client, fleet: apps.fleet }), ...apps.rejected]),
    rejected: inOrder(FOUR, apps.rejected), count: apps.effective?.entries.length ?? null });


  // A USB watch policy names one device or slot, so several levels can each watch their own: every valid level is in force for what it
  // names, and the most specific one wins where two name the same thing. The source is the most specific valid level.
  const usb = await usbPolicyLevels(db, cabinetId);
  const usbSet = usb.filter(l => l.stored !== null && l.stored !== undefined);
  const usbValid = usbSet.filter(l => checkStoredUsbPolicy(l.stored).ok).map(l => l.level as OriginLevel);
  out.push({ setting: "usbWatch", source: inOrder(FOUR, usbValid)[0] ?? "none", setAt: inOrder(FOUR, usbSet.map(l => l.level as OriginLevel)),
    rejected: inOrder(FOUR, usbSet.filter(l => !checkStoredUsbPolicy(l.stored).ok).map(l => l.level as OriginLevel)), count: usbValid.length });

  // The configuration baseline layers: every approved baseline from the fleet's ("global") down to the cabinet's own applies, the most
  // specific winning item by item. The source is the most specific level with an approved baseline; a role or model baseline is below the client's.
  const approved = await approvedFor(db, await cabinetScopes(db, cabinetId));
  const baselineLevels = approved.map(o => o.kind === "global" ? "fleet" as const : o.kind).reverse();
  out.push({ setting: "configBaseline", source: baselineLevels[0] ?? "none", setAt: baselineLevels, rejected: [], count: null });
  return out;
}
