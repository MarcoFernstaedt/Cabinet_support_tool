// Test a real cabinet: runs the read-only checks the console depends on, one after another, against the actual machine, and says for each
// what it read or why it could not. Nothing here changes the cabinet. It is how you confirm a freshly installed agent is doing the real
// thing (event logs, services, firewall, the network and the path to the platform) and not simulated data. "Copy results" gives a plain
// report to paste into a ticket.
import { useEffect, useRef, useState } from "react";
import { useRunner } from "../lib/commands";
import { Badge } from "./ui";

type Out = Record<string, unknown>;
interface Check { id: string; label: string; operation: string; params: Record<string, unknown>; summarize: (o: Out) => { ok: boolean; text: string } }

const arr = (v: unknown): Out[] => (Array.isArray(v) ? (v as Out[]) : []);
const n = (v: unknown) => (typeof v === "number" ? v : 0);

export const CHECKS: Check[] = [
  { id: "info", label: "System information", operation: "system.info", params: {},
    summarize: o => ({ ok: typeof o.hostname === "string", text: `${String(o.hostname)}, ${String(o.osVersion)} (build ${String(o.osBuild)}), agent ${String(o.agentVersion)}, up ${Math.round(n(o.uptimeSeconds) / 3600)} h, ${o.readOnlyMode ? "read-only" : "changes allowed"}` }) },
  { id: "logs", label: "Event logs that can be read", operation: "eventlog.channels", params: {},
    summarize: o => { const c = arr(o.channels).filter(x => x.available); return { ok: c.length > 0, text: `${c.length} logs available: ${c.slice(0, 4).map(x => `${String(x.log)} (${n(x.entryCount)} entries)`).join(", ")}${c.length > 4 ? ", …" : ""}` }; } },
  { id: "system-log", label: "Recent System log errors", operation: "eventlog.query", params: { log: "System", levels: ["error", "critical", "warning"] },
    summarize: o => { const e = arr(o.entries); return { ok: true, text: e.length === 0 ? "No errors or warnings in what the log returned." : `${e.length} ${e.length === 1 ? "entry" : "entries"}; newest: ${String(e[0]!.source)} event ${String(e[0]!.eventId)} at ${String(e[0]!.time)}: ${String(e[0]!.firstLine)}` }; } },
  { id: "app-log", label: "Recent Application log errors", operation: "eventlog.query", params: { log: "Application", levels: ["error", "critical"] },
    summarize: o => { const e = arr(o.entries); return { ok: true, text: e.length === 0 ? "No errors in what the log returned." : `${e.length} ${e.length === 1 ? "entry" : "entries"}; newest: ${String(e[0]!.source)} event ${String(e[0]!.eventId)} at ${String(e[0]!.time)}` }; } },
  { id: "services", label: "Windows services", operation: "services.list", params: {},
    summarize: o => { const s = arr(o.services); return { ok: s.length > 0, text: `${s.length} services, ${s.filter(x => x.state === "running").length} running` }; } },
  { id: "firewall", label: "Windows firewall", operation: "firewall.state", params: {},
    summarize: o => { const p = arr(o.profiles); return { ok: p.length === 3, text: `${p.map(x => `${String(x.profile)} ${x.enabled ? "on" : "off"}`).join(", ")}; ${arr(o.rules).length} rules read` }; } },
  { id: "time", label: "Time and time zone", operation: "time.status", params: {},
    summarize: o => ({ ok: typeof o.timeZoneId === "string", text: `${String(o.timeZoneName)} (${String(o.timeZoneId)}), local time ${String(o.localTime)}` }) },
  { id: "net", label: "Network adapters, leases, routes and ARP", operation: "network.config", params: {},
    summarize: o => { const a = arr(o.adapters).filter(x => x.connected); const first = a[0] as { ipv4?: { addresses?: { address: string }[]; gateways?: string[] }; details?: { leaseExpires?: string | null } } | undefined;
      return { ok: a.length > 0, text: `${a.length} connected ${a.length === 1 ? "adapter" : "adapters"}; ${first?.ipv4?.addresses?.[0]?.address ?? "no address"} via ${first?.ipv4?.gateways?.[0] ?? "no gateway"}; ${arr(o.routes).length} routes, ${arr(o.neighbors).length} ARP entries${first?.details?.leaseExpires ? `; lease ends ${first.details.leaseExpires}` : ""}` }; } },
  { id: "ping", label: "Ping the gateway (4 requests)", operation: "network.test", params: { target: "gateway", method: "ping", count: 4 },
    summarize: o => { const s = o.statistics as { received: number; sent: number; lossPercent: number; avgMs: number | null } | null | undefined;
      return { ok: o.success === true, text: o.success ? `${s ? `${s.received} of ${s.sent} replies, ${s.lossPercent}% lost, average ${s.avgMs ?? "?"} ms` : `reached in ${String(o.latencyMs)} ms`}` : `no answer${o.error ? `: ${String(o.error)}` : ""}` }; } },
  { id: "dns", label: "Resolve the platform server's name", operation: "network.test", params: { target: "platform_server", method: "dns" },
    summarize: o => ({ ok: o.success === true, text: o.success ? `resolved${(Array.isArray(o.resolvedAddresses) && o.resolvedAddresses.length > 0) ? ` to ${(o.resolvedAddresses as string[]).join(", ")}` : ""}` : `failed${o.error ? `: ${String(o.error)}` : ""}` }) },
  { id: "trace", label: "Path to the platform server", operation: "network.trace", params: { target: "platform_server" },
    summarize: o => { const h = arr(o.hops); return { ok: h.some(x => x.address), text: `${h.length} hops, ${o.reached ? "reached" : "did not reach"} ${String(o.resolvedTarget ?? "")}${o.error ? ` (${String(o.error)})` : ""}` }; } },
];

