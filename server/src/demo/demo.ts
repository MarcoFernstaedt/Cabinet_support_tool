// Demo mode (docs/platform/demo.md). An Admin turns it on to show the platform at fleet scale next to the real cabinets:
// simulated clients, sites and cabinets, each with one problem to find. Everything they produce goes through the same
// server code as a real agent's (heartbeats, events and the alerts engine, command delivery, results checked against the
// output schema), so alerts, history and the audit log behave exactly as they would for real cabinets. Turning it off
// deletes every simulated record (security alerts stay, unlinked). Real cabinets are never touched: a simulated cabinet is one with a demo_scenario.
import { Refused } from "../services/errors.js";
import { randomUUID } from "node:crypto";
import { audit, isDeadlock, safeJson, transaction, type Pool, type Queryable } from "../db/db.js";
import { recordHeartbeat } from "../services/cabinets.js";
import { storeEvents } from "../services/events.js";
import { storeResult, takeQueuedCommands } from "../services/commands.js";
import { checkOffline } from "../services/alerts.js";
import { evaluateDrift } from "../services/firewall-policy.js";
import { checkQuietLoops, recordBoot } from "../services/crashes.js";
import type { Event } from "../contracts.js";
import { DEMO_FLEET, DRIFT_SECONDS, harborDriverWithoutCrash, harborStorageErrors, hostnameFor, wrongZoneFor, type Scenario } from "./fleet.js";
import { evaluateTime } from "../services/time.js";
import { checkSiteOutages } from "../services/site-outage.js";
import { demoOutput, examplesAvailable, type DemoContext } from "./outputs.js";
import { refreshDrive } from "../services/drives.js";
import { applySetDns, applySetIp, baselineFor, initialNet, NET_SCENARIOS, netProblems, type DemoNet } from "./network.js";
import { saveKnownFix } from "../services/known-fixes.js";
import { ISSUE } from "../services/rules.js";
import { seedDemoTroubleshooting } from "./troubleshooting.js";
import { raiseBaselineAlert } from "../diagnose/network.js";
import type { NetworkBaseline } from "../diagnose/network-findings.js";

const SETTING = "demo.enabled";
/** A made-up Tier 1 teammate who has already submitted a fix, so the approval queue has something to review. They cannot sign in. */
const DEMO_MEMBER = "demo.priya";
const AGENT_VERSION = "1.4.2";
type Profiles = { domain: boolean; private: boolean; public: boolean };
const ALL_OFF: Profiles = { domain: false, private: false, public: false };

export async function demoEnabled(db: Queryable): Promise<boolean> {
  return (await db.query<{ value: boolean }>("SELECT [value] FROM settings WHERE [key] = $1", [SETTING])).rows[0]?.value === true;
}

/** Sets one settings row (insert or update). `json` is the JSON text of the value. */
async function upsertSetting(db: Queryable, key: string, json: string, changedBy: string | null = null): Promise<void> {
  await db.query(`MERGE settings WITH (HOLDLOCK) AS t USING (SELECT $1 AS [key], $2 AS [value], $3 AS changed_by) AS s ON t.[key] = s.[key]
                  WHEN MATCHED THEN UPDATE SET [value] = s.[value], changed_by = s.changed_by, changed_at = SYSUTCDATETIME()
                  WHEN NOT MATCHED THEN INSERT ([key], [value], changed_by) VALUES (s.[key], s.[value], s.changed_by);`, [key, json, changedBy]);
}

/**
 * Inserts rows in as few statements as SQL Server allows (2100 parameters and 1000 rows per statement). The table, the columns and the
 * literal columns (name, SQL text) are fixed lists in this file; every value travels as a parameter.
 */
async function insertMany(db: Queryable, table: string, columns: readonly string[], rows: readonly (readonly unknown[])[], literals: readonly (readonly [string, string])[] = []): Promise<void> {
  if (rows.length === 0) return;
  const names = [...columns, ...literals.map(l => l[0])].map(c => `[${c}]`).join(", ");
  const perStatement = Math.max(1, Math.min(1000, Math.floor(2000 / columns.length)));
  for (let i = 0; i < rows.length; i += perStatement) {
    const params: unknown[] = [];
    const tuples = rows.slice(i, i + perStatement).map(row => `(${[...row.map(v => { params.push(v); return `$${params.length}`; }), ...literals.map(l => l[1])].join(", ")})`);
    await db.query(`INSERT INTO ${table} (${names}) VALUES ${tuples.join(", ")}`, params);
  }
}

/** Error sources only the demo's cabinets log. A rule someone maps for them during the guided demo goes when the demo is turned off or reset. */
const DEMO_ERROR_SOURCES = ["Microsoft-Windows-Biometrics", "WUDFHost", "BillingExport", "MedSyncAgent"];

/**
 * Whether the guided demo's story can be followed from its first step: the sync cabinet's firewall is still wrong, nobody has mapped the
 * scanner driver's errors, the teammate's fix is still waiting, and Reception still has an unrecognized alert. Once any of that has been
 * used up, starting the guided demo resets the demo first.
 */
export async function storyReady(pool: Pool): Promise<boolean> {
  if (!(await demoEnabled(pool))) return false;
  const r = (await pool.query<{ ok: boolean }>(
    `SELECT CAST(CASE WHEN EXISTS (SELECT 1 FROM cabinets WHERE name = 'Midtown Sync' AND demo_scenario = 'firewall_drift')
        AND NOT EXISTS (SELECT 1 FROM symptom_rules WHERE built_in = 0 AND state IN ('live', 'proposed') AND JSON_VALUE([match], '$.source') IN (SELECT value FROM OPENJSON($1)))
        AND EXISTS (SELECT 1 FROM known_fixes f JOIN users u ON u.id = f.created_by WHERE u.username = $2 AND f.status = 'pending' AND f.removed_at IS NULL)
        AND EXISTS (SELECT 1 FROM alerts a JOIN cabinets k ON k.id = a.cabinet_id WHERE k.name = 'Reception' AND k.demo_scenario IS NOT NULL AND a.issue_type_id IS NULL AND a.state <> 'resolved')
        THEN 1 ELSE 0 END AS bit) AS ok`,
    [DEMO_ERROR_SOURCES, DEMO_MEMBER])).rows[0]!;
  return r.ok;
}

