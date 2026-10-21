// What a simulated cabinet reports as its configuration (docs/spec/15-baselines-and-config.md), built from the same simulated reads a
// technician would run one by one, by the same rules as the agent's ConfigBuilders (agent/src/Cabinet.Agent.Core/Configuration):
// keys are stable names, values are flat, and nothing that changes by itself is included. The result goes through the server's own
// ingest (hash recomputed, change-only), exactly as an agent's upload does. The demo also seeds a few approved baselines, so the
// cabinets show "should be", "is" and "changed" next to each other: one cabinet (a sync cabinet whose firewall was switched on) differs.
import { audit, transaction, type Pool, type Queryable } from "../db/db.js";
import { configHash, type Item } from "../services/config-canonical.js";
import { createDraft } from "../services/baselines.js";
import { ingestAndEvaluate } from "../services/config-service.js";
import { CATEGORIES, unpackItems, type Category } from "../services/config-ingest.js";
import { demoOutput, type DemoContext } from "./outputs.js";

type Out = Record<string, any>;
type Values = Item["values"];
const MAX_ITEMS = 2000;
const text = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim().length > 0 ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : null);
const key = (prefix: string, name: unknown): string | null => { const t = text(typeof name === "string" ? name.replace(/[<>]/g, " ") : name, 180); return t === null ? null : `${prefix}:${t}`; };
const item = (k: string | null, values: Record<string, unknown>): Item | null => {
  if (k === null) return null;
  const v: Values = {};
  for (const [name, value] of Object.entries(values)) if (value !== null && value !== undefined) v[name] = value as never;
  return { key: k, values: v };
};
const day = (t: unknown) => (typeof t === "string" ? t.slice(0, 10) : null);

/** Sorts, makes keys unique, caps, and hashes (ConfigBuilders.Make). */
export function makeCategory(category: Category, items: (Item | null)[]) {
  const sorted = items.filter((i): i is Item => i !== null).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const seen = new Set<string>(), unique: Item[] = [];
  for (const i of sorted) { let k = i.key; for (let n = 2; seen.has(k); n++) k = `${i.key}#${n}`; seen.add(k); unique.push(k === i.key ? i : { ...i, key: k }); }
  const truncated = unique.length > MAX_ITEMS;
  const kept = truncated ? unique.slice(0, MAX_ITEMS) : unique;
  return { category, hash: configHash(kept), truncated, items: kept };
}

const serviceState = (s: string) => (["running", "start_pending", "continue_pending"].includes(s) ? "running" : ["stopped", "stop_pending"].includes(s) ? "stopped" : ["paused", "pause_pending"].includes(s) ? "paused" : "unknown");

