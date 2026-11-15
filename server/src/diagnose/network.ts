// Diagnose network (Tier 1): one click runs the cabinet's network reads and tests, as the person who asked (each command is
// issued, checked and audited exactly as if they had clicked it), then reads the results with the fixed checks in
// network-findings.ts. The run is stored, so the next person sees what was found.
import { randomUUID } from "node:crypto";
import type { DatabaseConnectivityOutput, FirewallStateOutput, NetworkConfigOutput, NetworkTestOutput, NetworkTraceOutput } from "@mashura/cabinet-contracts/types";
import type { Role } from "../services/console-commands.js";
import type { Pool } from "../db/db.js";
import { issueFromConsole } from "../services/console-commands.js";
import { cabinetPolicy, switchesFor } from "../services/firewall-policy.js";
import { syncForCabinet } from "../services/device-settings.js";
import { OFFLINE_AFTER_MS } from "../services/cabinets.js";
import { Refused } from "../services/errors.js";
import { findingKey, fixesForFindings, markSeen } from "../services/known-fixes.js";
import { closeIssueAlert, upsertAlert } from "../services/alerts.js";
import { ISSUE } from "../services/rules.js";
import { layerStates, type Finding, type FixAction, type NetworkBaseline, type NetworkEvidence, type Profiles, type TestRun } from "./network-findings.js";
import type { TraceRun } from "./network-observations.js";
import { networkModule, runNetworkModule } from "./network-module.js";
import { networkOutcome, recordCheck } from "../services/diagnosis-incidents.js";
import { SQL_SERVER_PORT, type DatabaseRun } from "./sql-findings.js";
import { failDiagnosis, finishDiagnosis, recordDiagnosisCommands, recordUnstartedDiagnosis, startDiagnosis } from "./diagnoses.js";

/**
 * How long a diagnosis waits for its reads (docs/platform/decision-log.md, D11). The wait ends as soon as every read has answered, so a
 * healthy cabinet is no slower for a longer limit; the limit only decides how much of a slow case is kept. Worked out from the agent's
 * own limits, a sync cabinet that answers nothing costs about 21 s for its 10-request ping series, 41 s for four port series that each
 * stop after two silent tries, and about 12 s more for the trace towards it, on top of the other reads: past one minute, so the last
 * reads came back as "no answer". Two minutes keeps them.
 */
export const RUN_LIMIT_MS = 120_000;
/** What a read that did not answer in time is reported as. */
export const NO_ANSWER = `no answer within ${RUN_LIMIT_MS / 60_000} minutes`;
/** The agent refuses more than this many network tests a minute (docs/spec/04-agent-spec.md; RateLimiter.cs); a plan stays within it. */
export const AGENT_NETWORK_TESTS_PER_MINUTE = 10;
const POLL_MS = 300;

interface Issued { key: string; label: string; operation: string; params: Record<string, unknown>; commandId: string }
export type Outcome = { status: string; output?: unknown; failure?: string | undefined };

export async function waitFor(pool: Pool, ids: string[], deadline: number): Promise<Map<string, Outcome>> {
  const done = new Map<string, Outcome>();
  while (Date.now() < deadline) {
    const rows = (await pool.query<{ id: string; status: string; result: { output?: unknown; error?: { message: string } } | null }>(
      "SELECT id, status, result FROM commands WHERE id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1)) AND status NOT IN ('queued', 'delivered')", [ids])).rows;
    for (const r of rows) done.set(r.id, { status: r.status, output: r.result?.output, failure: r.status === "succeeded" ? undefined : r.result?.error?.message ?? r.status });
    if (done.size === ids.length) break;
    await new Promise(res => setTimeout(res, POLL_MS));
  }
  return done;
}

const MAX_RUNNING_PER_USER = 3;

export interface PlannedRead { key: string; label: string; operation: "network.test" | "network.trace" | "database.connectivity"; params: Record<string, unknown> }

