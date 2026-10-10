// Diagnose network (Tier 1): one click runs the cabinet's network reads and tests, as the person who asked (each command is
// issued, checked and audited exactly as if they had clicked it), then reads the results with the fixed checks in
// network-findings.ts. The run is stored, so the next person sees what was found.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { FirewallStateOutput, NetworkConfigOutput, NetworkTestOutput } from "@mashura/cabinet-contracts/types";
import type { Role } from "../services/console-commands.js";
import { safeJson } from "../db/db.js";
import { issueFromConsole } from "../services/console-commands.js";
import { cabinetPolicy, switchesFor } from "../services/firewall-policy.js";
import { syncForCabinet } from "../services/device-settings.js";
import { OFFLINE_AFTER_MS } from "../services/cabinets.js";
import { Refused } from "../services/errors.js";
import { networkFindings, type NetworkEvidence, type Profiles, type TestRun } from "./network-findings.js";

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

export async function startNetworkDiagnosis(pool: pg.Pool, user: { userId: string; role: Role }, cabinetId: string, log: (m: string) => void = () => {}): Promise<string> {
  const k = (await pool.query<{ name: string; role: string }>("SELECT name, role FROM cabinets WHERE id = $1 AND status = 'active'", [cabinetId])).rows[0];
  if (!k) throw new Refused("not_found", 404, "no such cabinet");
  const id = randomUUID();
  // The first two commands are issued before answering, so a refusal (role, write pause does not apply to reads) reaches the person.
  const issue = async (key: string, label: string, operation: string, params: Record<string, unknown>): Promise<Issued> =>
    ({ key, label, operation, params, commandId: (await issueFromConsole(pool, user, cabinetId, operation, params)).commandId });
  const first = [await issue("config", "Network settings", "network.config", {}), await issue("firewall", "Firewall", "firewall.state", {})];
  await pool.query("INSERT INTO diagnoses (id, cabinet_id, kind, run_by, state, commands) VALUES ($1, $2, 'network', $3, 'running', $4)",
    [id, cabinetId, user.userId, safeJson(first.map(c => ({ key: c.key, operation: c.operation, commandId: c.commandId })))]);
  void run(pool, user, cabinetId, { name: k.name, role: k.role }, id, first, issue).catch(async e => {
    log(`network diagnosis failed: ${(e as Error).message}`);
    await pool.query("UPDATE diagnoses SET state = 'failed', finished_at = now(), failure = $2 WHERE id = $1", [id, (e as Error).message.slice(0, 300)]).catch(() => undefined);
  });
  return id;
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
  const tests: Issued[] = [await issue("gateway", "Gateway (ping)", "network.test", { target: "gateway", method: "ping" })];
  for (let i = 0; i < dnsCount; i++) tests.push(await issue(`dns-${i}`, `DNS server ${i + 1}`, "network.test", { target: "dns_server", method: "dns", dnsServerIndex: i }));
  tests.push(await issue("platform", "Platform server name", "network.test", { target: "platform_server", method: "dns" }));
  if (cabinet.role !== "sync" && sync?.address) {
    tests.push(await issue("sync-ping", "Sync cabinet (ping)", "network.test", { target: "sync_cabinet", method: "ping" }));
    for (const port of sync.effective.slice(0, 4))
      tests.push(await issue(`sync-tcp-${port}`, `Sync cabinet port ${port}`, "network.test", { target: "sync_cabinet", method: "tcp", port }));
  }
  const all = [...first, ...tests];
  await pool.query("UPDATE diagnoses SET commands = $2 WHERE id = $1", [id, safeJson(all.map(c => ({ key: c.key, operation: c.operation, commandId: c.commandId })))]);
  const results = await waitFor(pool, all.map(c => c.commandId), deadline);
  const outcome = (c: Issued): Outcome => results.get(c.commandId) ?? { status: "no_answer", failure: "no answer within a minute" };
  const fw = outcome(first[1]!);

  // The site's sync cabinet as the platform knows it: whether it is checking in, and its firewall profiles.
  const sc = sync?.address ? (await pool.query<{ id: string; name: string; last: Date | null; profiles: Profiles | null }>(
    `SELECT k.id, k.name, k.last_heartbeat_at AS last, k.firewall_profiles AS profiles FROM cabinets k
      WHERE k.site_id = (SELECT site_id FROM cabinets WHERE id = $1) AND k.role = 'sync' AND k.status = 'active' AND k.id <> $1 ORDER BY k.name LIMIT 1`, [cabinetId])).rows[0] : undefined;
  const policy = switchesFor((await cabinetPolicy(pool, cabinetId)).policy);
  const evidence: NetworkEvidence = {
    cabinet: { id: cabinetId, name: cabinet.name, role: cabinet.role },
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
  await pool.query("UPDATE diagnoses SET state = 'done', finished_at = now(), findings = $2 WHERE id = $1", [id, safeJson(networkFindings(evidence))]);
}

export async function diagnosis(db: pg.Pool, id: string) {
  const r = (await db.query<{ id: string; cabinet_id: string; kind: string; state: string; started_at: Date; finished_at: Date | null; findings: unknown; failure: string | null; commands: unknown; run_by: string }>(
    `SELECT d.id, d.cabinet_id, d.kind, d.state, d.started_at, d.finished_at, d.findings, d.failure, d.commands, u.name AS run_by
       FROM diagnoses d JOIN users u ON u.id = d.run_by WHERE d.id = $1`, [id])).rows[0];
  if (!r) return null;
  return { id: r.id, cabinetId: r.cabinet_id, kind: r.kind, state: r.state, startedAt: r.started_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null,
    runBy: r.run_by, findings: r.findings, failure: r.failure, commands: r.commands };
}

export async function latestDiagnosis(db: pg.Pool, cabinetId: string) {
  const id = (await db.query<{ id: string }>("SELECT id FROM diagnoses WHERE cabinet_id = $1 AND kind = 'network' ORDER BY started_at DESC LIMIT 1", [cabinetId])).rows[0]?.id;
  return id ? diagnosis(db, id) : null;
}
