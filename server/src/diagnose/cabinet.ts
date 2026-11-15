// Diagnose this cabinet (Tier 1, docs/spec/12-milestones-8-to-12.md "Milestone 12"): one click runs a fixed set of safe reads on the cabinet,
// each issued, checked and audited as the person who clicked (exactly as if they had run it on its own page), together with the network
// diagnosis, and reads the answers with the fixed checks in cabinet-findings.ts. The result is one list of findings, most important first,
// each with its evidence, how sure the platform is, the suggested fix, the runbook and known fixes that apply, and the fix button where
// there is a safe one. The run is stored (30 days, the diagnoses retention) so the next person sees what was found. Nothing here changes a
// cabinet; fixes are separate commands the person confirms, through the same path as any other change.
import { randomUUID } from "node:crypto";
import { audit, type Pool } from "../db/db.js";
import { Refused } from "../services/errors.js";
import { issueFromConsole, type Role } from "../services/console-commands.js";
import { OFFLINE_AFTER_MS } from "../services/cabinets.js";
import { scannerIdsFor } from "../services/fleet.js";
import { scannerUsedFor } from "../services/client-scanner.js";
import { SITE_ZONE_SQL } from "../services/time.js";
import { fixesForFindings, type KnownFixView } from "../services/known-fixes.js";
import { effectiveRunbook, runbookSummaries } from "../services/runbooks.js";
import { issueResolutions } from "../services/resolutions.js";
import { listNotes } from "../services/case-notes.js";
import { beginDiagnosis, NO_ANSWER, RUN_LIMIT_MS, waitFor, type Outcome } from "./network.js";
import { cabinetFindings, cabinetModules, clean, type BundleFinding, type CabinetEvidence, type CabinetFindings, type Read } from "./cabinet-findings.js";
import { cabinetOutcomes, recordCheck } from "../services/diagnosis-incidents.js";
import type { Finding as NetworkFinding } from "./network-findings.js";
import { failDiagnosis, finishDiagnosis, startDiagnosis } from "./diagnoses.js";

const POLL_MS = 300;
const MAX_RUNNING_PER_USER = 2;

interface Issued { key: string; operation: string; commandId: string }

/** The fixed set of reads (and nothing else) that the diagnosis runs. Parameters are exactly the ones each operation's own page sends. */
export function bundleReads(now = Date.now(), scannerUsed = true): { key: keyof ReadKeys; operation: string; params: Record<string, unknown> }[] {
  const from = new Date(now - 24 * 3_600_000).toISOString();
  return [
    { key: "info", operation: "system.info", params: {} },
    { key: "smart", operation: "disk.smart", params: {} },
    { key: "performance", operation: "system.performance", params: {} },
    // A client that uses no fingerprint scanner: there is nothing to read.
    ...(scannerUsed ? [{ key: "peripheral" as const, operation: "peripheral.status", params: {} }] : []),
    { key: "usb", operation: "usb.ports", params: {} },
    { key: "devices", operation: "devices.list", params: { problemsOnly: true } },
    { key: "services", operation: "services.list", params: {} },
    { key: "updates", operation: "updates.status", params: {} },
    { key: "time", operation: "time.status", params: {} },
    { key: "systemLog", operation: "eventlog.query", params: { log: "System", levels: ["error", "critical"], from, pageSize: 100 } },
    { key: "appLog", operation: "eventlog.query", params: { log: "Application", levels: ["error", "critical"], from, pageSize: 100 } },
  ];
}
type ReadKeys = Pick<CabinetEvidence, "info" | "smart" | "performance" | "peripheral" | "usb" | "devices" | "services" | "updates" | "time" | "systemLog" | "appLog">;

