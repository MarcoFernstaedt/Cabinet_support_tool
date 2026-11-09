// What solved this problem before. A fix saved from one cabinet shows up wherever the same problem is seen again, with the environment it
// was seen in next to this cabinet's, so a person can tell whether it is likely to apply. Saved by Tier 1 and up; removed by Tier 2 and up.
import { useEffect, useState } from "react";
import { api, describeError } from "../lib/api";
import { useAction } from "../lib/useAction";
import { useLoad } from "../lib/useLoad";
import { atLeast, useSession } from "../lib/session";
import { architectureDetail } from "../lib/architecture";
import { fullTime } from "../lib/time";
import { Link } from "../lib/router";
import { Badge, ConfirmDialog } from "./ui";

interface Environment {
  client: string; site: string; role: string; agentVersion: string | null; timeZone: string | null;
  /**
   * Which Windows the installed agent was built for, when the record says (docs/platform/archive/second-architecture.md).
   * Optional because a fix saved by an agent built before cabinets reported one has no value to show.
   */
  architecture?: string | null;
  firewall: { domain: boolean; private: boolean; public: boolean } | null;
  network: { addressing: "dhcp" | "static"; gateway: string | null; dnsServers: string[]; linkSpeedMbps: number | null; adapter: string | null; mtu: number | null } | null;
}
export interface KnownFix { id: string; title: string; solution: string; symptom: { kind: "finding"; key: string } | { kind: "issue"; issueTypeId: string }; environment: Environment;
  savedBy: string; savedAt: string; fromCabinet: string | null; seenCount: number;
  status: "pending" | "approved" | "rejected"; submittedBy: string; reviewedBy: string | null; reviewedAt: string | null; reviewNote: string | null }
export type { Environment };
export type Symptom = { kind: "finding"; key: string } | { kind: "issue"; issueTypeId: string };

/** A finding's key: "obs-errors-12" and "obs-errors-3" are the same kind of problem. */
export function findingKey(id: string): string {
  const i = id.lastIndexOf("-");
  return i > 0 && i < id.length - 1 && [...id.slice(i + 1)].every(ch => ch >= "0" && ch <= "9") ? id.slice(0, i) : id;
}

/** Plain names for the problems a diagnosis can key a fix to. */
export const KEY_LABEL: Record<string, string> = {
  "obs-ping-loss": "Packet loss to the gateway", "obs-ping-slow": "Slow replies from the gateway", "obs-ping-jitter": "Uneven replies from the gateway", "obs-errors": "Errors on the network card",
  "obs-lease": "DHCP lease", "obs-mtu": "Packet size (MTU)", "obs-arp": "Neighbours that do not answer", "obs-routes": "More than one default route", "obs-trace-sync": "Path to the sync cabinet",
  "obs-trace-platform": "Path to the platform server", "sync-firewall": "Firewall blocks the sync cabinet's ports", "sync-down": "Sync cabinet does not answer", firewall: "Firewall differs from its policy",
  link: "Network link", ip: "No DHCP lease", gateway: "Gateway does not answer", "baseline-dns": "DNS differs from the site baseline", "baseline-gateway": "Wrong gateway", "baseline-subnet": "Address outside the site's network",
};
export const symptomLabel = (s: KnownFix["symptom"] & { issueName?: string | null }) => s.kind === "finding" ? (KEY_LABEL[s.key] ?? s.key) : (s.issueName ?? "An issue type");

const profiles = (f: Environment["firewall"]) => f ? (["domain", "private", "public"] as const).map(k => `${k} ${f[k] ? "on" : "off"}`).join(", ") : "unknown";

/** The setup a fix was saved from, as labelled rows. */
export const environmentRows = (e: Environment): [string, string][] => [
  ["Site", `${e.client} / ${e.site} (${e.role})`], ["Agent", e.agentVersion ?? "unknown"], ["Architecture", architectureDetail(e.architecture)], ["Time zone", e.timeZone ?? "unknown"], ["Firewall", profiles(e.firewall)],
  ["Network", e.network ? `${e.network.addressing === "dhcp" ? "DHCP" : "Fixed"}, gateway ${e.network.gateway ?? "none"}, DNS ${e.network.dnsServers.join(", ") || "none"}${e.network.linkSpeedMbps ? `, ${e.network.linkSpeedMbps} Mbps` : ""}${e.network.adapter ? `, ${e.network.adapter}` : ""}` : "Not read"],
];