/**
 * The tests and traces a diagnosis issues after the network settings are in (the network-diagnosis module declares the same reads;
 * server/test/network-module.test.ts keeps them identical): the gateway, each DNS server the connected adapters use (`dnsCount`, 1 to
 * 4), the platform server's name, and, for a cabinet that has a sync cabinet to reach (`syncPorts` not null), the sync cabinet by ping
 * and on each of its first four ports; then the paths to the platform server and the sync cabinet, to see where replies stop. At most
 * AGENT_NETWORK_TESTS_PER_MINUTE tests: with four sync ports, a fourth DNS server is left out.
 */
export function plannedTests(dnsCount: number, syncPorts: readonly number[] | null): { tests: PlannedRead[]; traces: PlannedRead[]; databases: PlannedRead[] } {
  const tests: PlannedRead[] = [{ key: "gateway", label: "Gateway (ping)", operation: "network.test", params: { target: "gateway", method: "ping", count: 4 } }];
  // The SQL connectivity ladder (D15): SQL Server on the sync cabinet, when the site's sync ports include its default port. It counts
  // against the same agent limit as the network tests.
  const databases: PlannedRead[] = syncPorts?.slice(0, 4).includes(SQL_SERVER_PORT)
    ? [{ key: `sync-sql-${SQL_SERVER_PORT}`, label: "SQL Server on the sync cabinet", operation: "database.connectivity", params: { port: SQL_SERVER_PORT } }] : [];
  // Every test here is a network.test, and the agent takes at most 10 a minute. The DNS servers are the ones left out when the plan would
  // go over: Windows asks them in order, so a fourth is asked only after three have failed, while each sync port is a service of its own.
  const syncTests = (syncPorts ? 1 + Math.min(4, syncPorts.length) : 0) + databases.length;
  const dnsTests = Math.max(0, Math.min(dnsCount, AGENT_NETWORK_TESTS_PER_MINUTE - 2 - syncTests));
  for (let i = 0; i < dnsTests; i++) tests.push({ key: `dns-${i}`, label: `DNS server ${i + 1}`, operation: "network.test", params: { target: "dns_server", method: "dns", dnsServerIndex: i } });
  tests.push({ key: "platform", label: "Platform server name", operation: "network.test", params: { target: "platform_server", method: "dns" } });
  if (syncPorts) {
    tests.push({ key: "sync-ping", label: "Sync cabinet (ping)", operation: "network.test", params: { target: "sync_cabinet", method: "ping", count: 10 } });
    for (const port of syncPorts.slice(0, 4))
      tests.push({ key: `sync-tcp-${port}`, label: `Sync cabinet port ${port}`, operation: "network.test", params: { target: "sync_cabinet", method: "tcp", port, count: 5 } });
  }
  const traces: PlannedRead[] = [{ key: "trace-platform", label: "Path to the platform server", operation: "network.trace", params: { target: "platform_server" } }];
  if (syncPorts) traces.push({ key: "trace-sync", label: "Path to the sync cabinet", operation: "network.trace", params: { target: "sync_cabinet" } });
  return { tests, traces, databases };
}

export async function startNetworkDiagnosis(pool: Pool, user: { userId: string; role: Role }, cabinetId: string, log: (m: string) => void = () => {}): Promise<string> {
  const k = (await pool.query<{ name: string; role: string }>("SELECT name, role FROM cabinets WHERE id = $1 AND status = 'active'", [cabinetId])).rows[0];
  if (!k) throw new Refused("not_found", 404, "no such cabinet");
  // A diagnosis already running on this cabinet is shared rather than started twice; one person runs at most 3 at a time.
  const running = (await pool.query<{ id: string }>(
    "SELECT TOP (1) id FROM diagnoses WHERE cabinet_id = $1 AND kind = 'network' AND state = 'running' AND started_at > DATEADD(second, -$2, SYSUTCDATETIME()) ORDER BY started_at DESC",
    [cabinetId, RUN_LIMIT_MS / 1000 + 5])).rows[0];
  if (running) return running.id;
  const mine = Number((await pool.query<{ n: number }>(
    "SELECT count(*) AS n FROM diagnoses WHERE run_by = $1 AND state = 'running' AND started_at > DATEADD(second, -$2, SYSUTCDATETIME())",
    [user.userId, RUN_LIMIT_MS / 1000 + 5])).rows[0]!.n);
  if (mine >= MAX_RUNNING_PER_USER) throw new Refused("rate_limited", 429, `you already have ${MAX_RUNNING_PER_USER} diagnoses running; wait for one to finish`);
  const { id } = await beginDiagnosis(pool, user, cabinetId, k, null, log);
  return id;
}