export async function demoStatus(pool: Pool) {
  const n = (await pool.query<{ clients: number; cabinets: number }>(
    `SELECT (SELECT count(*) FROM clients WHERE demo = 1) AS clients, (SELECT count(*) FROM cabinets WHERE demo_scenario IS NOT NULL) AS cabinets`)).rows[0]!;
  return { enabled: await demoEnabled(pool), clients: Number(n.clients), cabinets: Number(n.cabinets), storyReady: await storyReady(pool) };
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The overnight incident: when the first cabinet crashed, and what came before it. */
export const INCIDENT_HOURS_AGO = 20;
export const INCIDENT_UPDATE = "2026-10 Cumulative Update for Windows 10 Version 21H2 (KB5050011)";
export const INCIDENT_DRIVER = "iastorac.inf (Intel(R) Rapid Storage Technology 19.5.0.1037)";
const LOOPING: Scenario[] = ["offline", "incident_loop", "site_outage"];
/** Scenario B: when the site's cabinets stopped reporting, a few seconds apart. */
export const OUTAGE_MINUTES_AGO = 40;

/** The events a scenario has produced over the last days, oldest first. n numbers the cabinets of the incident. */
export function scenarioEvents(scenario: Scenario, now = Date.now(), n = 0): Event[] {
  let record = 200_000;
  const t0 = now - INCIDENT_HOURS_AGO * 3_600_000;
  const atMs = (ms: number) => iso(ms);
  const change = (ms: number, source: string, eventId: number, message: string, log = "System"): Event => ({
    eventId: randomUUID(), kind: "change", occurredAt: atMs(ms), severityHint: "minor",
    source: { log: log as never, source, eventId, level: "information", recordId: record++ }, detail: { message } });
  const errAt = (ms: number, source: string, eventId: number, message: string, severity: "major" | "minor" = "minor", level = "error"): Event => ({
    eventId: randomUUID(), kind: "error", occurredAt: atMs(ms), severityHint: severity,
    source: { log: "System", source, eventId, level: level as never, recordId: record++ }, detail: { message } });
  const min = 60_000;
  const update = () => [
    change(t0 - 52 * min, "Microsoft-Windows-WindowsUpdateClient", 43, `Installation Started: Windows has started installing the following update: ${INCIDENT_UPDATE}`),
    change(t0 - 50 * min, "Microsoft-Windows-WindowsUpdateClient", 19, `Installation Successful: Windows successfully installed the following update: ${INCIDENT_UPDATE}`),
  ];
  const driver = () => [change(t0 - 35 * min, "Microsoft-Windows-UserPnp", 20001,
    `Driver Management concluded the process to install driver ${INCIDENT_DRIVER} for Device Instance ID PCI\\VEN_8086&DEV_282A with the following status: 0x0.`)];
  const restart = () => [
    change(t0 - 20 * min, "User32", 1074, "The process C:\\Windows\\servicing\\TrustedInstaller.exe has initiated the restart of this computer for the following reason: Operating System: Upgrade (Planned)"),
    change(t0 - 18 * min, "Microsoft-Windows-Kernel-General", 12, "The operating system started."),
  ];
  const crashAt = (ms: number) => [
    errAt(ms - 30_000, "Microsoft-Windows-Kernel-Power", 41, "The system has rebooted without cleanly shutting down first."),
    errAt(ms, "BugCheck", 1001, "The computer has rebooted from a bugcheck. The bugcheck was: 0x000000d1 (0x0000000000000028, 0x0000000000000002, 0x0000000000000000, 0xfffff8063c41a2b0). A dump was saved in: C:\\Windows\\Minidump\\100826-9875-01.dmp.", "major"),
  ];
  const at = (hoursAgo: number) => iso(now - hoursAgo * 3_600_000);
  const err = (hoursAgo: number, source: string, eventId: number, message: string, severity: "major" | "minor" = "minor", log = "System", level = "error", fields: Record<string, string> = {}): Event => ({
    eventId: randomUUID(), kind: "error", occurredAt: at(hoursAgo), severityHint: severity,
    source: { log: log as never, source, eventId, level: level as never, recordId: record++ }, detail: { message, fields } });
  switch (scenario) {
    case "scanner_disconnected":
      return [{ eventId: randomUUID(), kind: "scanner", occurredAt: at(2), severityHint: "major",
        device: { hardwareIds: ["USB\\VID_1234&PID_5678"], deviceInstanceId: "USB\\VID_1234&PID_5678\\6&2A1B3C4D&0&2", name: "Fingerprint Reader", state: "disconnected" },
        detail: { message: "The fingerprint scanner was disconnected.", fields: { usbPort: "Port_#0002.Hub_#0003" } } }];
    case "scanner_flapping": {
      // The scanner's driver was updated yesterday evening; since then it has dropped off three times, and it is off now.
      const dev = { hardwareIds: ["USB\\VID_1234&PID_5678"], deviceInstanceId: "USB\\VID_1234&PID_5678\\6&2A1B3C4D&0&2", name: "Fingerprint Reader" };
      const scanner = (h: number, state: "disconnected" | "recovered", message: string): Event => ({ eventId: randomUUID(), kind: "scanner", occurredAt: at(h),
        severityHint: state === "disconnected" ? "major" : "minor", device: { ...dev, hardwareIds: [dev.hardwareIds[0]!] as [string, ...string[]], state }, detail: { message, fields: { usbPort: "Port_#0002.Hub_#0003" } } });
      return [
        change(now - 22 * 3_600_000, "Microsoft-Windows-UserPnp", 20001, "Driver Management concluded the process to install driver oem42.inf for Device Instance ID USB\\VID_1234&PID_5678\\6&2A1B3C4D&0&2 with the following status: 0x0."),
        scanner(20, "disconnected", "The fingerprint scanner was disconnected."), scanner(19.8, "recovered", "The fingerprint scanner is back."),
        scanner(11, "disconnected", "The fingerprint scanner was disconnected."), scanner(10.8, "recovered", "The fingerprint scanner is back."),
        scanner(2, "disconnected", "The fingerprint scanner was disconnected."),
      ];
    }
    case "service_failing":
      return [3, 1].map((h): Event => ({ eventId: randomUUID(), kind: "service", occurredAt: at(h), severityHint: "minor",
        detail: { message: "BioScanSvc stopped and was started again.", fields: { service: "BioScanSvc", change: "restarted", restartsToday: "1" } } }))
        .concat([{ eventId: randomUUID(), kind: "service", occurredAt: at(0.2), severityHint: "major",
          detail: { message: "BioScanSvc failed 3 restarts in a row.", fields: { service: "BioScanSvc", change: "failing", restartsToday: "3", errorCode: "1053" } } }]);
    case "disk_failing":
      return [
        err(70, "disk", 153, "The IO operation at logical block address 0x1d2f3 for Disk 0 was retried."),
        err(30, "disk", 153, "The IO operation at logical block address 0x1d2f7 for Disk 0 was retried."),
        err(6, "disk", 7, "The device, \\Device\\Harddisk0\\DR0, has a bad block.", "major"),
        { eventId: randomUUID(), kind: "smart_warning", occurredAt: at(5), severityHint: "major", detail: { message: "Drive predicts failure.", fields: { model: "NVMe 256GB" } } },
      ];
    case "bsod":
      return [50, 26, 3].flatMap(h => [
        err(h + 0.1, "Microsoft-Windows-Kernel-Power", 41, "The system has rebooted without cleanly shutting down first."),
        err(h, "BugCheck", 1001, "The computer has rebooted from a bugcheck. The bugcheck was: 0x0000007e (0xffffffffc0000005, 0xfffff8012a4b1c20, 0xffffd50f3a2e7a58, 0xffffd50f3a2e7290). A dump was saved in: C:\\Windows\\Minidump.",
          "major", "System", "error", { bugcheck: "0x0000007e" }),
      ]);
    case "dns_errors":
      return [9, 7, 4, 2, 1].map(h => err(h, "Microsoft-Windows-DNS-Client", 1014, "Name resolution for the name sync.clinic.example timed out after none of the configured DNS servers responded.", "minor", "System", "warning"));
    case "update_failure":
      return [50, 26].map(h => err(h, "Microsoft-Windows-WindowsUpdateClient", 20, "Installation Failure: Windows failed to install the following update with error 0x80070643: 2026-10 Cumulative Update (KB5050011)."));
    case "unknown_errors":
      return [
        ...[20, 8, 2].map(h => err(h, "Application Error", 1000, "Faulting application name: CabinetUI.exe, version: 7.2.1.0, faulting module name: ucrtbase.dll, exception code: 0xc0000409", "minor", "Application")),
        ...[5, 1].map(h => err(h, "MedSyncAgent", 3001, "Sync batch 4471 could not be uploaded: the remote host closed the connection.", "minor", "Application")),
      ];
    case "incident_crash":
    case "incident_loop": {
      const first = t0 + n * 3 * min;
      return [
        ...(harborStorageErrors(n) ? [errAt(t0 - 3 * 3_600_000, "disk", 153, "The IO operation at logical block address 0x2f1a0 for Disk 0 was retried.", "minor", "warning")] : []),
        ...update(), ...driver(), ...restart(), ...crashAt(first),
        ...(scenario === "incident_loop" ? [...crashAt(first + 9 * min), ...crashAt(first + 18 * min)]
          : [change(first + 2 * min, "Microsoft-Windows-Kernel-General", 12, "The operating system started.")]),
      ];
    }
    case "incident_ok":
      // One of them got the driver too and did not crash: the comparison shows it.
      return [...update(), ...(harborDriverWithoutCrash(n) ? driver() : []), ...restart()];
    case "healthy":
      return update();
    case "usb_missing":
      return [...update(), { eventId: randomUUID(), kind: "scanner", occurredAt: at(3), severityHint: "minor",
        device: { hardwareIds: ["USB\\VID_1234&PID_5678"], deviceInstanceId: "USB\\VID_1234&PID_5678\\6&2A1B3C4D&0&2", name: "Fingerprint Reader", state: "disconnected" },
        detail: { message: "No USB device detected on any of this cabinet's 3 USB ports; the fingerprint scanner is expected on Port_#0002.Hub_#0003.",
          fields: { usbPorts: "3", usbDevicesDetected: "0", expectedPort: "Port_#0002.Hub_#0003" } } },
        err(3, "Microsoft-Windows-USB-USBHUB3", 43, "The USB hub on Port_#0002.Hub_#0003 reports that no device is attached; the last device on it was removed 3 hours ago.", "minor", "System", "warning"),
        err(3.1, "Microsoft-Windows-Kernel-PnP", 411, "The device USB\\VID_1234&PID_5678\\6&2A1B3C4D&0&2 (Fingerprint Reader) was removed and has not come back.", "minor", "System", "warning")];
    case "disk_space_low":
      return [...update(), ...[30, 12, 2].map(h => err(h, "srv", 2013, "The C: disk is at or near capacity. You may need to delete some files.", "minor", "System", "error"))];
    case "mixed_errors":
      return [...update(),
        ...[9, 4, 1].map(h => err(h, "Microsoft-Windows-DNS-Client", 1014, "Name resolution for the name sync.clinic.example timed out after none of the configured DNS servers responded.", "minor", "System", "error")),
        ...[26, 3].map(h => err(h, "disk", 153, "The IO operation at logical block address 0x1d2f3 for Disk 0 was retried.", "minor", "System", "warning")),
        err(20, "Microsoft-Windows-WindowsUpdateClient", 20, "Installation Failure: Windows failed to install the following update with error 0x80070643: 2026-10 Cumulative Update (KB5050011)."),
        ...[7, 2].map(h => err(h, "BillingExport", 4012, "The nightly export to the clearing house failed: the file C:\\Billing\\out\\batch-0412.csv is locked by another process.", "minor", "Application")),
        err(5, "Application Error", 1000, "Faulting application name: StatementViewer.exe, version: 3.8.0.0, faulting module name: ucrtbase.dll, exception code: 0xc0000409", "minor", "Application")];
    case "scanner_errors":
      return [...update(),
        ...[11, 6, 2].map(h => err(h, "Microsoft-Windows-Biometrics", 1008, "The Windows Biometric Service could not start the biometric unit for Fingerprint Reader (USB\\VID_1234&PID_5678): the sensor did not respond.", "minor", "System", "error")),
        err(5.9, "WUDFHost", 10110, "The driver for device USB\\VID_1234&PID_5678\\6&2A1B3C4D&0&2 (Fingerprint Reader) failed to load and was stopped.", "minor", "System", "error")];
    case "net_dns_wrong": case "net_static_wrong": case "net_dhcp_failed": case "net_gateway_wrong": case "net_link_slow": case "net_flaky":
      // Network faults leave the cabinet otherwise ordinary: it got the same Windows update as everyone.
      return update();
    default:
      return [];
  }
}

/** Adds the simulated fleet. Idempotent: does nothing if it is already there. */
export async function enableDemo(pool: Pool, userId: string): Promise<void> {
  const cabinets: { id: string; scenario: Scenario }[] = [];
  const netAlerts: { id: string; problems: string[] }[] = [];
  await transaction(pool, async c => {
    // A deadlock victim runs this function again: start from nothing.
    cabinets.length = 0; netAlerts.length = 0;
    await upsertSetting(c, SETTING, "true", userId);
    if ((await c.query("SELECT TOP (1) 1 AS x FROM clients WHERE demo = 1")).rows[0]) return;
    const clientRows: unknown[][] = [], siteRows: unknown[][] = [], cabinetRows: unknown[][] = [];
    let siteIndex = 0;
    for (const client of DEMO_FLEET) {
      const clientId = randomUUID();
      clientRows.push([clientId, client.name, ["BioScanSvc"], [1433]]);
      for (const site of client.sites) {
        const siteId = randomUUID();
        const baseline = baselineFor(site.subnet, site.addressing);
        siteRows.push([siteId, clientId, site.name, `${site.subnet}.20`, site.timeZone, safeJson(baseline)]);
        for (const [i, k] of site.cabinets.entries()) {
          const id = randomUUID();
          cabinets.push({ id, scenario: k.scenario });
          const net = initialNet(k.scenario, baseline, site.subnet, i);
          const problems = netProblems(net, baseline);
          if (problems.length > 0) netAlerts.push({ id, problems });
          cabinetRows.push([id, siteId, k.name, k.role, hostnameFor(siteIndex, i, k.role), `5CG${siteIndex}${i}DEMO${i}`, AGENT_VERSION, 86_400 * (2 + i), k.scenario,
            safeJson(k.scenario === "firewall_drift" ? { domain: true, private: true, public: true } : ALL_OFF),
            k.scenario === "time_zone_wrong" ? wrongZoneFor(site.timeZone) : site.timeZone, k.scenario === "clock_drift" ? DRIFT_SECONDS : 0.3, safeJson(net), net.address]);
        }
        siteIndex++;
      }
    }
    // The whole fleet in a few statements (all 121 cabinets in one).
    await insertMany(c, "clients", ["id", "name", "watched_services", "sync_ports"], clientRows, [["demo", "1"]]);
    await insertMany(c, "sites", ["id", "client_id", "name", "sync_address", "time_zone", "network_baseline"], siteRows);
    await insertMany(c, "cabinets", ["id", "site_id", "name", "role", "hostname", "serial_number", "agent_version", "uptime_seconds", "demo_scenario", "firewall_profiles",
      "time_zone_id", "clock_skew_seconds", "demo_net", "ipv4"], cabinetRows, [["status", "'active'"], ["read_only", "0"], ["ipv4_at", "SYSUTCDATETIME()"]]);
    await audit(c, { actorKind: "user", actorId: userId, action: "demo.enable", outcome: "succeeded", details: { cabinets: cabinets.length } });
  });
  // Through the real paths, outside the transaction (as an agent's requests would be): heartbeats, then the events.
  const now = Date.now();
  let n = 0, outageIndex = 0;
  for (const k of cabinets) {
    const index = k.scenario.startsWith("incident_") ? n++ : 0;
    if (k.scenario === "offline") {
      await pool.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(day, -6, SYSUTCDATETIME()) WHERE id = $1", [k.id]);
      continue;
    }
    if (k.scenario === "site_outage") {
      // Heard from normally until the site's network went down; all of them within the same minute.
      await heartbeat(pool, k.id);
      await pool.query("UPDATE cabinets SET last_heartbeat_at = DATEADD(second, $3, DATEADD(minute, -$2, SYSUTCDATETIME())) WHERE id = $1",
        [k.id, OUTAGE_MINUTES_AGO, (outageIndex++) * 20]);
      continue;
    }
    if (k.scenario !== "incident_loop") {
      await heartbeat(pool, k.id);
      await evaluateDrift(pool, { cabinetId: k.id });
      await evaluateTime(pool, { cabinetId: k.id });
    }
    const events = scenarioEvents(k.scenario, now, index);
    if (events.length > 0) await storeEvents(pool, k.id, { events: events as [Event, ...Event[]] });
    if (k.scenario === "incident_loop") {
      // It kept crashing and starting again, then went quiet: last heard a few minutes after its last start.
      const first = now - INCIDENT_HOURS_AGO * 3_600_000 + index * 3 * 60_000;
      for (const m of [2, 11, 20]) await recordBoot(pool, k.id, new Date(first + m * 60_000), "heartbeat");
      await pool.query("UPDATE cabinets SET last_heartbeat_at = $2, uptime_seconds = 160 WHERE id = $1", [k.id, new Date(first + 23 * 60_000)]);
    }
  }
  await seedHistory(pool, userId);
  await seedSubmittedFix(pool);
  await seedDemoTroubleshooting(pool, userId);
  // What the platform's regular check of each cabinet against its site's baseline would have found.
  for (const a of netAlerts) await raiseBaselineAlert(pool, a.id, a.problems);
  await checkOffline(pool);
  await checkQuietLoops(pool);
  await checkSiteOutages(pool);
}

/** One fix a Tier 1 teammate has already submitted for the fingerprint scanner issue, waiting for an Admin. */
async function seedSubmittedFix(pool: Pool): Promise<void> {
  const from = (await pool.query<{ id: string }>("SELECT TOP (1) id FROM cabinets WHERE demo_scenario = 'scanner_flapping'")).rows[0];
  if (!from) return;
  const id = randomUUID();
  await pool.query("IF NOT EXISTS (SELECT 1 FROM users WHERE username = $2) INSERT INTO users (id, username, name, role, password_hash, status) VALUES ($1, $2, 'Priya Nair (demo)', 'tier1', 'x', 'active')", [id, DEMO_MEMBER]);
  const member = (await pool.query<{ id: string }>("SELECT id FROM users WHERE username = $1", [DEMO_MEMBER])).rows[0]!;
  await saveKnownFix(pool, { userId: member.id, canApproveFixes: false }, { title: "Reader drops after a driver install", cabinetId: from.id,
    symptom: { kind: "issue", issueTypeId: ISSUE.scanner },
    solution: "Rolled the reader's driver back to the previous version from Devices and drivers, unplugged it for ten seconds and plugged it into a rear port. It has stayed connected since. Check the date of the last driver install before replacing anything." });
}

/** Deletes every simulated record. Real cabinets, users and the audit log are untouched (the audit log keeps who did it). */
export async function disableDemo(pool: Pool, userId: string): Promise<number> {
  return transaction(pool, async c => {
    // A real cabinet filed under a simulated client (refused since, but possible in older data) is never deleted with it.
    const real = (await c.query<{ name: string }>(
      "SELECT TOP (1) k.name FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients n ON n.id = s.client_id WHERE n.demo = 1 AND k.demo_scenario IS NULL")).rows[0];
    if (real) throw new Refused("real_cabinet_in_demo_client", 409, `the real cabinet ${real.name} is filed under a simulated client; move it before turning demo mode off`);
    const ids = (await c.query<{ id: string }>("SELECT id FROM cabinets WHERE demo_scenario IS NOT NULL")).rows.map(r => r.id);
    // Fleet jobs on simulated cabinets go first (they point at their commands); a job left with no cabinet goes too.
    await c.query("DELETE FROM fleet_job_targets WHERE cabinet_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1))", [ids]);
    await c.query("DELETE FROM fleet_jobs WHERE NOT EXISTS (SELECT 1 FROM fleet_job_targets t WHERE t.job_id = fleet_jobs.id)");
    for (const table of ["known_fixes", "firewall_changes", "events", "alerts", "diagnoses", "commands", "cabinet_boots"])
      await c.query(`DELETE FROM ${table} WHERE cabinet_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1))`, [ids]);
    // Security alerts are never deleted (the app cannot); one about a simulated cabinet keeps its record without the link.
    // Upgrade rollouts never include simulated cabinets (rollouts.ts), so there are no rollout targets to remove.
    await c.query("UPDATE security_alerts SET cabinet_id = NULL WHERE cabinet_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1))", [ids]);
    // A rule mapped during the guided demo is switched off (rules and their history are never deleted), so the next run starts unmapped.
    await c.query("UPDATE symptom_rules SET state = 'disabled', updated_at = SYSUTCDATETIME() WHERE built_in = 0 AND state IN ('live', 'proposed') AND JSON_VALUE([match], '$.source') IN (SELECT value FROM OPENJSON($1))", [DEMO_ERROR_SOURCES]);
    await c.query("DELETE FROM known_fixes WHERE created_by IN (SELECT id FROM users WHERE username = $1)", [DEMO_MEMBER]);
    await c.query("DELETE FROM users WHERE username = $1", [DEMO_MEMBER]);
    // Site and cabinet checks people ran (the guided demo runs one on Midtown) point at the demo sites.
    await c.query(`DELETE FROM diagnosis_batches WHERE site_id IN (SELECT s.id FROM sites s JOIN clients n ON n.id = s.client_id WHERE n.demo = 1)
                  OR EXISTS (SELECT 1 FROM OPENJSON(diagnosis_batches.cabinet_ids) b JOIN OPENJSON($1) x ON x.value = b.value)`, [ids]);
    await c.query("DELETE FROM cabinets WHERE id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1))", [ids]);
    await c.query("DELETE FROM error_daily WHERE client_id IN (SELECT id FROM clients WHERE demo = 1); DELETE FROM issue_daily WHERE client_id IN (SELECT id FROM clients WHERE demo = 1)");
    await c.query("DELETE FROM sites WHERE client_id IN (SELECT id FROM clients WHERE demo = 1)");
    await c.query("DELETE FROM clients WHERE demo = 1");
    await upsertSetting(c, SETTING, "false", userId);
    await audit(c, { actorKind: "user", actorId: userId, action: "demo.disable", outcome: "succeeded", details: { cabinets: ids.length } });
    return ids.length;
  });
}

/** A day of load samples for every simulated cabinet that is heard from, and the last stored reads of the ones that are not (what "last known" shows). */
async function seedHistory(pool: Pool, userId: string): Promise<void> {
  const rows = (await pool.query<{ id: string; scenario: string; offline: boolean }>(
    "SELECT id, demo_scenario AS scenario, CAST(CASE WHEN demo_scenario IN (SELECT value FROM OPENJSON($1)) THEN 1 ELSE 0 END AS bit) AS offline FROM cabinets WHERE demo_scenario IS NOT NULL", [["offline", "site_outage", "incident_loop"]])).rows;
  // Every 10 minutes of the last day, for each cabinet that is heard from: a few thousand rows in a few statements.
  const samples: { k: string; t: string; c: number; m: number; d: number }[] = [];
  for (const k of rows.filter(r => !r.offline)) {
    for (let t = Date.now() - 24 * 3_600_000; t < Date.now(); t += 10 * 60_000) {
      const h = demoHealth(k.id, k.scenario, t);
      samples.push({ k: k.id, t: new Date(t).toISOString(), c: h.cpuPercent, m: h.memoryUsedPercent, d: h.diskFreePercent });
    }
  }
  // One JSON document, read by the server as rows (a few thousand rows do not fit in a parameter list).
  if (samples.length > 0)
    await pool.query(`INSERT INTO health_samples (cabinet_id, [at], cpu_percent, memory_used_percent, disk_free_percent)
                      SELECT j.k, j.t, j.c, j.m, j.d FROM OPENJSON($1) WITH (k uniqueidentifier, t datetime2(3), c smallint, m smallint, d smallint) j`, [samples]);
  // A month of daily drive reports. Most drives are fine; three show the trends the platform exists to catch early.
  // (The number list is written by this code, not taken from input.)
  const days = Array.from({ length: 30 }, (_, d) => `(${d})`).join(", ");
  await pool.query(
    `DECLARE @now datetime2(3) = SYSUTCDATETIME();
     INSERT INTO drive_samples (cabinet_id, drive_key, [at], model, serial_number, health, predict_failure, temperature_c, power_on_hours, reallocated, pending, uncorrectable, wear_percent)
     SELECT k.id, CONCAT('DEMO', UPPER(LEFT(REPLACE(CONVERT(nvarchar(36), k.id), '-', ''), 8))), DATEADD(day, -g.d, @now), 'Samsung SSD 870 EVO 500GB', CONCAT('DEMO', UPPER(LEFT(REPLACE(CONVERT(nvarchar(36), k.id), '-', ''), 8))),
            'healthy', 0,
            CASE k.name WHEN 'ICU' THEN 40 + CAST(ROUND((29 - g.d) * 0.41, 0) AS int) ELSE 34 + ((CHECKSUM(k.id) & 0x7FFFFFFF) % 8) END,
            9000 + (29 - g.d) * 24,
            CASE k.name WHEN 'Surgery' THEN CASE WHEN g.d > 20 THEN 0 ELSE (21 - g.d) * 2 END ELSE 0 END, 0, 0,
            CASE k.name WHEN 'Lab' THEN 70 + CAST(ROUND((29 - g.d) * 0.25, 0) AS int) ELSE 6 + (CHECKSUM(k.id) & 0x7FFFFFFF) % 5 END
       FROM cabinets k CROSS JOIN (VALUES ${days}) g(d)
      WHERE k.demo_scenario IS NOT NULL AND k.demo_scenario NOT IN (SELECT value FROM OPENJSON($1))`, [["offline", "site_outage", "incident_loop"]]);
  for (const r of (await pool.query<{ cabinet_id: string; drive_key: string }>("SELECT DISTINCT cabinet_id, drive_key FROM drive_samples")).rows) await refreshDrive(pool, r.cabinet_id, r.drive_key);
  const stored: unknown[][] = [];
  // Offline cabinets keep their last readings (shown while they are away); every other cabinet has its installed software read once, so a
  // fleet search for the scanner software finds the whole demo fleet instead of a handful.
  for (const k of rows) {
    const ctx = await context(pool, k.id);
    if (!ctx) continue;
    for (const operation of k.offline ? ["system.security", "software.list", "startup.list", "power.status", "shares.list"] : ["software.list"]) {
      const output = demoOutput(operation, {}, ctx);
      const at = new Date(Date.now() - (k.scenario === "offline" ? 6 * 86_400_000 : 3_600_000));
      const commandId = randomUUID();
      stored.push([commandId, k.id, operation, "{}", userId, at, new Date(at.getTime() + 300_000), "succeeded", at,
        safeJson({ commandId, status: "succeeded", startedAt: iso(at.getTime()), finishedAt: iso(at.getTime()), output }), at]);
    }
  }
  await insertMany(pool, "commands", ["id", "cabinet_id", "operation", "params", "issued_by", "issued_at", "expires_at", "status", "delivered_at", "result", "result_at"], stored);
}

async function profilesOf(pool: Pool, cabinetId: string): Promise<Profiles> {
  return (await pool.query<{ firewall_profiles: Profiles | null }>("SELECT firewall_profiles FROM cabinets WHERE id = $1", [cabinetId])).rows[0]?.firewall_profiles ?? ALL_OFF;
}

/** A believable load for a simulated cabinet: a slow daily swing around a level of its own, a little noise, and a leak for the cabinet whose scanner service keeps failing. */
function demoHealth(cabinetId: string, scenario: string, at = Date.now()): { cpuPercent: number; memoryUsedPercent: number; diskFreePercent: number } {
  const seed = parseInt(cabinetId.slice(0, 8), 16);
  const hours = at / 3_600_000;
  const swing = Math.sin(hours / 24 * 2 * Math.PI + (seed % 7));
  const cpu = 18 + (seed % 17) + 12 * swing + ((Math.floor(at / 300_000) * 7 + seed) % 9);
  const leak = scenario === "scanner_flapping" ? Math.min(40, ((at / 3_600_000) % 24) * 1.7) : 0;
  return { cpuPercent: Math.round(Math.min(100, Math.max(2, cpu))), memoryUsedPercent: Math.round(Math.min(97, 42 + (seed % 15) + 4 * swing + leak)), diskFreePercent: 22 + (seed % 41) };
}

async function heartbeat(pool: Pool, cabinetId: string, profiles?: Profiles): Promise<void> {
  // The simulated cabinet's zone and clock offset live in its own row, as a real agent's would on the cabinet.
  const r = (await pool.query<{ uptime: string | number; zone: string | null; skew: number | null; scenario: string | null }>(
    "SELECT uptime_seconds AS uptime, time_zone_id AS zone, clock_skew_seconds AS skew, demo_scenario AS scenario FROM cabinets WHERE id = $1", [cabinetId])).rows[0];
  const { firewallChanged, timeCheck } = await recordHeartbeat(pool, cabinetId, { agentVersion: AGENT_VERSION, uptimeSeconds: Number(r?.uptime ?? 0) + 60,
    readOnlyMode: false, firewallProfiles: profiles ?? await profilesOf(pool, cabinetId), health: demoHealth(cabinetId, r?.scenario ?? "healthy"),
    ...(r?.zone ? { timeZoneId: r.zone } : {}), ...(r?.skew !== null && r?.skew !== undefined ? { clockSkewSeconds: r.skew } : {}) });
  if (firewallChanged) await evaluateDrift(pool, { cabinetId });
  if (timeCheck) await evaluateTime(pool, { cabinetId });
}

async function context(pool: Pool, cabinetId: string): Promise<DemoContext | null> {
  const k = (await pool.query<{ hostname: string; role: string; scenario: Scenario; sync_address: string | null; firewall_profiles: Profiles | null; watched_services: string[] | null; sync_blocked: boolean; pos: number;
                               zone: string | null; skew: number | null; demo_net: DemoNet | null; network_baseline: NetworkBaseline | null }>(
    `SELECT k.hostname, k.role, k.demo_scenario AS scenario, s.sync_address, k.firewall_profiles, k.time_zone_id AS zone, k.clock_skew_seconds AS skew, k.demo_net, s.network_baseline,
            COALESCE(k.watched_services, s.watched_services, c.watched_services) AS watched_services,
            CAST(CASE WHEN k.role <> 'sync' AND EXISTS (SELECT 1 FROM cabinets y WHERE y.site_id = k.site_id AND y.role = 'sync' AND y.id <> k.id
              AND (JSON_VALUE(y.firewall_profiles, '$.domain') = 'true' OR JSON_VALUE(y.firewall_profiles, '$.private') = 'true' OR JSON_VALUE(y.firewall_profiles, '$.public') = 'true')) THEN 1 ELSE 0 END AS bit) AS sync_blocked,
            (SELECT count(*) FROM cabinets o WHERE o.site_id = k.site_id AND o.name < k.name) AS pos
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id WHERE k.id = $1 AND k.demo_scenario IS NOT NULL`, [cabinetId])).rows[0];
  if (!k) return null;
  // The message is read with OPENJSON: JSON_VALUE would drop a text longer than 4000 characters.
  const events = (await pool.query<{ log: string; src: string; event_id: number; level: string; occurred_at: Date; message: string; record_id: string | number }>(
    `SELECT TOP (200) JSON_VALUE(e.[source], '$.log') AS [log], JSON_VALUE(e.[source], '$.source') AS src, CAST(JSON_VALUE(e.[source], '$.eventId') AS int) AS event_id,
            JSON_VALUE(e.[source], '$.level') AS [level], e.occurred_at, COALESCE(d.[message], '') AS [message], CAST(JSON_VALUE(e.[source], '$.recordId') AS bigint) AS record_id
       FROM events e OUTER APPLY OPENJSON(e.detail) WITH ([message] nvarchar(max) '$.message') d
      WHERE e.cabinet_id = $1 AND e.kind IN ('error', 'change') AND e.[source] IS NOT NULL ORDER BY e.occurred_at DESC`, [cabinetId])).rows;
  // Start types changed from the console are kept with the simulated cabinet, so the next read shows them.
  const startTypes: Record<string, string> = {};
  for (const r of (await pool.query<{ key: string; value: unknown }>("SELECT [key], [value] FROM settings WHERE [key] LIKE $1", [`demo.starttype:${cabinetId}:%`])).rows)
    startTypes[r.key.slice(`demo.starttype:${cabinetId}:`.length)] = String(r.value);
  const power: Record<string, boolean> = {};
  for (const r of (await pool.query<{ key: string; value: unknown }>("SELECT [key], [value] FROM settings WHERE [key] LIKE $1", [`demo.power:${cabinetId}:%`])).rows)
    power[r.key.slice(`demo.power:${cabinetId}:`.length)] = r.value === true;
  const drawerValue = (await pool.query<{ value: unknown }>("SELECT [value] FROM settings WHERE [key] = $1", [`demo.drawer:${cabinetId}`])).rows[0]?.value;
  const drawer = drawerValue === undefined || drawerValue === null ? null : String(drawerValue);
  const subnet = (k.sync_address ?? "10.0.0.20").split(".").slice(0, 3).join(".");
  return { hostname: k.hostname, role: k.role, scenario: k.scenario, subnet,
    index: Number(k.pos), firewallProfiles: k.firewall_profiles ?? ALL_OFF, watchedServices: k.watched_services ?? [], startTypes, power, drawer, syncBlocked: k.sync_blocked, now: new Date(),
    timeZoneId: k.zone ?? "Eastern Standard Time", clockSkewSeconds: k.skew ?? 0,
    baseline: k.network_baseline ?? baselineFor(subnet), net: k.demo_net ?? initialNet(k.scenario, k.network_baseline ?? baselineFor(subnet), subnet, Number(k.pos)),
    events: events.map(e => ({ log: e.log, source: e.src, eventId: e.event_id, level: e.level, occurredAt: iso(e.occurred_at.getTime()), message: e.message, recordId: Number(e.record_id) })) };
}

/** Answers one command the way a real cabinet would, then lets the fix take effect (a firewall change, a service started). */
export async function answer(pool: Pool, cabinetId: string, command: { commandId: string; operation: string; params: Record<string, unknown> }): Promise<void> {
  const ctx = await context(pool, cabinetId);
  if (!ctx) return;
  const startedAt = iso(Date.now());
  let output: unknown;
  try { output = demoOutput(command.operation, command.params, ctx); }
  catch (e) { console.error(`demo answer for ${command.operation} failed: ${(e as Error).message}`); output = undefined; }
  const result = output === undefined
    ? { commandId: command.commandId, status: "failed" as const, startedAt, finishedAt: iso(Date.now()), error: { code: "unavailable" as never, message: "The simulated cabinet has no answer for this operation." } }
    : { commandId: command.commandId, status: "succeeded" as const, startedAt, finishedAt: iso(Date.now()), output };
  await storeResult(pool, cabinetId, result as never);
  if (result.status !== "succeeded") return;
  // The change takes effect: the next heartbeat reports the new firewall profiles, a started service recovers.
  if (command.operation === "firewall.applyPolicy" || command.operation === "firewall.setProfile") {
    const after = (output as { after: { profile: keyof Profiles; enabled: boolean } | { profile: keyof Profiles; enabled: boolean }[] }).after;
    const profiles = { ...ctx.firewallProfiles };
    for (const p of Array.isArray(after) ? after : [after]) profiles[p.profile] = p.enabled;
    await pool.query("UPDATE cabinets SET demo_scenario = CASE WHEN demo_scenario = 'firewall_drift' AND JSON_VALUE($2, '$.public') = 'false' THEN 'healthy' ELSE demo_scenario END WHERE id = $1",
      [cabinetId, safeJson(profiles)]);
    await heartbeat(pool, cabinetId, profiles);
  }
  // A network change is kept on the simulated cabinet, so the next check (and the read-back that verifies a fix) sees it.
  // A fixed address in the drawer network is the drawer link's: kept on its own, and the cabinet's main adapter is left as it was.
  const drawerAddress = command.operation === "network.setIp" && command.params.mode === "static" && String(command.params.address).startsWith("172.20.1.") ? String(command.params.address) : null;
  if (drawerAddress) {
    await upsertSetting(pool, `demo.drawer:${cabinetId}`, safeJson(drawerAddress));
  } else if (command.operation === "network.setIp" || command.operation === "network.setDns") {
    const p = command.params as never;
    const next = command.operation === "network.setIp" ? applySetIp(ctx.net, ctx.baseline, ctx.subnet, ctx.index, p) : applySetDns(ctx.net, ctx.baseline, p);
    const fixed = NET_SCENARIOS.includes(ctx.scenario) && ctx.scenario !== "net_link_slow" && netProblems(next, ctx.baseline).length === 0;
    await pool.query("UPDATE cabinets SET demo_net = $2, demo_scenario = CASE WHEN $3 = 1 THEN 'healthy' ELSE demo_scenario END WHERE id = $1", [cabinetId, safeJson(next), fixed]);
  }
  if (command.operation === "network.renewLease" && (output as { result: string }).result === "renewed") {
    const after = (output as { addressAfter: string }).addressAfter;
    const next = { ...ctx.net, address: after, prefixLength: ctx.baseline.prefixLength, gateway: ctx.baseline.gateway, dns: ctx.net.dnsAutomatic ? [...ctx.baseline.dnsServers] : ctx.net.dns };
    const fixed = NET_SCENARIOS.includes(ctx.scenario) && ctx.scenario !== "net_link_slow" && netProblems(next, ctx.baseline).length === 0;
    await pool.query("UPDATE cabinets SET demo_net = $2, demo_scenario = CASE WHEN $3 = 1 THEN 'healthy' ELSE demo_scenario END WHERE id = $1", [cabinetId, safeJson(next), fixed]);
  }
  if (command.operation === "service.setStartType") {
    await upsertSetting(pool, `demo.starttype:${cabinetId}:${String(command.params.name).toLowerCase()}`, safeJson(String((output as { after: string }).after)));
  }
  // A corrected zone or synced clock shows in the next heartbeat, and its alert closes.
  if (command.operation === "time.setZone") {
    await pool.query("UPDATE cabinets SET time_zone_id = $2, demo_scenario = CASE WHEN demo_scenario = 'time_zone_wrong' THEN 'healthy' ELSE demo_scenario END WHERE id = $1",
      [cabinetId, (output as { after: string }).after]);
    await heartbeat(pool, cabinetId);
    await evaluateTime(pool, { cabinetId });
  }
  if (command.operation === "time.sync" && (output as { result: string }).result === "synced") {
    await pool.query("UPDATE cabinets SET clock_skew_seconds = 0.4, demo_scenario = CASE WHEN demo_scenario = 'clock_drift' THEN 'healthy' ELSE demo_scenario END WHERE id = $1", [cabinetId]);
    await heartbeat(pool, cabinetId);
    await evaluateTime(pool, { cabinetId });
  }
  if (command.operation === "power.set") {
    await upsertSetting(pool, `demo.power:${cabinetId}:${String(command.params.setting)}`, safeJson(Boolean(command.params.enabled)));
  }
  if (command.operation === "service.control" && ctx.scenario === "service_failing" && String(command.params.name).toLowerCase() === "bioscansvc" && command.params.action !== "stop") {
    await pool.query("UPDATE cabinets SET demo_scenario = 'healthy' WHERE id = $1", [cabinetId]);
    await storeEvents(pool, cabinetId, { events: [{ eventId: randomUUID(), kind: "service", occurredAt: iso(Date.now()), severityHint: "minor",
      detail: { message: "BioScanSvc is running again.", fields: { service: "BioScanSvc", change: "recovered", restartsToday: "3" } } }] });
  }
}

/** Runs while the server runs: delivers commands to simulated cabinets and keeps their heartbeats coming. */
export class DemoSimulator {
  private timer: NodeJS.Timeout | null = null;
  private lastHeartbeat = 0;
  private busy = false;
  constructor(private readonly pool: Pool, private readonly log: (message: string) => void, private readonly tickMs = 1000, private readonly answerDelayMs: readonly [number, number] = [300, 1200]) {}

  start(): void {
    if (!examplesAvailable()) this.log("demo cabinets cannot answer: the contract examples are missing from this installation (deploy/Dockerfile must copy contracts/examples)");
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
  }
  private stopped = false;
  private readonly answers = new Set<NodeJS.Timeout>();
  /** Stops ticking and drops the answers still waiting to be sent; a tick already running ends quietly. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.answers) clearTimeout(t);
    this.answers.clear();
  }

  async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      if (!(await demoEnabled(this.pool))) return;
      const waiting = (await this.pool.query<{ id: string }>(
        `SELECT DISTINCT c.cabinet_id AS id FROM commands c JOIN cabinets k ON k.id = c.cabinet_id
          WHERE c.status = 'queued' AND k.demo_scenario IS NOT NULL AND k.demo_scenario NOT IN (SELECT value FROM OPENJSON($1))`, [LOOPING])).rows;
      for (const { id } of waiting)
        for (const command of await takeQueuedCommands(this.pool, id)) {
          const [min, max] = this.answerDelayMs;
          const t = setTimeout(() => { this.answers.delete(t); if (!this.stopped) answer(this.pool, id, command).catch(e => { if (!this.stopped) this.log(`demo answer failed: ${(e as Error).message}`); }); }, min + Math.random() * (max - min));
          this.answers.add(t);
        }
      if (Date.now() - this.lastHeartbeat >= 60_000) {
        this.lastHeartbeat = Date.now();
        for (const { id } of (await this.pool.query<{ id: string }>("SELECT id FROM cabinets WHERE demo_scenario IS NOT NULL AND demo_scenario NOT IN (SELECT value FROM OPENJSON($1))", [LOOPING])).rows) {
          // One cabinet's heartbeat can lose a deadlock to a person's action on it; it is tried again once, and never stops the others.
          try { await heartbeat(this.pool, id); }
          catch (e) { if (isDeadlock(e)) await heartbeat(this.pool, id).catch(e2 => this.log(`demo heartbeat failed: ${(e2 as Error).message}`)); else this.log(`demo heartbeat failed: ${(e as Error).message}`); }
        }
      }
    } catch (e) {
      if (!this.stopped) this.log(`demo tick failed: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
