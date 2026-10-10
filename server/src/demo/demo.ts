// Demo mode (docs/platform/demo.md). An Admin turns it on to show the platform at fleet scale next to the real cabinets:
// simulated clients, sites and cabinets, each with one problem to find. Everything they produce goes through the same
// server code as a real agent's (heartbeats, events and the alerts engine, command delivery, results checked against the
// output schema), so alerts, history and the audit log behave exactly as they would for real cabinets. Turning it off
// deletes every simulated record (security alerts stay, unlinked). Real cabinets are never touched: a simulated cabinet is one with a demo_scenario.
import { Refused } from "../services/errors.js";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { audit, safeJson, transaction } from "../db/db.js";
import { recordHeartbeat } from "../services/cabinets.js";
import { storeEvents } from "../services/events.js";
import { storeResult, takeQueuedCommands } from "../services/commands.js";
import { checkOffline } from "../services/alerts.js";
import { evaluateDrift } from "../services/firewall-policy.js";
import { checkQuietLoops, recordBoot } from "../services/crashes.js";
import type { Event } from "../contracts.js";
import { DEMO_FLEET, harborDriverWithoutCrash, harborStorageErrors, hostnameFor, type Scenario } from "./fleet.js";
import { demoOutput, type DemoContext } from "./outputs.js";

const SETTING = "demo.enabled";
const AGENT_VERSION = "1.4.2";
type Profiles = { domain: boolean; private: boolean; public: boolean };
const ALL_OFF: Profiles = { domain: false, private: false, public: false };

export async function demoEnabled(db: pg.Pool | pg.PoolClient): Promise<boolean> {
  return (await db.query<{ value: boolean }>("SELECT value FROM settings WHERE key = $1", [SETTING])).rows[0]?.value === true;
}

export async function demoStatus(pool: pg.Pool) {
  const n = (await pool.query<{ clients: string; cabinets: string }>(
    `SELECT (SELECT count(*) FROM clients WHERE demo) AS clients, (SELECT count(*) FROM cabinets WHERE demo_scenario IS NOT NULL) AS cabinets`)).rows[0]!;
  return { enabled: await demoEnabled(pool), clients: Number(n.clients), cabinets: Number(n.cabinets) };
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The overnight incident: when the first cabinet crashed, and what came before it. */
export const INCIDENT_HOURS_AGO = 20;
export const INCIDENT_UPDATE = "2026-10 Cumulative Update for Windows 10 Version 21H2 (KB5050011)";
export const INCIDENT_DRIVER = "iastorac.inf (Intel(R) Rapid Storage Technology 19.5.0.1037)";
const LOOPING: Scenario[] = ["offline", "incident_loop"];

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
    default:
      return [];
  }
}