/**
 * Creates the diagnosis row, issues its first reads (so a refusal reaches the person at once) and runs the rest in the
 * background. `done` settles when the run has finished; a batch waits on it to limit how many run at once.
 */
export async function beginDiagnosis(pool: Pool, user: { userId: string; role: Role }, cabinetId: string, k: { name: string; role: string }, batchId: string | null,
  log: (m: string) => void): Promise<{ id: string; done: Promise<void> }> {
  const id = randomUUID();
  // The first two commands are issued before answering, so a refusal (role, write pause does not apply to reads) reaches the person.
  const issue = async (key: string, label: string, operation: string, params: Record<string, unknown>): Promise<Issued> =>
    ({ key, label, operation, params, commandId: (await issueFromConsole(pool, user, cabinetId, operation, params)).commandId });
  const first = [await issue("config", "Network settings", "network.config", {}), await issue("firewall", "Firewall", "firewall.state", {})];
  await startDiagnosis(pool, { id, cabinetId, kind: "network", runBy: user.userId, commands: first, batchId });
  const done = run(pool, user, cabinetId, { name: k.name, role: k.role }, id, first, issue).then(async findings => {
    // A problem opens (or adds to) the cabinet's network incident and a clean run closes it (D16); never a reason to fail the diagnosis.
    try {
      const m = networkModule();
      await recordCheck(pool, { cabinetId, diagnosisId: id, module: { id: m.id, version: m.version }, label: "The network diagnosis", outcome: networkOutcome(findings) });
    } catch (e) { log(`the network diagnosis could not be recorded on its incident: ${(e as Error).message}`); }
  }, async e => {
    log(`network diagnosis failed: ${(e as Error).message}`);
    await failDiagnosis(pool, id, "The diagnosis stopped because of a server error. Run it again; if it repeats, the server log has the detail.").catch(() => undefined);
  });
  return { id, done };
}