/** The configuration of one simulated cabinet, by category, from its simulated reads. */
export function demoCategories(ctx: DemoContext, wanted?: readonly string[]) {
  const read = (op: string): Out => demoOutput(op, {}, ctx) as Out;
  const build: Record<Category, () => ReturnType<typeof makeCategory>> = {
    network: () => {
      const o = read("network.config");
      const names = new Map<number, string>((o.adapters as Out[]).map(a => [a.interfaceIndex, a.name]));
      const adapters = (o.adapters as Out[]).map(a => item(key("adapter", a.name), { type: a.type, connected: a.connected, dhcp: a.ipv4.dhcp, dhcpServer: a.details?.dhcpServer ?? null,
        addresses: a.ipv4.addresses.map((x: Out) => `${x.address}/${x.prefixLength}`), gateways: a.ipv4.gateways, dnsServers: a.dns.servers, dnsAutomatic: a.dns.automatic, dnsSuffix: text(a.dnsSuffix),
        linkSpeedMbps: a.linkSpeedBps ? Math.min(2_147_483_647, Math.floor(a.linkSpeedBps / 1_000_000)) : null, mac: text(a.macAddress, 32), interfaceIndex: a.interfaceIndex,
        metric: a.details?.interfaceMetric ?? null, mtu: a.details?.mtu ?? null, networkProfile: text(a.details?.networkProfile?.category, 32), driverVersion: text(a.details?.driver?.version) }));
      const routes = ((o.routes ?? []) as Out[]).filter(r => !r.destination.startsWith("127.") && !(r.prefixLength === 32 && r.nextHop === "0.0.0.0"))
        .map(r => item(key("route", `${r.destination}/${r.prefixLength} via ${r.nextHop}`), { metric: r.metric, adapter: text(names.get(r.interfaceIndex)) }));
      return makeCategory("network", [...adapters, ...routes]);
    },
    services: () => makeCategory("services", (read("services.list").services as Out[]).map(s => item(key("service", s.name), { startType: s.startType, state: serviceState(s.state), account: text(s.account), path: text(s.executablePath) }))),
    drivers: () => makeCategory("drivers", (read("drivers.list").drivers as Out[]).map(d => item(key("driver", d.publishedName), { originalName: text(d.originalName), version: text(d.version), date: day(d.date),
      provider: text(d.provider), class: text(d.className), signer: text(d.signer) }))),
    updates: () => makeCategory("updates", (read("updates.status").installed as Out[]).map(u => item(key("update", u.kb ?? u.title), { title: text(u.title), installedAt: u.installedAt ? String(u.installedAt).slice(0, 19) + "Z" : null, result: u.result }))),
    firewall: () => {
      const o = read("firewall.state");
      return makeCategory("firewall", [
        ...(o.profiles as Out[]).map(p => item(`profile:${p.profile}`, { enabled: p.enabled, defaultInbound: p.defaultInbound, defaultOutbound: p.defaultOutbound })),
        ...(o.rules as Out[]).map(r => item(key("rule", r.name), { enabled: r.enabled, direction: r.direction, action: r.action, protocol: text(r.protocol, 32), localPorts: text(r.localPorts), remotePorts: text(r.remotePorts),
          localAddresses: text(r.localAddresses), remoteAddresses: text(r.remoteAddresses), program: text(r.programPath), profiles: r.profiles ?? null, platform: r.createdByPlatform })),
      ]);
    },
    time: () => { const t = read("time.status"); return makeCategory("time", [item("time", { timeZoneId: text(t.timeZoneId, 64), syncSource: text(t.sync?.source), timeService: t.timeService, policyManaged: t.policyManaged })]); },
    devices: () => makeCategory("devices", (read("devices.list").devices as Out[]).map(d => item(key("device", d.instanceId), { class: text(d.class), name: text(d.name), status: text(d.status, 64),
      errorCode: typeof d.errorCode === "number" && d.errorCode >= 0 && d.errorCode <= 2_147_483_647 ? d.errorCode : null, driver: text(d.driver?.name), driverVersion: text(d.driver?.version) }))),
    applications: () => {
      const best = new Map<string, Out>();
      for (const p of read("software.list").programs as Out[]) { const n = text(p.name); if (n && (!best.has(n) || String(p.version ?? "") > String(best.get(n)!.version ?? ""))) best.set(n, p); }
      return makeCategory("applications", [...best].map(([n, p]) => item(key("app", n), { version: text(p.version), publisher: text(p.publisher) })));
    },
    hosts: () => {
      const byAddress = new Map<string, Set<string>>();
      for (const e of read("network.hosts").entries as Out[]) { const set = byAddress.get(e.address) ?? new Set<string>(); for (const n of e.names as string[]) set.add(n); byAddress.set(e.address, set); }
      return makeCategory("hosts", [...byAddress].map(([a, names]) => item(key("host", a), { names: [...names].sort().slice(0, 32) })));
    },
    tasks: () => {
      const o = read("startup.list");
      return makeCategory("tasks", [
        ...(o.tasks as Out[]).map(t => item(key("task", `${t.path}${t.name}`), { state: t.state })),
        ...(o.startup as Out[]).map(s => item(key("startup", `${s.location}/${s.name}`), { program: text(programOf(String(s.command))) })),
      ]);
    },
    system: () => {
      const h = read("system.hardware"), id = read("system.identity");
      const admins = ((id.localAdministrators?.names ?? []) as string[]).map(n => (n.toLowerCase().startsWith(ctx.hostname.toLowerCase() + "\\") ? ".\\" + n.slice(ctx.hostname.length + 1) : n)).sort();
      return makeCategory("system", [
        item("hardware", { manufacturer: text(h.manufacturer), model: text(h.model), biosVendor: text(h.bios?.vendor), biosVersion: text(h.bios?.version), biosDate: day(h.bios?.date), cpu: text(h.cpu?.model),
          logicalCores: h.cpu?.logicalCores ?? null, memoryMb: h.memory?.totalBytes ? Math.floor(h.memory.totalBytes / 1_048_576) : null, memoryModules: h.memory?.moduleCount ?? null,
          tpmPresent: h.tpm ? h.tpm.present : null, tpmEnabled: h.tpm?.enabled ?? null, tpmVersion: text(h.tpm?.version, 32), secureBoot: h.secureBoot ?? null }),
        item("identity", { joinType: id.joinType, name: text(id.name), domainControllerFound: id.domainControllerFound ?? null, autoLogon: id.autoLogon?.enabled ?? null, autoLogonUser: text(id.autoLogon?.userName),
          localAdministrators: admins.slice(0, 32), localAdministratorsTruncated: admins.length > 32 }),
      ]);
    },
  };
  return CATEGORIES.filter(c => !wanted || wanted.includes(c)).map(c => build[c]());
}

/** The program of a startup command, never its arguments: a quoted path, or up to ".exe", or the first word. */
export function programOf(command: string): string {
  const c = command.trim();
  if (c.startsWith('"')) { const end = c.indexOf('"', 1); return end > 1 ? c.slice(1, end) : c.slice(1); }
  const exe = c.toLowerCase().indexOf(".exe");
  if (exe > 0) return c.slice(0, exe + 4);
  const space = c.indexOf(" ");
  return space > 0 ? c.slice(0, space) : c;
}