/** Adds the simulated fleet. Idempotent: does nothing if it is already there. */
export async function enableDemo(pool: pg.Pool, userId: string): Promise<void> {
  const cabinets: { id: string; scenario: Scenario }[] = [];
  await transaction(pool, async c => {
    await c.query(`INSERT INTO settings (key, value, changed_by) VALUES ($1, 'true', $2)
                   ON CONFLICT (key) DO UPDATE SET value = 'true', changed_by = EXCLUDED.changed_by, changed_at = now()`, [SETTING, userId]);
    if ((await c.query("SELECT 1 FROM clients WHERE demo LIMIT 1")).rows[0]) return;
    let siteIndex = 0;
    for (const client of DEMO_FLEET) {
      const clientId = randomUUID();
      await c.query("INSERT INTO clients (id, name, demo, watched_services, sync_ports) VALUES ($1, $2, true, $3, $4)", [clientId, client.name, ["BioScanSvc"], [1433]]);
      for (const site of client.sites) {
        const siteId = randomUUID();
        await c.query("INSERT INTO sites (id, client_id, name, sync_address) VALUES ($1, $2, $3, $4)", [siteId, clientId, site.name, `${site.subnet}.20`]);
        for (const [i, k] of site.cabinets.entries()) {
          const id = randomUUID();
          cabinets.push({ id, scenario: k.scenario });
          await c.query(`INSERT INTO cabinets (id, site_id, name, role, status, hostname, serial_number, read_only, agent_version, uptime_seconds, demo_scenario, firewall_profiles)
                         VALUES ($1, $2, $3, $4, 'active', $5, $6, false, $7, $8, $9, $10)`,
            [id, siteId, k.name, k.role, hostnameFor(siteIndex, i, k.role), `5CG${siteIndex}${i}DEMO${i}`, AGENT_VERSION, 86_400 * (2 + i), k.scenario,
             safeJson(k.scenario === "firewall_drift" ? { domain: true, private: true, public: true } : ALL_OFF)]);
        }
        siteIndex++;
      }
    }
    await audit(c, { actorKind: "user", actorId: userId, action: "demo.enable", outcome: "succeeded", details: { cabinets: cabinets.length } });
  });
  // Through the real paths, outside the transaction (as an agent's requests would be): heartbeats, then the events.
  const now = Date.now();
  let n = 0;
  for (const k of cabinets) {
    const index = k.scenario.startsWith("incident_") ? n++ : 0;
    if (k.scenario === "offline") {
      await pool.query("UPDATE cabinets SET last_heartbeat_at = now() - interval '6 days' WHERE id = $1", [k.id]);
      continue;
    }
    if (k.scenario !== "incident_loop") {
      await heartbeat(pool, k.id);
      await evaluateDrift(pool, { cabinetId: k.id });
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
  await checkOffline(pool);
  await checkQuietLoops(pool);
}

/** Deletes every simulated record. Real cabinets, users and the audit log are untouched (the audit log keeps who did it). */
export async function disableDemo(pool: pg.Pool, userId: string): Promise<number> {
  return transaction(pool, async c => {
    // A real cabinet filed under a simulated client (refused since, but possible in older data) is never deleted with it.
    const real = (await c.query<{ name: string }>(
      "SELECT k.name FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients n ON n.id = s.client_id WHERE n.demo AND k.demo_scenario IS NULL LIMIT 1")).rows[0];
    if (real) throw new Refused("real_cabinet_in_demo_client", 409, `the real cabinet ${real.name} is filed under a simulated client; move it before turning demo mode off`);
    const ids = (await c.query<{ id: string }>("SELECT id FROM cabinets WHERE demo_scenario IS NOT NULL")).rows.map(r => r.id);
    for (const table of ["firewall_changes", "events", "alerts", "diagnoses", "commands", "cabinet_boots"])
      await c.query(`DELETE FROM ${table} WHERE cabinet_id = ANY($1::uuid[])`, [ids]);
    // Security alerts are never deleted (the app cannot); one about a simulated cabinet keeps its record without the link.
    // Upgrade rollouts never include simulated cabinets (rollouts.ts), so there are no rollout targets to remove.
    await c.query("UPDATE security_alerts SET cabinet_id = NULL WHERE cabinet_id = ANY($1::uuid[])", [ids]);
    await c.query("DELETE FROM cabinets WHERE id = ANY($1::uuid[])", [ids]);
    await c.query("DELETE FROM sites WHERE client_id IN (SELECT id FROM clients WHERE demo)");
    await c.query("DELETE FROM clients WHERE demo");
    await c.query(`INSERT INTO settings (key, value, changed_by) VALUES ($1, 'false', $2)
                   ON CONFLICT (key) DO UPDATE SET value = 'false', changed_by = EXCLUDED.changed_by, changed_at = now()`, [SETTING, userId]);
    await audit(c, { actorKind: "user", actorId: userId, action: "demo.disable", outcome: "succeeded", details: { cabinets: ids.length } });
    return ids.length;
  });
}

async function profilesOf(pool: pg.Pool, cabinetId: string): Promise<Profiles> {
  return (await pool.query<{ p: Profiles | null }>("SELECT firewall_profiles AS p FROM cabinets WHERE id = $1", [cabinetId])).rows[0]?.p ?? ALL_OFF;
}

async function heartbeat(pool: pg.Pool, cabinetId: string, profiles?: Profiles): Promise<void> {
  const r = (await pool.query<{ uptime: string }>("SELECT uptime_seconds AS uptime FROM cabinets WHERE id = $1", [cabinetId])).rows[0];
  const { firewallChanged } = await recordHeartbeat(pool, cabinetId, { agentVersion: AGENT_VERSION, uptimeSeconds: Number(r?.uptime ?? 0) + 60,
    readOnlyMode: false, firewallProfiles: profiles ?? await profilesOf(pool, cabinetId) });
  if (firewallChanged) await evaluateDrift(pool, { cabinetId });
}

async function context(pool: pg.Pool, cabinetId: string): Promise<DemoContext | null> {
  const k = (await pool.query<{ hostname: string; role: string; scenario: Scenario; sync_address: string | null; profiles: Profiles | null; watched: string[] | null; sync_blocked: boolean; position: string }>(
    `SELECT k.hostname, k.role, k.demo_scenario AS scenario, s.sync_address, k.firewall_profiles AS profiles,
            COALESCE(k.watched_services, s.watched_services, c.watched_services) AS watched,
            k.role <> 'sync' AND EXISTS (SELECT 1 FROM cabinets y WHERE y.site_id = k.site_id AND y.role = 'sync' AND y.id <> k.id
              AND ((y.firewall_profiles->>'domain')::boolean OR (y.firewall_profiles->>'private')::boolean OR (y.firewall_profiles->>'public')::boolean)) AS sync_blocked,
            (SELECT count(*) FROM cabinets o WHERE o.site_id = k.site_id AND o.name < k.name) AS position
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id WHERE k.id = $1 AND k.demo_scenario IS NOT NULL`, [cabinetId])).rows[0];
  if (!k) return null;
  const events = (await pool.query<{ log: string; source: string; event_id: number; level: string; occurred_at: Date; message: string; record_id: number }>(
    `SELECT source->>'log' AS log, source->>'source' AS source, (source->>'eventId')::int AS event_id, source->>'level' AS level, occurred_at,
            COALESCE(detail->>'message', '') AS message, (source->>'recordId')::bigint AS record_id
       FROM events WHERE cabinet_id = $1 AND kind IN ('error', 'change') AND source IS NOT NULL ORDER BY occurred_at DESC LIMIT 200`, [cabinetId])).rows;
  return { hostname: k.hostname, role: k.role, scenario: k.scenario, subnet: (k.sync_address ?? "10.0.0.20").split(".").slice(0, 3).join("."),
    index: Number(k.position), firewallProfiles: k.profiles ?? ALL_OFF, watchedServices: k.watched ?? [], syncBlocked: k.sync_blocked, now: new Date(),
    events: events.map(e => ({ log: e.log, source: e.source, eventId: e.event_id, level: e.level, occurredAt: iso(e.occurred_at.getTime()), message: e.message, recordId: Number(e.record_id) })) };
}

/** Answers one command the way a real cabinet would, then lets the fix take effect (a firewall change, a service started). */
export async function answer(pool: pg.Pool, cabinetId: string, command: { commandId: string; operation: string; params: Record<string, unknown> }): Promise<void> {
  const ctx = await context(pool, cabinetId);
  if (!ctx) return;
  const startedAt = iso(Date.now());
  let output: unknown;
  try { output = demoOutput(command.operation, command.params, ctx); }
  catch { output = undefined; }
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
    await pool.query("UPDATE cabinets SET demo_scenario = CASE WHEN demo_scenario = 'firewall_drift' AND NOT ($2::jsonb->>'public')::boolean THEN 'healthy' ELSE demo_scenario END WHERE id = $1",
      [cabinetId, safeJson(profiles)]);
    await heartbeat(pool, cabinetId, profiles);
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
  constructor(private readonly pool: pg.Pool, private readonly log: (message: string) => void, private readonly tickMs = 1000, private readonly answerDelayMs: readonly [number, number] = [300, 1200]) {}

  start(): void { this.timer = setInterval(() => void this.tick(), this.tickMs); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!(await demoEnabled(this.pool))) return;
      const waiting = (await this.pool.query<{ id: string }>(
        `SELECT DISTINCT c.cabinet_id AS id FROM commands c JOIN cabinets k ON k.id = c.cabinet_id
          WHERE c.status = 'queued' AND k.demo_scenario IS NOT NULL AND NOT (k.demo_scenario = ANY($1::text[]))`, [LOOPING])).rows;
      for (const { id } of waiting)
        for (const command of await takeQueuedCommands(this.pool, id)) {
          const [min, max] = this.answerDelayMs;
          setTimeout(() => answer(this.pool, id, command).catch(e => this.log(`demo answer failed: ${(e as Error).message}`)), min + Math.random() * (max - min));
        }
      if (Date.now() - this.lastHeartbeat >= 60_000) {
        this.lastHeartbeat = Date.now();
        for (const { id } of (await this.pool.query<{ id: string }>("SELECT id FROM cabinets WHERE demo_scenario IS NOT NULL AND NOT (demo_scenario = ANY($1::text[]))", [LOOPING])).rows)
          await heartbeat(this.pool, id);
      }
    } catch (e) {
      this.log(`demo tick failed: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
