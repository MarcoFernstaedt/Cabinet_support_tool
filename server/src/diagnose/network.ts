// Diagnose network (Tier 1): one click runs the cabinet's network reads and tests, as the person who asked (each command is
// issued, checked and audited exactly as if they had clicked it), then reads the results with the fixed checks in
// network-findings.ts. The run is stored, so the next person sees what was found.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { FirewallStateOutput, NetworkConfigOutput, NetworkTestOutput, NetworkTraceOutput } from "@mashura/cabinet-contracts/types";
import type { Role } from "../services/console-commands.js";
import { safeJson } from "../db/db.js";
import { issueFromConsole } from "../services/console-commands.js";
import { cabinetPolicy, switchesFor } from "../services/firewall-policy.js";
import { syncForCabinet } from "../services/device-settings.js";
import { OFFLINE_AFTER_MS } from "../services/cabinets.js";
import { Refused } from "../services/errors.js";
import { fixesForFindings, markSeen } from "../services/known-fixes.js";
import { upsertAlert } from "../services/alerts.js";
import { ISSUE } from "../services/rules.js";
import { layerStates, networkFindings, type Finding, type FixAction, type NetworkBaseline, type NetworkEvidence, type Profiles, type TestRun } from "./network-findings.js";
import type { TraceRun } from "./network-observations.js";

/** How long the whole run may take; a cabinet answers reads in about a second. */
export const RUN_LIMIT_MS = 60_000;
const POLL_MS = 300;

interface Issued { key: string; label: string; operation: string; params: Record<string, unknown>; commandId: string }
type Outcome = { status: string; output?: unknown; failure?: string | undefined };

async function waitFor(pool: pg.Pool, ids: string[], deadline: number): Promise<Map<string, Outcome>> {
  const done = new Map<string, Outcome>();
  while (Date.now() < deadline) {
    const rows = (await pool.query<{ id: string; status: string; result: { output?: unknown; error?: { message: string } } | null }>(
      "SELECT id, status, result FROM commands WHERE id = ANY($1::uuid[]) AND status NOT IN ('queued', 'delivered')", [ids])).rows;
    for (const r of rows) done.set(r.id, { status: r.status, output: r.result?.output, failure: r.status === "succeeded" ? undefined : r.result?.error?.message ?? r.status });
    if (done.size === ids.length) break;
    await new Promise(res => setTimeout(res, POLL_MS));
  }
  return done;
}

const MAX_RUNNING_PER_USER = 3;

export async function startNetworkDiagnosis(pool: pg.Pool, user: { userId: string; role: Role }, cabinetId: string, log: (m: string) => void = () => {}): Promise<string> {
  const k = (await pool.query<{ name: string; role: string }>("SELECT name, role FROM cabinets WHERE id = $1 AND status = 'active'", [cabinetId])).rows[0];
  if (!k) throw new Refused("not_found", 404, "no such cabinet");
  // A diagnosis already running on this cabinet is shared rather than started twice; one person runs at most 3 at a time.
  const running = (await pool.query<{ id: string }>(
    "SELECT id FROM diagnoses WHERE cabinet_id = $1 AND kind = 'network' AND state = 'running' AND started_at > now() - make_interval(secs => $2) ORDER BY started_at DESC LIMIT 1",
    [cabinetId, RUN_LIMIT_MS / 1000 + 5])).rows[0];
  if (running) return running.id;
  const mine = Number((await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM diagnoses WHERE run_by = $1 AND state = 'running' AND started_at > now() - make_interval(secs => $2)",
    [user.userId, RUN_LIMIT_MS / 1000 + 5])).rows[0]!.n);
  if (mine >= MAX_RUNNING_PER_USER) throw new Refused("rate_limited", 429, `you already have ${MAX_RUNNING_PER_USER} diagnoses running; wait for one to finish`);
  const { id } = await beginDiagnosis(pool, user, cabinetId, k, null, log);
  return id;
}

