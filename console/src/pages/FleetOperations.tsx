// Fleet operations (docs/spec/13-roadmap.md modules 21 and 45): choose cabinets by client, site, problem or by hand,
// preview what one fixed operation would do on each (and what it would skip, and why), confirm with the password, then
// follow the job: each cabinet's result and whether its next report verified the change. The selection survives moving
// around the console in this tab. A bulk change covers the cabinets of one site: choose the site, then tick the cabinets in it
// (3 of 8, say). The server checks the role, the confirmation, the one-site rule, the limits and the pauses again.
import { useEffect, useMemo, useState } from "react";
import { api, describeError } from "../lib/api";
import { Link, useRouter } from "../lib/router";
import { useLoad } from "../lib/useLoad";
import { fullTime, ago } from "../lib/time";
import { Breadcrumbs } from "../components/Layout";
import { Pager, usePaged } from "../components/Pager";
import { Badge, Empty, OnlineBadge, PasswordDialog } from "../components/ui";
import { DemoTag } from "../components/DemoBanner";
import { ZONE_NAMES } from "./cabinet/Time";
import { useStartDiagnosis } from "./NetworkDiagnosis";
import { keepFollowing, phaseText } from "../lib/fleet-job-status";

type Operation = "time.setZone" | "time.sync" | "firewall.applyPolicy";
const OPERATIONS: [Operation, string, string][] = [
  ["time.setZone", "Set each cabinet to its site's time zone", "Each cabinet gets its own site's zone; cabinets already in it, or whose site has none set, are skipped."],
  ["time.sync", "Sync clocks", "Windows Time synchronizes with its configured source; the source is not changed."],
  ["firewall.applyPolicy", "Apply the firewall policy", "Each cabinet gets the firewall policy that applies to it (its site's, else its client's, else the fleet default); cabinets that already match are skipped. The safety net applies."],
];
/** Network fixes come from a network diagnosis (they need its findings), so they are started from its page; they are named here for the job page. */
const JOB_NAMES: Record<string, string> = { "network.setDns": "Set the DNS servers", "network.setIp": "Fix the address settings", "network.renewLease": "Renew the DHCP lease" };
const PROBLEMS: [string, string][] = [["any", "Any cabinet"], ["time_zone_wrong", "Wrong time zone"], ["clock_off", "Clock is off"], ["firewall_drift", "Firewall differs from policy"]];
const LIMIT = 200;

interface Row { id: string; name: string; role: string; site: { id: string; name: string; timeZone: string | null }; client: { id: string; name: string }; demo: boolean;
  readOnly: boolean | null; online: boolean; timeZoneId: string | null; clockSkewSeconds: number | null; ipv4: string | null; openAlerts: number }
interface Preview { planDigest: string; operation: Operation; change: number; skip: number; cabinets: { id: string; name: string; role?: string; site: string; client: string; ipv4: string | null; params: unknown; skip: string | null }[] }
interface SiteOption { id: string; name: string; client: { id: string; name: string }; demo: boolean; cabinets: number }

interface CabinetLimit { shown: number; matched: number; limit: number }

export function FleetSelectionStatus({ selected, siteCabinets, limits }: { selected: number; siteCabinets?: number; limits?: CabinetLimit }) {
  const cut = limits && limits.shown < limits.matched;
  return <span role="status"><strong>{selected}</strong>{cut ? " cabinets selected; list is cut." : <>{siteCabinets !== undefined ? ` of ${siteCabinets}` : ""} selected</>}
    {selected > LIMIT && <span className="error"> (at most {LIMIT})</span>}
    {cut && <span className="notice warn small" role="note"> Showing {limits.shown.toLocaleString("en-US")} of {limits.matched.toLocaleString("en-US")} cabinets that match. Narrow by client, site or problem to see the rest.</span>}
  </span>;
}

const KEY = "fleet-ops-selection";
/** The chosen site and the ticked cabinets, kept for this tab. */
const readSelection = (): { siteId: string; selected: Record<string, string> } => {
  try { const v = JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as { siteId?: string; selected?: Record<string, string> }; return { siteId: v.siteId ?? "", selected: v.selected ?? {} }; }
  catch { return { siteId: "", selected: {} }; }
};
const writeSelection = (siteId: string, selected: Record<string, string>) => { try { sessionStorage.setItem(KEY, JSON.stringify({ siteId, selected })); } catch { /* storage unavailable */ } };
const zone = (id: string | null) => id ? ZONE_NAMES[id] ?? id : "—";