export async function startCabinetDiagnosis(pool: Pool, user: { userId: string; role: Role }, cabinetId: string, log: (m: string) => void = () => {}): Promise<string> {
  const k = (await pool.query<{ name: string; role: string; online: boolean }>(
    `SELECT name, role, CAST(CASE WHEN last_heartbeat_at > DATEADD(second, -$2, SYSUTCDATETIME()) THEN 1 ELSE 0 END AS bit) AS online FROM cabinets WHERE id = $1 AND status = 'active'`,
    [cabinetId, OFFLINE_AFTER_MS / 1000])).rows[0];
  if (!k) throw new Refused("not_found", 404, "no such cabinet");
  if (!k.online) throw new Refused("cabinet_offline", 409, "this cabinet has not been heard from in the last 5 minutes, so nothing can be read from it; the diagnosis works once it is back");
  // A diagnosis already running on this cabinet is shared rather than started twice; one person runs at most two at a time.
  const running = (await pool.query<{ id: string }>(
    "SELECT TOP (1) id FROM diagnoses WHERE cabinet_id = $1 AND kind = 'cabinet' AND state = 'running' AND started_at > DATEADD(second, -$2, SYSUTCDATETIME()) ORDER BY started_at DESC",
    [cabinetId, RUN_LIMIT_MS / 1000 + 15])).rows[0];
  if (running) return running.id;
  const mine = Number((await pool.query<{ n: number }>(
    "SELECT count(*) AS n FROM diagnoses WHERE run_by = $1 AND kind = 'cabinet' AND state = 'running' AND started_at > DATEADD(second, -$2, SYSUTCDATETIME())", [user.userId, RUN_LIMIT_MS / 1000 + 15])).rows[0]!.n);
  if (mine >= MAX_RUNNING_PER_USER) throw new Refused("rate_limited", 429, `you already have ${MAX_RUNNING_PER_USER} cabinet diagnoses running; wait for one to finish`);

  const id = randomUUID();
  // The reads are issued before answering, so a refusal (role, unknown cabinet) reaches the person at once. The scanner's hardware IDs
  // are filled in by the server from the console's settings, as for the scanner page.
  const issued: Issued[] = [];
  const scannerUsed = await scannerUsedFor(pool, cabinetId);
  for (const r of bundleReads(Date.now(), scannerUsed)) issued.push({ key: r.key, operation: r.operation, commandId: (await issueFromConsole(pool, user, cabinetId, r.operation, r.params)).commandId });
  await startDiagnosis(pool, { id, cabinetId, kind: "cabinet", runBy: user.userId, commands: issued, batchId: null });
  await audit(pool, { actorKind: "user", actorId: user.userId, action: "diagnosis.start", targetKind: "cabinet", targetId: cabinetId, outcome: "succeeded", details: { diagnosisId: id, kind: "cabinet", reads: issued.length } });
  // The network diagnosis runs alongside, as its own stored diagnosis, and is folded in when it is done.
  let network: { id: string; done: Promise<void> } | null = null;
  try { network = await beginDiagnosis(pool, user, cabinetId, k, null, log); } catch (e) { log(`the network part of a cabinet diagnosis could not start: ${(e as Error).message}`); }
  void run(pool, cabinetId, id, issued, network).then(async result => {
    // Each cabinet module with a problem opens (or adds to) its incident, and a clean one closes it (D16); the network part records its own.
    let outcomes: ReturnType<typeof cabinetOutcomes> = [];
    try { outcomes = cabinetOutcomes(result.areas, new Map(cabinetModules().map(m => [m.area as string, { id: m.id, version: m.version }]))); }
    catch (e) { log(`the cabinet diagnosis could not be recorded on its incidents: ${(e as Error).message}`); }
    for (const { module, outcome } of outcomes)
      await recordCheck(pool, { cabinetId, diagnosisId: id, module, label: "The cabinet diagnosis", outcome })
        .catch(e => log(`the cabinet diagnosis could not be recorded on the ${module.id} incident: ${(e as Error).message}`));
  }, async e => {
    log(`cabinet diagnosis failed: ${(e as Error).message}`);
    await failDiagnosis(pool, id, "The diagnosis stopped because of a server error. Run it again; if it repeats, the server log has the detail.").catch(() => undefined);
  });
  return id;
}

async function run(pool: Pool, cabinetId: string, id: string, issued: Issued[], network: { id: string; done: Promise<void> } | null): Promise<CabinetFindings> {
  const deadline = Date.now() + RUN_LIMIT_MS;
  const results = await waitFor(pool, issued.map(i => i.commandId), deadline);
  const read = <T,>(key: string): Read<T> | undefined => {
    const c = issued.find(i => i.key === key);
    if (!c) return undefined;
    const o: Outcome = results.get(c.commandId) ?? { status: "no_answer", failure: NO_ANSWER };
    return o.status === "succeeded" && o.output !== undefined ? { ok: true, output: o.output as T } : { ok: false, failure: o.failure ?? o.status };
  };
  // The network part gets what is left of its own minute; its findings are carried over, not re-derived here.
  let net: { findings: NetworkFinding[] } | { failure: string } | undefined;
  if (network) {
    await Promise.race([network.done, new Promise<void>(res => setTimeout(res, Math.max(0, deadline - Date.now()) + 5_000))]);
    const d = (await pool.query<{ state: string; findings: NetworkFinding[] | null; failure: string | null }>("SELECT state, findings, failure FROM diagnoses WHERE id = $1", [network.id])).rows[0];
    net = d?.state === "done" && d.findings ? { findings: d.findings } : { failure: d?.failure ?? "the network checks did not finish in time" };
  } else net = { failure: "the network checks could not start" };

  const k = (await pool.query<{ name: string; role: string; zone: string | null }>(
    `SELECT k.name, k.role, ${SITE_ZONE_SQL} AS zone FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients cl ON cl.id = s.client_id WHERE k.id = $1`, [cabinetId])).rows[0];
  if (!k) throw new Error("the cabinet is gone");
  const evidence: CabinetEvidence = { cabinet: { id: cabinetId, name: k.name, role: k.role }, siteTimeZone: k.zone, now: Date.now(),
    scannerUsed: issued.some(i => i.key === "peripheral") };
  for (const key of ["info", "smart", "performance", "peripheral", "usb", "devices", "services", "updates", "time", "systemLog", "appLog"] as const) {
    const r = read<never>(key);
    if (r) (evidence as unknown as Record<string, unknown>)[key] = r;
  }
  const result = cabinetFindings(evidence, net);
  const readings = { takenAt: new Date().toISOString(), headline: result.headline, areas: result.areas, networkDiagnosisId: network?.id ?? null,
    skipped: issued.filter(i => { const r = read<unknown>(i.key); return r && !r.ok; }).map(i => ({ read: i.key, operation: i.operation, why: clean((read<unknown>(i.key) as { failure: string }).failure, 200) })) };
  await finishDiagnosis(pool, id, result.findings, readings);
  return result;
}