/**
 * Creates the diagnosis row, issues its first reads (so a refusal reaches the person at once) and runs the rest in the
 * background. `done` settles when the run has finished; a batch waits on it to limit how many run at once.
 */
export async function beginDiagnosis(pool: pg.Pool, user: { userId: string; role: Role }, cabinetId: string, k: { name: string; role: string }, batchId: string | null,
  log: (m: string) => void): Promise<{ id: string; done: Promise<void> }> {
  const id = randomUUID();
  // The first two commands are issued before answering, so a refusal (role, write pause does not apply to reads) reaches the person.
  const issue = async (key: string, label: string, operation: string, params: Record<string, unknown>): Promise<Issued> =>
    ({ key, label, operation, params, commandId: (await issueFromConsole(pool, user, cabinetId, operation, params)).commandId });
  const first = [await issue("config", "Network settings", "network.config", {}), await issue("firewall", "Firewall", "firewall.state", {})];
  await pool.query("INSERT INTO diagnoses (id, cabinet_id, kind, run_by, state, commands, batch_id) VALUES ($1, $2, 'network', $3, 'running', $4, $5)",
    [id, cabinetId, user.userId, safeJson(first.map(c => ({ key: c.key, operation: c.operation, commandId: c.commandId }))), batchId]);
  const done = run(pool, user, cabinetId, { name: k.name, role: k.role }, id, first, issue).catch(async e => {
    log(`network diagnosis failed: ${(e as Error).message}`);
    await pool.query("UPDATE diagnoses SET state = 'failed', finished_at = now(), failure = $2 WHERE id = $1", [id, "The diagnosis stopped because of a server error. Run it again; if it repeats, the server log has the detail."]).catch(() => undefined);
  });
  return { id, done };
}