export function FleetOperations() {
  const { navigate } = useRouter();
  const initial = new URLSearchParams(window.location.search);
  const saved = useMemo(readSelection, []);
  const [siteId, setSiteId] = useState(initial.get("site") ?? saved.siteId);
  const [problem, setProblem] = useState(initial.get("problem") ?? "any");
  const [selected, setSelected] = useState<Record<string, string>>(initial.get("site") && initial.get("site") !== saved.siteId ? {} : saved.selected);
  const [operation, setOperation] = useState<Operation>(initial.get("problem") === "clock_off" ? "time.sync" : "time.setZone");
  const [batchSize, setBatchSize] = useState(20);
  const [preview, setPreview] = useState<(Preview & { jobId: string; cabinetIds: string[] }) | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const diagnose = useStartDiagnosis();
  const siteList = useLoad<{ sites: SiteOption[] }>("/api/fleet-operations/sites");
  const query = new URLSearchParams({ siteId, problem }).toString();
  const list = useLoad<{ cabinets: Row[]; limits: { cabinets: CabinetLimit } }>(siteId ? `/api/fleet-operations/cabinets?${query}` : null);
  const jobs = useLoad<{ jobs: { id: string; operation: string; state: string; startedAt: string; total: number; startedBy: string; verified: number; problems: number }[] }>("/api/fleet-operations/jobs");
  useEffect(() => writeSelection(siteId, selected), [siteId, selected]);
  const rows = list.data?.cabinets ?? [];
  const site = siteList.data?.sites.find(x => x.id === siteId);
  const rowsPaged = usePaged(rows);
  const previewPaged = usePaged(preview?.cabinets ?? []);
  const jobsPaged = usePaged(jobs.data?.jobs ?? []);
  const byClient = useMemo(() => {
    const m = new Map<string, SiteOption[]>();
    for (const x of siteList.data?.sites ?? []) m.set(x.client.name, [...(m.get(x.client.name) ?? []), x]);
    return [...m.entries()];
  }, [siteList.data]);
  const chooseSite = (id: string) => { setSiteId(id); setSelected({}); setPreview(null); };
  const ids = Object.keys(selected).sort();
  const toggle = (r: Row) => { setPreview(null); setSelected(s => { const n = { ...s }; if (n[r.id]) delete n[r.id]; else n[r.id] = r.name; return n; }); };
  const allShown = rows.length > 0 && rows.every(r => selected[r.id]);
  const selectShown = () => { setPreview(null); setSelected(s => { const n = { ...s }; for (const r of rows) if (allShown) delete n[r.id]; else n[r.id] = r.name; return n; }); };

  const runPreview = async () => {
    setError(null);
    try {
      const p = await api<Preview>("POST", "/api/fleet-operations/preview", { operation, cabinetIds: ids });
      setPreview({ ...p, jobId: crypto.randomUUID(), cabinetIds: ids });
    } catch (e) { setError(describeError(e)); }
  };
  const start = async (token: string) => {
    if (!preview) return;
    const r = await api<{ jobId: string }>("POST", "/api/fleet-operations/jobs",
      { jobId: preview.jobId, operation: preview.operation, cabinetIds: preview.cabinetIds, planDigest: preview.planDigest, batchSize, stepUpToken: token });
    setSelected({});
    navigate(`/fleet-operations/jobs/${r.jobId}`);
  };
  const opLabel = OPERATIONS.find(o => o[0] === operation)!;

  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Fleet", to: "/" }, { label: "Fleet operations" }]} />
      <h1>Fleet operations</h1>
      <p className="muted">Preview per cabinet before anything is sent.</p>

      <section className="panel" aria-labelledby="choose">
        <h2 id="choose">1. Choose cabinets</h2>
        <form className="row gap wrap" onSubmit={e => e.preventDefault()}>
          <label className="field inline"><span>Site</span><select value={siteId} onChange={e => chooseSite(e.target.value)}>
            <option value="">Choose a site…</option>
            {byClient.map(([client, list]) => <optgroup key={client} label={client}>{list.map(x => <option key={x.id} value={x.id}>{x.name} ({x.cabinets})</option>)}</optgroup>)}</select></label>
          <label className="field inline"><span>Show</span><select value={problem} onChange={e => setProblem(e.target.value)}>
            {PROBLEMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        </form>
        {siteList.problem && <p className="error" role="alert">{siteList.problem}</p>}
        {list.problem && <p className="error" role="alert">{list.problem}</p>}
        <p className="row gap wrap">
          <button className="btn small" onClick={selectShown} disabled={rows.length === 0}>{allShown ? "Unselect" : "Select"} the {rows.length} shown</button>
          <button className="btn small ghost" onClick={() => { setSelected({}); setPreview(null); }} disabled={ids.length === 0}>Clear selection</button>
          <button className="btn small" onClick={() => void diagnose.start({ cabinetIds: ids })} disabled={ids.length === 0 || ids.length > 60 || diagnose.busy}>Diagnose network on the selected</button>
          {diagnose.problem && <span className="error small" role="alert">{diagnose.problem}</span>}
          <FleetSelectionStatus selected={ids.length} siteCabinets={site?.cabinets} limits={list.data?.limits.cabinets} />
        </p>
        {!siteId && <Empty>Choose a site to see its cabinets.</Empty>}
        {list.data && (rows.length === 0 ? <Empty>No cabinet matches.</Empty> : (
          <div className="table-wrap"><table className="table compact">
            <caption className="sr-only">Cabinets to choose from</caption>
            <thead><tr><th scope="col"><span className="sr-only">Selected</span></th><th scope="col">Cabinet</th><th scope="col">IPv4 address</th><th scope="col">Status</th>
              <th scope="col">Time zone (site's)</th><th scope="col">Clock</th><th scope="col">Alerts</th></tr></thead>
            <tbody>{rowsPaged.rows.map(r => (
              <tr key={r.id}>
                <td><input type="checkbox" checked={!!selected[r.id]} onChange={() => toggle(r)} aria-label={`Select ${r.name}`} /></td>
                <th scope="row"><Link to={`/cabinets/${r.id}`}>{r.name}</Link>{r.demo && <> <DemoTag /></>}</th>
                <td>{r.ipv4 ?? <span className="muted">Not read yet</span>}</td>
                <td><OnlineBadge online={r.online} />{r.readOnly && <> <Badge tone="info">Read-only</Badge></>}</td>
                <td>{zone(r.timeZoneId)}{r.site.timeZone && r.timeZoneId !== r.site.timeZone ? <> <Badge tone="warn">site: {zone(r.site.timeZone)}</Badge></> : null}</td>
                <td>{r.clockSkewSeconds === null ? "—" : Math.abs(r.clockSkewSeconds) > 120 ? <Badge tone="warn">{Math.round(r.clockSkewSeconds / 60)} min off</Badge> : "In step"}</td>
                <td>{r.openAlerts > 0 ? r.openAlerts : <span className="muted">None</span>}</td>
              </tr>))}
            </tbody>
          </table></div>))}
        <Pager {...rowsPaged} label="cabinets" />
      </section>

      <section className="panel" aria-labelledby="change">
        <h2 id="change">2. Choose the change and preview it</h2>
        <fieldset className="stack">
          <legend className="sr-only">Change</legend>
          {OPERATIONS.map(([v, label, help]) => (
            <label key={v} className="row gap"><input type="radio" name="operation" value={v} checked={operation === v} onChange={() => { setOperation(v); setPreview(null); }} />
              <span><strong>{label}</strong> <span className="muted small">{help}</span></span></label>))}
        </fieldset>
        <label className="field inline"><span>Cabinets at a time</span>
          <input type="number" min={1} max={50} value={batchSize} onChange={e => { setBatchSize(Math.max(1, Math.min(50, Number(e.target.value) || 1))); setPreview(null); }} /></label>
        <p><button className="btn" onClick={() => void runPreview()} disabled={ids.length === 0 || ids.length > LIMIT}>Preview on {ids.length} {ids.length === 1 ? "cabinet" : "cabinets"}</button></p>
        {error && <p className="error" role="alert">{error}</p>}
        {preview && (<>
          <p role="status"><strong>{preview.change}</strong> will be changed; <strong>{preview.skip}</strong> will be skipped.</p>
          {preview.cabinets.some(c => c.role === "sync" && !c.skip) && (
            <p className="notice" role="note">Sync cabinets go last, on their own, and only after every satellite being changed in this job checked out. If one does not, the sync cabinets are left unchanged: each serves every satellite at its site.</p>)}
          <div className="table-wrap"><table className="table compact">
            <caption className="sr-only">What each cabinet would get</caption>
            <thead><tr><th scope="col">Cabinet</th><th scope="col">IPv4 address</th><th scope="col">What happens</th></tr></thead>
            <tbody>{previewPaged.rows.map(c => (
              <tr key={c.id}><th scope="row">{c.name}{c.role === "sync" && <> <Badge tone="info">Sync cabinet: last</Badge></>}</th><td>{c.ipv4 ?? "—"}</td>
                <td>{c.skip ? <><Badge tone="off">Skipped</Badge> {c.skip}</> : preview.operation === "time.setZone"
                  ? <>Set to {zone((c.params as { timeZoneId: string }).timeZoneId)}</> : preview.operation === "time.sync" ? "Sync the clock" : "Apply its firewall policy"}</td></tr>))}
            </tbody>
          </table></div>
          <Pager {...previewPaged} label="preview cabinets" />
          <p><button className="btn primary" disabled={preview.change === 0} onClick={() => setConfirming(true)}>{opLabel[1]} on {preview.change} {preview.change === 1 ? "cabinet" : "cabinets"}</button></p>
        </>)}
        {preview && <PasswordDialog open={confirming} action="fleet.job" target={preview.jobId} onClose={() => setConfirming(false)}
          params={{ operation: preview.operation, cabinetIds: preview.cabinetIds, planDigest: preview.planDigest, batchSize }}
          description={<p>{opLabel[1]} on <strong>{preview.change}</strong> {preview.change === 1 ? "cabinet" : "cabinets"} ({preview.skip} skipped), {batchSize} at a time. Each one's result is checked from its next report.</p>}
          onToken={start} />}
      </section>

      <section className="panel" aria-labelledby="recent">
        <h2 id="recent">Recent fleet operations</h2>
        {jobs.data && (jobs.data.jobs.length === 0 ? <Empty>None yet.</Empty> : (
          <ul className="plain">{jobsPaged.rows.map(j => (
            <li key={j.id}><Link to={`/fleet-operations/jobs/${j.id}`}>{OPERATIONS.find(o => o[0] === j.operation)?.[1] ?? JOB_NAMES[j.operation] ?? j.operation}</Link>
              {" "}<span className="muted small">{j.total} cabinets · {j.verified} verified{j.problems > 0 && <>, {j.problems} need a look</>} · by {j.startedBy} {ago(j.startedAt)}</span>
              {" "}<Badge tone={j.state === "running" ? "info" : "off"}>{j.state}</Badge></li>))}
          </ul>))}
        <Pager {...jobsPaged} label="fleet operations" />
      </section>
    </div>
  );
}

const STATE: Record<string, ["ok" | "warn" | "crit" | "info" | "off", string]> = {
  pending: ["off", "Waiting"], issued: ["info", "Sent"], succeeded: ["info", "Done; verifying"], verified: ["ok", "Verified"],
  not_verified: ["warn", "Not verified"], failed: ["crit", "Failed"], offline: ["warn", "Offline: not reached"], skipped: ["off", "Skipped"], cancelled: ["off", "Cancelled"],
};

interface Job { id: string; operation: Operation; state: string; startedBy: string; startedAt: string; finishedAt: string | null; batchSize: number; total: number;
  counts: Record<string, number>; cabinets: { id: string; name: string; site: string; client: string; state: string; detail: string | null; updatedAt: string }[] }

export function FleetJob({ id }: { id: string }) {
  const { data, problem, reload } = useLoad<Job>(`/api/fleet-operations/jobs/${id}`);
  const [error, setError] = useState<string | null>(null);
  const cabinetsPaged = usePaged(data?.cabinets ?? []);
  // Followed while it runs, and while a cancelled job finishes the batch it had already sent (D83).
  const following = keepFollowing(data);
  useEffect(() => {
    if (!following) return;
    const t = setInterval(reload, 1500);
    return () => clearInterval(t);
  }, [following]); // eslint-disable-line react-hooks/exhaustive-deps
  const cancel = async () => { setError(null); try { await api("POST", `/api/fleet-operations/jobs/${id}/cancel`, {}); reload(); } catch (e) { setError(describeError(e)); } };
  const label = data ? OPERATIONS.find(o => o[0] === data.operation)?.[1] ?? JOB_NAMES[data.operation] ?? data.operation : "Fleet operation";
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Fleet", to: "/" }, { label: "Fleet operations", to: "/fleet-operations" }, { label }]} />
      <h1>{label}</h1>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && (<>
        <p className="muted">Started by {data.startedBy} at {fullTime(data.startedAt)}, {data.batchSize} at a time.
          {data.finishedAt && <> Finished at {fullTime(data.finishedAt)}.</>}</p>
        <p className="row gap wrap" role="status" aria-live="polite">
          <Badge tone={following ? "info" : "off"}>{phaseText(data)}</Badge>
          {Object.entries(data.counts).map(([k, n]) => <Badge key={k} tone={STATE[k]?.[0] ?? "off"}>{n} {STATE[k]?.[1].toLowerCase() ?? k}</Badge>)}
          {data.state === "running" && <button className="btn small danger" onClick={() => void cancel()}>Cancel the rest</button>}
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="table-wrap"><table className="table compact">
          <caption className="sr-only">Each cabinet's result</caption>
          <thead><tr><th scope="col">Cabinet</th><th scope="col">Client / site</th><th scope="col">Result</th><th scope="col">Detail</th></tr></thead>
          <tbody>{cabinetsPaged.rows.map(c => (
            <tr key={c.id}><th scope="row"><Link to={`/cabinets/${c.id}/${data.operation.startsWith("time") ? "time" : data.operation.startsWith("network") ? "network" : "firewall"}`}>{c.name}</Link></th>
              <td>{c.client} / {c.site}</td><td><Badge tone={STATE[c.state]?.[0] ?? "off"}>{STATE[c.state]?.[1] ?? c.state}</Badge></td><td className="small">{c.detail ?? ""}</td></tr>))}
          </tbody>
        </table></div>
        <Pager {...cabinetsPaged} label="cabinets" />
      </>)}
    </div>
  );
}