async function run(pool: Pool, user: { userId: string; role: Role }, cabinetId: string, cabinet: { name: string; role: string }, id: string, first: Issued[],
  issue: (key: string, label: string, operation: string, params: Record<string, unknown>) => Promise<Issued>): Promise<Finding[]> {
  const deadline = Date.now() + RUN_LIMIT_MS;
  const firstDone = await waitFor(pool, [first[0]!.commandId], Math.min(deadline, Date.now() + 30_000));
  const config = firstDone.get(first[0]!.commandId);
  const configOut = config?.status === "succeeded" ? config.output as NetworkConfigOutput : undefined;

  const connected = configOut?.adapters.filter(a => a.connected) ?? [];
  const dnsCount = Math.min(4, Math.max(1, ...connected.map(a => a.dns.servers.length)));
  const sync = await syncForCabinet(pool, cabinetId);
  const plan = plannedTests(dnsCount, cabinet.role !== "sync" && sync?.address ? sync.effective : null);
  const tests: Issued[] = [];
  for (const t of plan.tests) tests.push(await issue(t.key, t.label, t.operation, t.params));
  const traces: Issued[] = [];
  for (const t of plan.traces) traces.push(await issue(t.key, t.label, t.operation, t.params));
  const databases: Issued[] = [];
  for (const t of plan.databases) databases.push(await issue(t.key, t.label, t.operation, t.params));
  const all = [...first, ...tests, ...traces, ...databases];
  await recordDiagnosisCommands(pool, id, all);
  const results = await waitFor(pool, all.map(c => c.commandId), deadline);
  const outcome = (c: Issued): Outcome => results.get(c.commandId) ?? { status: "no_answer", failure: NO_ANSWER };
  const fw = outcome(first[1]!);

  // This satellite's own sync cabinet as the platform knows it: whether it is checking in, and its firewall profiles.
  const sc = sync?.address ? (await pool.query<{ id: string; name: string; last: Date | null; firewall_profiles: Profiles | null }>(
    `SELECT y.id, y.name, y.last_heartbeat_at AS last, y.firewall_profiles FROM cabinets k
       JOIN cabinets y ON y.id = k.sync_cabinet_id AND y.site_id = k.site_id AND y.role = 'sync' AND y.status = 'active'
      WHERE k.id = $1`, [cabinetId])).rows[0] : undefined;
  const policy = switchesFor((await cabinetPolicy(pool, cabinetId)).policy);
  const baseline = (await pool.query<{ network_baseline: NetworkBaseline | null }>(
    "SELECT s.network_baseline FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE k.id = $1", [cabinetId])).rows[0]?.network_baseline ?? null;
  const evidence: NetworkEvidence = {
    cabinet: { id: cabinetId, name: cabinet.name, role: cabinet.role }, baseline,
    ...(configOut ? { config: configOut } : { configFailure: config?.failure ?? "no answer" }),
    ...(fw.status === "succeeded" ? { firewall: fw.output as FirewallStateOutput } : { firewallFailure: fw.failure ?? "no answer" }),
    policy,
    sync: { address: sync?.address ?? null, ports: sync?.effective ?? [], cabinet: sc ? { id: sc.id, name: sc.name,
      online: !!sc.last && Date.now() - sc.last.getTime() < OFFLINE_AFTER_MS, minutesSilent: sc.last ? Math.round((Date.now() - sc.last.getTime()) / 60_000) : null, profiles: sc.firewall_profiles } : null },
    tests: tests.map((t): TestRun => {
      const o = outcome(t);
      return { key: t.key, label: t.label, params: t.params, ...(o.status === "succeeded" ? { output: o.output as NetworkTestOutput } : { failure: o.failure ?? o.status }) };
    }),
  };
  evidence.traces = traces.map((t): TraceRun => {
    const o = outcome(t);
    return { key: t.key, label: t.label, params: t.params, ...(o.status === "succeeded" ? { output: o.output as NetworkTraceOutput } : { failure: o.failure ?? o.status }) };
  });
  evidence.databases = databases.map((t): DatabaseRun => {
    const o = outcome(t);
    return { key: t.key, label: t.label, params: t.params, ...(o.status === "succeeded" ? { output: o.output as DatabaseConnectivityOutput } : { failure: o.failure ?? o.status }) };
  });
  const findings = runNetworkModule(evidence);
  // Everything that was read, kept whether or not anything is wrong, so the console can show the full read.
  const readings = { takenAt: new Date().toISOString(), adapters: configOut?.adapters ?? [], routes: configOut?.routes ?? [], neighbors: configOut?.neighbors ?? [],
    tests: evidence.tests, traces: evidence.traces, databases: evidence.databases };
  // The baseline alert is settled before the diagnosis says it is done, so whoever sees it done (the console, a batch, a test) sees the
  // alert as the diagnosis left it, never the moment between the two.
  await reconcileBaselineAlert(pool, cabinetId, findings, baseline !== null && configOut !== undefined);
  await finishDiagnosis(pool, id, findings, readings);
  // A problem somebody has already solved here: count that the fix was shown again (the console shows it beside the finding).
  const seen = await fixesForFindings(pool, findings.filter(f => f.severity !== "ok").map(f => f.id));
  await markSeen(pool, [...new Set(Object.values(seen).flat().map(f => f.id))]);
  return findings;
}

/** The minor alert that says a cabinet differs from its site's baseline; the same alert is kept while it differs. */
export async function raiseBaselineAlert(db: Pool, cabinetId: string, titles: string[]): Promise<void> {
  const issue = (await db.query<{ name: string; severity: string }>("SELECT name, severity FROM issue_types WHERE id = $1", [ISSUE.networkBaseline])).rows[0];
  if (issue) await upsertAlert(db, { cabinetId, issueTypeId: ISSUE.networkBaseline, severity: issue.severity, signature: `issue:${ISSUE.networkBaseline}`,
    title: `${issue.name}: ${titles.slice(0, 2).join("; ")}`.slice(0, 250), seenAt: new Date(), ruleId: null, eventId: null });
}

/**
 * A diagnosis that finds the cabinet's address, gateway or DNS different from the site baseline raises a minor alert, so the
 * cabinet shows in Alerts; a later diagnosis that finds it matching closes it. Only when the baseline was set and the settings were read.
 */