async function run(pool: pg.Pool, user: { userId: string; role: Role }, cabinetId: string, cabinet: { name: string; role: string }, id: string, first: Issued[],
  issue: (key: string, label: string, operation: string, params: Record<string, unknown>) => Promise<Issued>): Promise<void> {
  const deadline = Date.now() + RUN_LIMIT_MS;
  const firstDone = await waitFor(pool, [first[0]!.commandId], Math.min(deadline, Date.now() + 30_000));
  const config = firstDone.get(first[0]!.commandId);
  const configOut = config?.status === "succeeded" ? config.output as NetworkConfigOutput : undefined;

  // The tests: the gateway, each DNS server the connected adapters use, the platform server's name, and the site's sync cabinet.
  const connected = configOut?.adapters.filter(a => a.connected) ?? [];
  const dnsCount = Math.min(4, Math.max(1, ...connected.map(a => a.dns.servers.length)));
  const sync = await syncForCabinet(pool, cabinetId);
  const tests: Issued[] = [await issue("gateway", "Gateway (ping)", "network.test", { target: "gateway", method: "ping", count: 4 })];
  for (let i = 0; i < dnsCount; i++) tests.push(await issue(`dns-${i}`, `DNS server ${i + 1}`, "network.test", { target: "dns_server", method: "dns", dnsServerIndex: i }));
  tests.push(await issue("platform", "Platform server name", "network.test", { target: "platform_server", method: "dns" }));
  if (cabinet.role !== "sync" && sync?.address) {
    tests.push(await issue("sync-ping", "Sync cabinet (ping)", "network.test", { target: "sync_cabinet", method: "ping" }));
    for (const port of sync.effective.slice(0, 4))
      tests.push(await issue(`sync-tcp-${port}`, `Sync cabinet port ${port}`, "network.test", { target: "sync_cabinet", method: "tcp", port }));
  }
  // The routes to the sync cabinet and the platform server: where along the way replies stop or slow down.
  const traces: Issued[] = [await issue("trace-platform", "Path to the platform server", "network.trace", { target: "platform_server" })];
  if (cabinet.role !== "sync" && sync?.address) traces.push(await issue("trace-sync", "Path to the sync cabinet", "network.trace", { target: "sync_cabinet" }));
  const all = [...first, ...tests, ...traces];
  await pool.query("UPDATE diagnoses SET commands = $2 WHERE id = $1", [id, safeJson(all.map(c => ({ key: c.key, operation: c.operation, commandId: c.commandId })))]);
  const results = await waitFor(pool, all.map(c => c.commandId), deadline);
  const outcome = (c: Issued): Outcome => results.get(c.commandId) ?? { status: "no_answer", failure: "no answer within a minute" };
  const fw = outcome(first[1]!);

  // The site's sync cabinet as the platform knows it: whether it is checking in, and its firewall profiles.
  const sc = sync?.address ? (await pool.query<{ id: string; name: string; last: Date | null; profiles: Profiles | null }>(
    `SELECT k.id, k.name, k.last_heartbeat_at AS last, k.firewall_profiles AS profiles FROM cabinets k
      WHERE k.site_id = (SELECT site_id FROM cabinets WHERE id = $1) AND k.role = 'sync' AND k.status = 'active' AND k.id <> $1 ORDER BY k.name LIMIT 1`, [cabinetId])).rows[0] : undefined;
  const policy = switchesFor((await cabinetPolicy(pool, cabinetId)).policy);
  const baseline = (await pool.query<{ b: NetworkBaseline | null }>(
    "SELECT s.network_baseline AS b FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE k.id = $1", [cabinetId])).rows[0]?.b ?? null;
  const evidence: NetworkEvidence = {
    cabinet: { id: cabinetId, name: cabinet.name, role: cabinet.role }, baseline,
    ...(configOut ? { config: configOut } : { configFailure: config?.failure ?? "no answer" }),
    ...(fw.status === "succeeded" ? { firewall: fw.output as FirewallStateOutput } : { firewallFailure: fw.failure ?? "no answer" }),
    policy,
    sync: { address: sync?.address ?? null, ports: sync?.effective ?? [], cabinet: sc ? { id: sc.id, name: sc.name,
      online: !!sc.last && Date.now() - sc.last.getTime() < OFFLINE_AFTER_MS, minutesSilent: sc.last ? Math.round((Date.now() - sc.last.getTime()) / 60_000) : null, profiles: sc.profiles } : null },
    tests: tests.map((t): TestRun => {
      const o = outcome(t);
      return { key: t.key, label: t.label, params: t.params, ...(o.status === "succeeded" ? { output: o.output as NetworkTestOutput } : { failure: o.failure ?? o.status }) };
    }),
  };
  evidence.traces = traces.map((t): TraceRun => {
    const o = outcome(t);
    return { key: t.key, label: t.label, params: t.params, ...(o.status === "succeeded" ? { output: o.output as NetworkTraceOutput } : { failure: o.failure ?? o.status }) };
  });
  const findings = networkFindings(evidence);
  // Everything that was read, kept whether or not anything is wrong, so the console can show the full read.
  const readings = { takenAt: new Date().toISOString(), adapters: configOut?.adapters ?? [], routes: configOut?.routes ?? [], neighbors: configOut?.neighbors ?? [],
    tests: evidence.tests, traces: evidence.traces };
  await pool.query("UPDATE diagnoses SET state = 'done', finished_at = now(), findings = $2, readings = $3 WHERE id = $1", [id, safeJson(findings), safeJson(readings)]);
  await reconcileBaselineAlert(pool, cabinetId, findings, baseline !== null && configOut !== undefined);
  // A problem somebody has already solved here: count that the fix was shown again (the console shows it beside the finding).
  const seen = await fixesForFindings(pool, findings.filter(f => f.severity !== "ok").map(f => f.id));
  await markSeen(pool, [...new Set(Object.values(seen).flat().map(f => f.id))]);
}