/** What differs between the environment a fix was saved in and this cabinet's now; empty means the same. */
export function differences(then: Environment, now: Environment): string[] {
  const d: string[] = [];
  const same = <T,>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);
  if (then.role !== now.role) d.push(`Role: ${then.role} then, ${now.role} now`);
  if (then.agentVersion !== now.agentVersion) d.push(`Agent: ${then.agentVersion ?? "unknown"} then, ${now.agentVersion ?? "unknown"} now`);
  if (then.timeZone !== now.timeZone) d.push(`Time zone: ${then.timeZone ?? "unknown"} then, ${now.timeZone ?? "unknown"} now`);
  if (!same(then.firewall, now.firewall)) d.push(`Firewall: ${profiles(then.firewall)} then, ${profiles(now.firewall)} now`);
  const a = then.network, b = now.network;
  if (a && b) {
    if (a.addressing !== b.addressing) d.push(`Addressing: ${a.addressing === "dhcp" ? "DHCP" : "fixed"} then, ${b.addressing === "dhcp" ? "DHCP" : "fixed"} now`);
    if (a.linkSpeedMbps !== b.linkSpeedMbps) d.push(`Link speed: ${a.linkSpeedMbps ?? "unknown"} Mbps then, ${b.linkSpeedMbps ?? "unknown"} now`);
    if (a.adapter !== b.adapter) d.push(`Network card: ${a.adapter ?? "unknown"} then, ${b.adapter ?? "unknown"} now`);
    if (a.mtu !== b.mtu) d.push(`Packet size (MTU): ${a.mtu ?? "unknown"} then, ${b.mtu ?? "unknown"} now`);
  } else if (a || b) d.push(a ? "Network was read then, not now" : "Network was not read then, but is now");
  return d;
}