/** config.snapshot as a simulated cabinet answers it. */
export function demoConfigOutput(ctx: DemoContext, categories?: readonly string[]) {
  return { takenAt: ctx.now.toISOString().replace(/\.\d{3}Z$/, "Z"), categories: demoCategories(ctx, categories) };
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Uploads a simulated cabinet's configuration the way its agent would (change-only; the first look is the starting point). */
export async function uploadDemoConfig(pool: Pool, cabinetId: string, ctx: DemoContext, observedAt = Date.now(), overrides?: Partial<Record<Category, ReturnType<typeof makeCategory>>>): Promise<void> {
  const categories = demoCategories({ ...ctx, now: new Date(observedAt) }).map(c => overrides?.[c.category] ?? c);
  await ingestAndEvaluate(pool, cabinetId, categories.map(c => ({ observedAt: iso(observedAt), ...c })) as never, "agent");
}

// ---- The approved baselines the demo starts with ---------------------------------------------------------------------------------

/** Makes a draft with the real service, then moves it through the states a decision does (the demo has no second person to approve). */
async function approvedBaseline(pool: Pool, adminId: string, scope: { kind: "global" | "model" | "client" | "site" | "cabinet"; id: string | null }, description: string, content: Parameters<typeof createDraft>[2]["content"]): Promise<void> {
  const d = await createDraft(pool, { userId: adminId, role: "admin" }, { scope, description, content });
  await transaction(pool, async (c: Queryable) => {
    await c.query("UPDATE baseline_versions SET status = 'pending', proposed_at = SYSUTCDATETIME() WHERE id = $1", [d.id]);
    await c.query("UPDATE baseline_versions SET status = 'approved', decided_by = $2, decided_at = SYSUTCDATETIME(), decision_note = $3 WHERE id = $1", [d.id, adminId, "Approved for the demonstration."]);
    await audit(c, { actorKind: "user", actorId: adminId, action: "baseline.approve", targetKind: "baseline", targetId: d.baselineId, outcome: "succeeded", details: { versionId: d.id, version: d.version, demo: true } });
  });
}

/**
 * Baselines for the demo fleet, all tied to simulated clients and sites (so turning demo mode off deletes them with their sites): one for the
 * client, and one for each of two sites, taken from a working cabinet there (Exam Room 1, Surgery) and trimmed, as a technician would.
 */
export async function seedDemoBaselines(pool: Pool, adminId: string, clientId: string | null, sites: { siteId: string; cabinetId: string; timeZone: string }[]): Promise<void> {
  if (clientId)
    await approvedBaseline(pool, adminId, { kind: "client", id: clientId }, "Every cabinet keeps the clock and the DNS client running.", { items: [
      { category: "services", key: "service:W32Time", mode: "match", expect: { startType: "automatic", state: "running" }, required: true, severity: "major", note: "Windows Time keeps the clock right." },
      { category: "services", key: "service:Dnscache", mode: "match", expect: { startType: "automatic", state: "running" }, severity: "minor" },
      { category: "hosts", key: "host:127.0.0.1", mode: "match", expect: { names: ["localhost"] }, severity: "minor" }] });
  for (const site of sites) {
    const net = (await pool.query<{ items: Buffer }>("SELECT v.items FROM config_current c JOIN config_versions v ON v.id = c.version_id WHERE c.cabinet_id = $1 AND c.category = 'network'", [site.cabinetId])).rows[0];
    const adapter = net ? unpackItems(net.items).find(i => i.key.startsWith("adapter:") && i.values.connected === true) : undefined;
    const expectNet = adapter ? Object.fromEntries(Object.entries(adapter.values).filter(([k]) => ["dhcp", "dnsServers", "dnsAutomatic", "gateways"].includes(k)) as [string, never][]) : null;
    await approvedBaseline(pool, adminId, { kind: "site", id: site.siteId }, "Captured from a working cabinet at this site, then trimmed.", { items: [
      ...(adapter && expectNet ? [{ category: "network" as const, key: adapter.key, mode: "match" as const, expect: expectNet, severity: "major" as const }] : []),
      { category: "services", key: "service:BioScanSvc", mode: "match", expect: { startType: "automatic", state: "running" }, required: true, severity: "major", note: "The fingerprint scanner's service." },
      { category: "firewall", key: "profile:domain", mode: "match", expect: { enabled: false }, severity: "major" },
      { category: "firewall", key: "profile:private", mode: "match", expect: { enabled: false }, severity: "major" },
      { category: "firewall", key: "profile:public", mode: "match", expect: { enabled: false }, required: true, severity: "major", note: "The client's policy keeps the profiles off on a sync network." },
      { category: "time", key: "time", mode: "match", expect: { timeZoneId: site.timeZone }, severity: "minor" }] });
  }
}