/** The minor alert that says a cabinet differs from its site's baseline; the same alert is kept while it differs. */
export async function raiseBaselineAlert(db: pg.Pool, cabinetId: string, titles: string[]): Promise<void> {
  const issue = (await db.query<{ name: string; severity: string }>("SELECT name, severity FROM issue_types WHERE id = $1", [ISSUE.networkBaseline])).rows[0];
  if (issue) await upsertAlert(db, { cabinetId, issueTypeId: ISSUE.networkBaseline, severity: issue.severity, signature: `issue:${ISSUE.networkBaseline}`,
    title: `${issue.name}: ${titles.slice(0, 2).join("; ")}`.slice(0, 250), seenAt: new Date(), ruleId: null, eventId: null });
}

/**
 * A diagnosis that finds the cabinet's address, gateway or DNS different from the site baseline raises a minor alert, so the
 * cabinet shows in Alerts; a later diagnosis that finds it matching closes it. Only when the baseline was set and the settings were read.
 */
async function reconcileBaselineAlert(pool: pg.Pool, cabinetId: string, findings: Finding[], comparable: boolean): Promise<void> {
  if (!comparable) return;
  const off = findings.filter(f => f.id.startsWith("baseline-") && f.severity !== "ok");
  if (off.length > 0) {
    await raiseBaselineAlert(pool, cabinetId, off.map(f => f.title));
  } else {
    await pool.query(`UPDATE alerts SET state = 'resolved', resolved_at = now(), resolution = 'A network diagnosis found the settings matching the site baseline.'
                       WHERE cabinet_id = $1 AND issue_type_id = $2 AND state <> 'resolved'`, [cabinetId, ISSUE.networkBaseline]);
  }
}

export async function diagnosis(db: pg.Pool, id: string) {
  const r = (await db.query<{ id: string; cabinet_id: string; kind: string; state: string; started_at: Date; finished_at: Date | null; findings: unknown; failure: string | null; commands: unknown; readings: unknown; run_by: string }>(
    `SELECT d.id, d.cabinet_id, d.kind, d.state, d.started_at, d.finished_at, d.findings, d.failure, d.commands, d.readings, u.name AS run_by
       FROM diagnoses d JOIN users u ON u.id = d.run_by WHERE d.id = $1`, [id])).rows[0];
  if (!r) return null;
  const hasBaseline = (await db.query<{ b: boolean }>("SELECT s.network_baseline IS NOT NULL AS b FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE k.id = $1", [r.cabinet_id])).rows[0]?.b ?? false;
  return { id: r.id, cabinetId: r.cabinet_id, kind: r.kind, state: r.state, startedAt: r.started_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null,
    runBy: r.run_by, findings: r.findings, failure: r.failure, commands: r.commands, readings: r.readings, hasBaseline };
}

export async function latestDiagnosis(db: pg.Pool, cabinetId: string) {
  const id = (await db.query<{ id: string }>("SELECT id FROM diagnoses WHERE cabinet_id = $1 AND kind = 'network' ORDER BY started_at DESC LIMIT 1", [cabinetId])).rows[0]?.id;
  return id ? diagnosis(db, id) : null;
}


// ---- Many cabinets at once ------------------------------------------------------------------------------------------------

export const BATCH_LIMIT = 60;
const BATCH_CONCURRENCY = 8;