// ---- Reading a diagnosis ----------------------------------------------------------------------------------------------------------------

type Row = { id: string; cabinet_id: string; state: string; started_at: Date; finished_at: Date | null; findings: BundleFinding[] | null; failure: string | null; readings: Record<string, unknown> | null; run_by: string };

/** A stored cabinet diagnosis with each finding's runbook, known fixes and usual fix looked up now (they change; the finding does not). */
export async function cabinetDiagnosis(db: Pool, id: string) {
  const r = (await db.query<Row>(
    `SELECT d.id, d.cabinet_id, d.state, d.started_at, d.finished_at, d.findings, d.failure, d.readings, u.name AS run_by
       FROM diagnoses d JOIN users u ON u.id = d.run_by WHERE d.id = $1 AND d.kind = 'cabinet'`, [id])).rows[0];
  if (!r) return null;
  const findings = r.findings ?? [];
  const keys = [...new Set(findings.map(f => f.key))];
  const issueIds = [...new Set(findings.map(f => f.issueTypeId).filter((x): x is string => !!x))];
  const books = await runbookSummaries(db, issueIds, keys);
  const known = await fixesForFindings(db, findings.map(f => f.key));
  const issueFixes = new Map<string, KnownFixView[]>();
  for (const f of await db.query<{ issue_type_id: string }>("SELECT DISTINCT issue_type_id FROM known_fixes WHERE status = 'approved' AND removed_at IS NULL AND issue_type_id IN (SELECT CAST(value AS uniqueidentifier) FROM OPENJSON($1))", [issueIds]).then(x => x.rows)) issueFixes.set(f.issue_type_id, []);
  const usual = new Map<string, { fix: string; count: number } | null>();
  for (const iid of issueIds) { const u = (await issueResolutions(db, iid)).fixes[0]; usual.set(iid, u ? { fix: u.fix, count: u.count } : null); }
  const enriched = findings.map(f => {
    // The runbook for the finding itself first, else the one for the issue type it is an instance of.
    const own = books.finding.get(f.key), byIssue = f.issueTypeId ? books.issue.get(f.issueTypeId) : undefined;
    return { ...f,
      runbook: own ? { target: { kind: "finding" as const, key: f.key }, ...own } : byIssue && f.issueTypeId ? { target: { kind: "issue" as const, issueTypeId: f.issueTypeId }, ...byIssue } : null,
      knownFixes: (known[f.key]?.length ?? 0) + (f.issueTypeId && issueFixes.has(f.issueTypeId) ? 1 : 0),
      usualFix: f.issueTypeId ? usual.get(f.issueTypeId) ?? null : null };
  });
  const open = (await db.query<{ id: string; title: string; severity: string; state: string; issue_type_id: string | null }>(
    `SELECT TOP (10) id, title, severity, state, issue_type_id FROM alerts WHERE cabinet_id = $1 AND state <> 'resolved' ORDER BY CASE WHEN severity = 'major' THEN 0 ELSE 1 END, last_seen DESC`, [r.cabinet_id])).rows;
  const notes = (await listNotes(db, r.cabinet_id)).slice(0, 5);
  return { id: r.id, cabinetId: r.cabinet_id, kind: "cabinet" as const, state: r.state, startedAt: r.started_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null, runBy: r.run_by,
    failure: r.failure, findings: enriched, readings: r.readings,
    context: { openAlerts: open.map(a => ({ id: a.id, title: clean(a.title, 200), severity: a.severity, state: a.state, issueTypeId: a.issue_type_id })), notes } };
}

export async function latestCabinetDiagnosis(db: Pool, cabinetId: string) {
  const id = (await db.query<{ id: string }>("SELECT TOP (1) id FROM diagnoses WHERE cabinet_id = $1 AND kind = 'cabinet' ORDER BY started_at DESC", [cabinetId])).rows[0]?.id;
  return id ? cabinetDiagnosis(db, id) : null;
}

/** The runbook for one finding or issue type, with its steps (the console opens it from a finding or an alert). */
export { effectiveRunbook };