async function reconcileBaselineAlert(pool: Pool, cabinetId: string, findings: Finding[], comparable: boolean): Promise<void> {
  if (!comparable) return;
  const off = findings.filter(f => f.id.startsWith("baseline-") && f.severity !== "ok");
  if (off.length > 0) {
    await raiseBaselineAlert(pool, cabinetId, off.map(f => f.title));
  } else {
    await closeIssueAlert(pool, "network-diagnosis", cabinetId, ISSUE.networkBaseline, "A network diagnosis found the settings matching the site baseline.");
  }
}

export async function diagnosis(db: Pool, id: string) {
  const r = (await db.query<{ id: string; cabinet_id: string; kind: string; state: string; started_at: Date; finished_at: Date | null; findings: unknown; failure: string | null; commands: unknown; readings: unknown; run_by: string }>(
    `SELECT d.id, d.cabinet_id, d.kind, d.state, d.started_at, d.finished_at, d.findings, d.failure, d.commands, d.readings, u.name AS run_by
       FROM diagnoses d JOIN users u ON u.id = d.run_by WHERE d.id = $1`, [id])).rows[0];
  if (!r) return null;
  const hasBaseline = (await db.query<{ b: boolean }>("SELECT CAST(CASE WHEN s.network_baseline IS NOT NULL THEN 1 ELSE 0 END AS bit) AS b FROM cabinets k JOIN sites s ON s.id = k.site_id WHERE k.id = $1", [r.cabinet_id])).rows[0]?.b ?? false;
  return { id: r.id, cabinetId: r.cabinet_id, kind: r.kind, state: r.state, startedAt: r.started_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null,
    runBy: r.run_by, findings: r.findings, failure: r.failure, commands: r.commands, readings: r.readings, hasBaseline };
}

export async function latestDiagnosis(db: Pool, cabinetId: string) {
  const id = (await db.query<{ id: string }>("SELECT TOP (1) id FROM diagnoses WHERE cabinet_id = $1 AND kind = 'network' ORDER BY started_at DESC", [cabinetId])).rows[0]?.id;
  return id ? diagnosis(db, id) : null;
}


// ---- Many cabinets at once ------------------------------------------------------------------------------------------------

export const BATCH_LIMIT = 60;
const BATCH_CONCURRENCY = 8;