/** Starts the diagnosis on the chosen cabinets, or on every active cabinet of a site. Offline cabinets are listed, not waited for. */
export async function startNetworkBatch(pool: pg.Pool, user: { userId: string; role: Role }, selection: { cabinetIds: string[] } | { siteId: string },
  log: (m: string) => void = () => {}): Promise<{ batchId: string; total: number; offline: number }> {
  const rows = (await pool.query<{ id: string; name: string; role: string; site_id: string; site: string; online: boolean }>(
    `SELECT k.id, k.name, k.role, s.id AS site_id, s.name AS site, COALESCE(k.last_heartbeat_at > now() - make_interval(secs => $2), false) AS online
       FROM cabinets k JOIN sites s ON s.id = k.site_id
      WHERE k.status = 'active' AND ${"siteId" in selection ? "s.id = $1" : "k.id = ANY($1::uuid[])"} ORDER BY s.name, k.name`,
    ["siteId" in selection ? selection.siteId : selection.cabinetIds, OFFLINE_AFTER_MS / 1000])).rows;
  if (rows.length === 0) throw new Refused("not_found", 404, "no such active cabinets");
  if (rows.length > BATCH_LIMIT) throw new Refused("too_many_cabinets", 409, `a network diagnosis covers at most ${BATCH_LIMIT} cabinets at a time`);
  if ("cabinetIds" in selection && rows.length !== selection.cabinetIds.length) throw new Refused("not_found", 404, "one of the chosen cabinets does not exist or is not active");
  // A batch is running until every one of its cabinets has a finished diagnosis (or it is older than a run can last).
  const mine = Number((await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM diagnosis_batches b
      WHERE b.created_by = $1 AND b.created_at > now() - make_interval(secs => $2)
        AND (SELECT count(*) FROM diagnoses d WHERE d.batch_id = b.id AND d.state <> 'running') < b.total`, [user.userId, RUN_LIMIT_MS / 1000 + 30])).rows[0]!.n);
  if (mine > 0) throw new Refused("rate_limited", 429, "your previous network diagnosis is still running; wait for it to finish");
  const sites = new Set(rows.map(r => r.site));
  const label = sites.size === 1 ? `${rows[0]!.site}: ${rows.length} ${rows.length === 1 ? "cabinet" : "cabinets"}` : `${rows.length} cabinets at ${sites.size} sites`;
  const batchId = randomUUID();
  await pool.query("INSERT INTO diagnosis_batches (id, created_by, label, site_id, total, cabinet_ids) VALUES ($1, $2, $3, $4, $5, $6)",
    [batchId, user.userId, label.slice(0, 200), "siteId" in selection ? selection.siteId : null, rows.length, rows.map(r => r.id)]);
  const offline = rows.filter(r => !r.online);
  for (const r of offline)
    await pool.query(`INSERT INTO diagnoses (id, cabinet_id, kind, run_by, state, finished_at, failure, batch_id) VALUES ($1, $2, 'network', $3, 'offline', now(), $4, $5)`,
      [randomUUID(), r.id, user.userId, "Offline: not heard from in the last 5 minutes, so nothing could be checked.", batchId]);
  const queue = rows.filter(r => r.online);
  // At most a few run at once; each is issued as the person who asked, so the audit log shows who looked at which cabinet.
  void (async () => {
    let next = 0;
    const worker = async () => {
      for (;;) {
        const r = queue[next++];
        if (!r) return;
        try { await (await beginDiagnosis(pool, user, r.id, r, batchId, log)).done; }
        catch (e) {
          log(`network diagnosis of ${r.name} could not start: ${(e as Error).message}`);
          await pool.query(`INSERT INTO diagnoses (id, cabinet_id, kind, run_by, state, finished_at, failure, batch_id) VALUES ($1, $2, 'network', $3, 'failed', now(), $4, $5)`,
            [randomUUID(), r.id, user.userId, "The diagnosis could not be started.", batchId]).catch(() => undefined);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) }, worker));
  })();
  return { batchId, total: rows.length, offline: offline.length };
}

/** What a fix is, for grouping: the same change on several cabinets is one row with a list. */
const GROUP_TITLE: Record<string, string> = {
  "baseline-dns": "DNS servers differ from the site baseline", "baseline-subnet": "Address outside the site's network", "baseline-gateway": "Wrong gateway",
  "baseline-addressing": "Fixed address where the site uses DHCP", ip: "No DHCP lease (address 169.254.x.x)", "sync-firewall": "Firewall blocks the sync cabinet's ports",
  firewall: "Firewall differs from the client policy",
};
const baseId = (id: string) => id.replace(/-\d+$/, "");
export const JOB_FOR: Record<string, "firewall.applyPolicy" | "network.setDns" | "network.setIp" | "network.renewLease"> = {
  apply_policy: "firewall.applyPolicy", renew_lease: "network.renewLease", set_dns: "network.setDns", use_dhcp: "network.setIp", set_static: "network.setIp",
};

export async function networkBatch(db: pg.Pool, batchId: string) {
  const b = (await db.query<{ id: string; label: string; site_id: string | null; created_at: Date; total: number; cabinet_ids: string[]; name: string }>(
    "SELECT b.id, b.label, b.site_id, b.created_at, b.total, b.cabinet_ids, u.name FROM diagnosis_batches b JOIN users u ON u.id = b.created_by WHERE b.id = $1", [batchId])).rows[0];
  if (!b) return null;
  const rows = (await db.query<{ id: string; cabinet_id: string; name: string; role: string; site: string; state: string; findings: Finding[] | null; failure: string | null; started_at: Date }>(
    `SELECT d.id, d.cabinet_id, k.name, k.role, s.name AS site, d.state, d.findings, d.failure, d.started_at
       FROM diagnoses d JOIN cabinets k ON k.id = d.cabinet_id JOIN sites s ON s.id = k.site_id WHERE d.batch_id = $1 ORDER BY s.name, k.name`, [batchId])).rows;
  const cabinets = rows.map(r => ({ diagnosisId: r.id, cabinetId: r.cabinet_id, name: r.name, role: r.role, site: r.site, state: r.state, failure: r.failure,
    layers: r.findings ? layerStates(r.findings) : null,
    problems: (r.findings ?? []).filter(f => f.severity === "problem").length, warnings: (r.findings ?? []).filter(f => f.severity === "warning").length }));
  const finished = rows.filter(r => r.state !== "running").length;
  // Fixes, grouped: the same kind of change gathered with the cabinets it would be made on.
  const groups = new Map<string, { key: string; title: string; severity: string; kind: string | null; operation: string | null;
    targets: Map<string, { cabinetId: string; cabinetName: string; label: string; action: Exclude<FixAction, { kind: "open" }> }>; affected: Set<string>; example: string; fix: string | null }>();
  for (const r of rows) for (const f of r.findings ?? []) {
    if (f.severity !== "problem" && f.severity !== "warning") continue;
    if (f.causedBy) continue;
    const base = baseId(f.id);
    const kind = f.action && f.action.kind !== "open" ? f.action.kind : null;
    const key = `${base}|${kind ?? "none"}`;
    const g = groups.get(key) ?? groups.set(key, { key, title: GROUP_TITLE[base] ?? f.title, severity: f.severity, kind, operation: kind ? JOB_FOR[kind] ?? null : null,
      targets: new Map(), affected: new Set(), example: f.title, fix: f.fix }).get(key)!;
    if (f.severity === "problem") g.severity = "problem";
    g.affected.add(r.name);
    if (f.action && f.action.kind !== "open") { const a = f.action as Exclude<FixAction, { kind: "open" }>; g.targets.set(a.cabinetId, { cabinetId: a.cabinetId, cabinetName: a.cabinetName, label: "label" in a ? a.label : `Apply the policy on ${a.cabinetName}`, action: a }); }
  }
  // Whether every site in the batch has a network baseline; without one the readings are shown but nothing is compared.
  const hasBaseline = rows.length > 0 && (await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM sites s JOIN cabinets k ON k.site_id = s.id WHERE k.id = ANY($1::uuid[]) AND s.network_baseline IS NULL", [rows.map(r => r.cabinet_id)])).rows[0]!.n === "0";
  return { id: b.id, label: b.label, siteId: b.site_id, startedAt: b.created_at.toISOString(), startedBy: b.name, total: b.total, finished, hasBaseline,
    state: finished >= b.total ? "done" : "running", cabinets,
    waiting: b.total - rows.length,
    groups: [...groups.values()].sort((x, y) => Number(y.severity === "problem") - Number(x.severity === "problem") || y.affected.size - x.affected.size).map(g => ({
      key: g.key, title: g.title, severity: g.severity, fix: g.fix, kind: g.kind, operation: g.operation, affected: [...g.affected], targets: [...g.targets.values()] })) };
}