/** The fixes saved for this problem, if any. */
export function KnownFixes({ symptom, cabinetId, reloadKey }: { symptom: Symptom; cabinetId: string; reloadKey?: number }) {
  const { me } = useSession();
  const query = symptom.kind === "finding" ? `findingKey=${encodeURIComponent(symptom.key)}` : `issueTypeId=${symptom.issueTypeId}`;
  const { data, reload } = useLoad<{ fixes: KnownFix[]; now: Environment | null }>(`/api/known-fixes?${query}&cabinetId=${cabinetId}`);
  useEffect(() => { if (reloadKey) reload(); }, [reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const { run, problem } = useAction();
  if (!data || data.fixes.length === 0) return null;
  const remove = async (id: string) => { if (await run(() => api("POST", `/api/known-fixes/${id}/remove`, {}))) reload(); };
  return (
    <div className="known-fixes" aria-label="Fixes saved for this problem">
      {data.fixes.slice(0, 3).map(f => {
        const diff = data.now ? differences(f.environment, data.now) : [];
        if (f.status !== "approved") return (
          <div key={f.id} className={`notice ${f.status === "pending" ? "warn" : "crit"}`}>
            <div className="row gap wrap"><Badge tone={f.status === "pending" ? "warn" : "crit"}>{f.status === "pending" ? "Waiting for approval" : "Not approved"}</Badge> <strong>{f.title}</strong></div>
            <p className="muted small">{f.status === "pending" ? "Only you can see this until an Admin approves it." : <>{f.reviewedBy ?? "A reviewer"} did not approve it{f.reviewNote ? `: ${f.reviewNote}` : "."}</>}</p>
          </div>);
        return (
          <div key={f.id} className="notice ok">
            <div className="row gap wrap"><Badge tone="ok">Possible fix</Badge> <strong>{f.title}</strong></div>
            <p className="pre">{f.solution}</p>
            <p className="muted small">Worked before: saved by {f.savedBy} on {fullTime(f.savedAt)}{f.fromCabinet ? <> at {f.fromCabinet} ({f.environment.site})</> : null}. {f.seenCount > 0 && <> Shown {f.seenCount} {f.seenCount === 1 ? "time" : "times"} since.</>}</p>
            {data.now && (diff.length === 0
              ? <p className="small">This cabinet's setup matches the one it was fixed on.</p>
              : <details><summary className="small">{diff.length} {diff.length === 1 ? "difference" : "differences"} from the cabinet it was fixed on</summary><ul className="plain small">{diff.map(x => <li key={x}>{x}</li>)}</ul></details>)}
            {atLeast(me, "tier2") && <button className="btn small ghost" onClick={() => void remove(f.id)}>Remove this fix</button>}
          </div>);
      })}
      {data.fixes.length > 3 && <p className="muted small">{data.fixes.length - 3} more saved for this problem.</p>}
      {problem && <p className="error" role="alert">{problem}</p>}
    </div>
  );
}

/** "Save what fixed this": the person types what worked; the platform records the cabinet's setup with it. */
export function SaveFix({ symptom, cabinetId, suggestedTitle, alertId, onSaved }: { symptom: Symptom; cabinetId: string; suggestedTitle: string; alertId?: string; onSaved?: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(suggestedTitle.slice(0, 120));
  const [solution, setSolution] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<"approved" | "pending" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { me } = useSession();
  // Only a new fix is worth saving: when this problem already has a saved fix (approved or waiting), there is nothing to add.
  const query = symptom.kind === "finding" ? `findingKey=${encodeURIComponent(symptom.key)}` : `issueTypeId=${symptom.issueTypeId}`;
  const { data: existing } = useLoad<{ fixes: KnownFix[] }>(`/api/known-fixes?${query}&cabinetId=${cabinetId}`);
  if (saved) return <p className="ok small" role="status">{saved === "approved" ? "Saved. This is shown the next time the same problem comes up." : "Sent for approval. It is shown to everyone once an Admin approves it."}</p>;
  if (!existing || existing.fixes.length > 0) return null;
  if (!open) return <button className="btn small ghost" onClick={() => setOpen(true)}>Save what fixed this…</button>;
  const save = async () => {
    setProblem(null);
    try { const r = await api<{ status: "approved" | "pending" }>("POST", "/api/known-fixes", { title: title.trim(), solution: solution.trim(), symptom, cabinetId, ...(alertId ? { alertId } : {}) }); setSaved(r.status === "approved" ? "approved" : "pending"); window.dispatchEvent(new Event("fixes-changed")); onSaved?.(); }
    catch (err) { setProblem(describeError(err)); throw err; }
  };
  return (<>
    <form className="stack" onSubmit={e => {
      e.preventDefault();
      // Someone who can approve fixes needs no approval: it is logged, and they confirm it first. Everyone else sends it for approval.
      if (me.canApproveFixes) setConfirming(true); else void save().catch(() => undefined);
    }}>
      <label className="field"><span>Name</span><input required maxLength={120} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label className="field"><span>What fixed it</span><textarea required rows={3} maxLength={2000} value={solution} onChange={e => setSolution(e.target.value)} placeholder="Swapped the patch cable and moved the port on the switch; the errors stopped." /></label>
      {problem && <p className="error" role="alert">{problem}</p>}
      <div className="row gap"><button className="btn primary small" disabled={!title.trim() || !solution.trim()}>{me.canApproveFixes ? "Save…" : "Send for approval"}</button><button type="button" className="btn ghost small" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
    <ConfirmDialog open={confirming} title="Save this fix?" confirmLabel="Save the fix" onClose={() => setConfirming(false)} onConfirm={save}
        description={<><p>“{title.trim()}” is shown to everyone the next time this problem comes up, with the setup it was fixed on. It does not need approval because you can approve fixes; it is logged under your name and stays until a Tier 2 or an Admin removes it.</p></>} />
  </>);
}

/** The nav link for people who approve fixes, with how many are waiting. */
export function FixesLink({ current }: { current: boolean }) {
  const [count, setCount] = useState<number | null>(null);
  const load = () => { api<{ pending: number }>("GET", "/api/known-fixes/summary", undefined, { background: true }).then(s => setCount(s.pending), () => undefined); };
  useEffect(() => { load(); const t = setInterval(load, 60_000); window.addEventListener("fixes-changed", load); return () => { clearInterval(t); window.removeEventListener("fixes-changed", load); }; }, []);
  return (
    <Link to="/fixes" aria-current={current ? "page" : undefined}>
      Fixes{count !== null && count > 0 && <> <span className="badge warn count">{count}<span className="sr-only"> {count === 1 ? "fix" : "fixes"} waiting for approval</span></span></>}
    </Link>
  );
}