type State = { status: "waiting" | "running" | "passed" | "failed"; text: string; ms: number | null; raw: string | null };

export function LiveCheck({ cabinetId, cabinetName, simulated = false }: { cabinetId: string; cabinetName: string; simulated?: boolean }) {
  const run = useRunner();
  const section = useRef<HTMLElement>(null);
  // The guided demo links here with #live-check, so the panel is on screen when the step opens.
  useEffect(() => { if (window.location.hash === "#live-check") section.current?.scrollIntoView({ block: "start" }); }, []);
  const [rows, setRows] = useState<Record<string, State>>({});
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const set = (id: string, s: State) => setRows(r => ({ ...r, [id]: s }));
  const start = async () => {
    setBusy(true); setCopied(false); setRows(Object.fromEntries(CHECKS.map(c => [c.id, { status: "waiting", text: "", ms: null, raw: null } as State])));
    for (const c of CHECKS) {
      set(c.id, { status: "running", text: "Asking the cabinet…", ms: null, raw: null });
      const t0 = Date.now();
      try {
        const r = await run<Out>(cabinetId, c.operation, c.params);
        const ms = Date.now() - t0;
        if (r.status === "succeeded" && r.output) {
          const s = c.summarize(r.output);
          set(c.id, { status: s.ok ? "passed" : "failed", text: s.text, ms, raw: JSON.stringify(r.output, null, 2).slice(0, 6000) });
        } else set(c.id, { status: "failed", text: `${r.status}${r.error ? `: ${r.error.code}: ${r.error.message}` : ""}`, ms, raw: null });
      } catch (e) { set(c.id, { status: "failed", text: e instanceof Error ? e.message : "could not ask the cabinet", ms: Date.now() - t0, raw: null }); }
    }
    setBusy(false);
  };
  const finished = CHECKS.filter(c => rows[c.id] && rows[c.id]!.status !== "waiting" && rows[c.id]!.status !== "running").length;
  const passed = CHECKS.filter(c => rows[c.id]?.status === "passed").length;
  const report = () => [`Live check of ${cabinetName} at ${new Date().toISOString()}`, ...CHECKS.map(c => `${rows[c.id]?.status === "passed" ? "PASS" : rows[c.id]?.status === "failed" ? "FAIL" : "----"}  ${c.label} (${c.operation}): ${rows[c.id]?.text ?? ""}`)].join("\n");
  const copy = async () => { try { await navigator.clipboard.writeText(report()); setCopied(true); } catch { setCopied(false); } };
  return (
    <section className="panel" aria-labelledby="live-check" ref={section}>
      <div className="panel-head">
        <div>
          <h2 id="live-check">Test {cabinetName}</h2>
          <p className="muted small">Runs read-only checks on the real machine, one after another: system information, event logs, services, firewall, time, the network (adapters, gateway ping, name lookup) and the path to the platform. It changes nothing. Each says what it read, or why it could not.{simulated && <> This is a simulated cabinet, so the answers are made up; on a live agent they come from the machine.</>}</p>
        </div>
        <button className="btn primary" data-tour="live-run" onClick={() => void start()} disabled={busy}>{busy ? `Running ${finished + 1} of ${CHECKS.length}…` : finished > 0 ? "Run again" : "Run the checks"}</button>
      </div>
      {finished > 0 && <p role="status" className="small"><Badge tone={passed === CHECKS.length ? "ok" : finished === CHECKS.length ? "warn" : "info"}>{passed} of {CHECKS.length} passed</Badge> {!busy && <button className="btn small ghost" onClick={() => void copy()}>{copied ? "Copied" : "Copy results"}</button>}</p>}
      <ul className="plain live-check">{CHECKS.map(c => {
        const r = rows[c.id];
        return (
          <li key={c.id} className="row gap wrap">
            <span style={{ minWidth: "5.5rem" }}>{!r ? <Badge tone="off">Not run</Badge> : r.status === "passed" ? <Badge tone="ok">Passed</Badge> : r.status === "failed" ? <Badge tone="crit">Failed</Badge> : r.status === "running" ? <Badge tone="info">Running</Badge> : <Badge tone="off">Waiting</Badge>}</span>
            <strong>{c.label}</strong> <code className="small muted">{c.operation}</code>
            {r?.ms != null && <span className="muted small">{(r.ms / 1000).toFixed(1)} s</span>}
            {r?.text && <div className="small" style={{ flexBasis: "100%" }}>{r.text}</div>}
            {r?.raw && <details style={{ flexBasis: "100%" }}><summary className="small">What the cabinet sent</summary><pre className="small" style={{ maxHeight: "16rem", overflow: "auto" }}>{r.raw}</pre></details>}
          </li>);
      })}</ul>
    </section>
  );
}