/** Starts the diagnosis on the chosen cabinets, or on every active cabinet of a site. Offline cabinets are listed, not waited for. */
export async function startNetworkBatch(pool: Pool, user: { userId: string; role: Role }, selection: { cabinetIds: string[] } | { siteId: string },
  log: (m: string) => void = () => {}): Promise<{ batchId: string; total: number; offline: number }> {
  const rows = (await pool.query<{ id: string; name: string; role: string; site_id: string; site: string; online: boolean }>(
    `SELECT k.id, k.name, k.role, s.id AS site_id, s.name AS site, CAST(CASE WHEN k.last_heartbeat_at > DATEADD(second, -$2, SYSUTCDATETIME()) THEN 1 ELSE 0 END AS bit) AS online
       FROM cabinets k JOIN sites s ON s.id = k.site_id
      WHERE k.status = 'active' AND ${"siteId" in selection ? "s.id = $1" : "k.id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1))"} ORDER BY s.name, k.name`,
    ["siteId" in selection ? selection.siteId : selection.cabinetIds, OFFLINE_AFTER_MS / 1000])).rows;
  if (rows.length === 0) throw new Refused("not_found", 404, "no such active cabinets");
  if (rows.length > BATCH_LIMIT) throw new Refused("too_many_cabinets", 409, `a network diagnosis covers at most ${BATCH_LIMIT} cabinets at a time`);
  if ("cabinetIds" in selection && rows.length !== selection.cabinetIds.length) throw new Refused("not_found", 404, "one of the chosen cabinets does not exist or is not active");
  // A batch is running until every one of its cabinets has a finished diagnosis (or it is older than a run can last).
  const running = (await pool.query<{ id: string; total: number; cabinet_ids: string[] }>(
    `SELECT b.id, b.total, b.cabinet_ids FROM diagnosis_batches b
      WHERE b.created_by = $1 AND b.created_at > DATEADD(second, -$2, SYSUTCDATETIME())
        AND (SELECT count(*) FROM diagnoses d WHERE d.batch_id = b.id AND d.state <> 'running') < b.total ORDER BY b.created_at DESC`, [user.userId, RUN_LIMIT_MS / 1000 + 30])).rows;
  // Asking again for the very same cabinets while that check is still going (a second click, a page reload) joins it; a different set waits.
  const ids = new Set(rows.map(r => r.id));
  const same = running.find(b => b.cabinet_ids.length === ids.size && b.cabinet_ids.every(id => ids.has(id)));
  if (same) return { batchId: same.id, total: same.total, offline: 0 };
  if (running.length > 0) throw new Refused("rate_limited", 429, "your previous network diagnosis is still running; wait for it to finish");
  const sites = new Set(rows.map(r => r.site));
  const label = sites.size === 1 ? `${rows[0]!.site}: ${rows.length} ${rows.length === 1 ? "cabinet" : "cabinets"}` : `${rows.length} cabinets at ${sites.size} sites`;
  const batchId = randomUUID();
  await pool.query("INSERT INTO diagnosis_batches (id, created_by, label, site_id, total, cabinet_ids) VALUES ($1, $2, $3, $4, $5, $6)",
    [batchId, user.userId, label.slice(0, 200), "siteId" in selection ? selection.siteId : null, rows.length, rows.map(r => r.id)]);
  const offline = rows.filter(r => !r.online);
  for (const r of offline)
    await recordUnstartedDiagnosis(pool, { cabinetId: r.id, runBy: user.userId, state: "offline", failure: "Offline: not heard from in the last 5 minutes, so nothing could be checked.", batchId });
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
          await recordUnstartedDiagnosis(pool, { cabinetId: r.id, runBy: user.userId, state: "failed", failure: "The diagnosis could not be started.", batchId }).catch(() => undefined);
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
  firewall: "Firewall differs from its policy",
};
export const JOB_FOR: Record<string, "firewall.applyPolicy" | "network.setDns" | "network.setIp" | "network.renewLease"> = {
  apply_policy: "firewall.applyPolicy", renew_lease: "network.renewLease", set_dns: "network.setDns", use_dhcp: "network.setIp", set_static: "network.setIp",
};

export async function networkBatch(db: Pool, batchId: string) {
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
    const base = findingKey(f.id);
    const kind = f.action && f.action.kind !== "open" ? f.action.kind : null;
    const key = `${base}|${kind ?? "none"}`;
    const g = groups.get(key) ?? groups.set(key, { key, title: GROUP_TITLE[base] ?? f.title, severity: f.severity, kind, operation: kind ? JOB_FOR[kind] ?? null : null,
      targets: new Map(), affected: new Set(), example: f.title, fix: f.fix }).get(key)!;
    if (f.severity === "problem") g.severity = "problem";
    g.affected.add(r.name);
    if (f.action && f.action.kind !== "open") { const a = f.action as Exclude<FixAction, { kind: "open" }>; g.targets.set(a.cabinetId, { cabinetId: a.cabinetId, cabinetName: a.cabinetName, label: "label" in a ? a.label : `Apply the policy on ${a.cabinetName}`, action: a }); }
  }
  // Whether every site in the batch has a network baseline; without one the readings are shown but nothing is compared.
  const hasBaseline = rows.length > 0 && (await db.query<{ n: number }>(
    "SELECT count(*) AS n FROM sites s JOIN cabinets k ON k.site_id = s.id WHERE k.id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1)) AND s.network_baseline IS NULL", [rows.map(r => r.cabinet_id)])).rows[0]!.n === 0;
  return { id: b.id, label: b.label, siteId: b.site_id, startedAt: b.created_at.toISOString(), startedBy: b.name, total: b.total, finished, hasBaseline,
    state: finished >= b.total ? "done" : "running", cabinets,
    waiting: b.total - rows.length,
    groups: [...groups.values()].sort((x, y) => Number(y.severity === "problem") - Number(x.severity === "problem") || y.affected.size - x.affected.size).map(g => ({
      key: g.key, title: g.title, severity: g.severity, fix: g.fix, kind: g.kind, operation: g.operation, affected: [...g.affected], targets: [...g.targets.values()] })) };
}
