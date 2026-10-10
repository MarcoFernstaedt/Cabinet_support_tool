// Fleet operations (docs/spec/13-roadmap.md modules 21 and 45): choose cabinets by client, site, problem or by hand,
// preview what one fixed operation would do on each (and what it would skip, and why), confirm with the password, then
// follow the job: each cabinet's result and whether its next report verified the change. The selection survives moving
// around the console in this tab. The server checks the role, the confirmation, the limits and the pauses again.
import { useEffect, useMemo, useState } from "react";
import { api, describeError } from "../lib/api";
import { Link, useRouter } from "../lib/router";
import { useLoad } from "../lib/useLoad";
import { fullTime, ago } from "../lib/time";
import { Breadcrumbs } from "../components/Layout";
import { Badge, Empty, OnlineBadge, PasswordDialog } from "../components/ui";
import { DemoTag } from "../components/DemoBanner";
import { ZONE_NAMES } from "./cabinet/Time";

type Operation = "time.setZone" | "time.sync" | "firewall.applyPolicy";
const OPERATIONS: [Operation, string, string][] = [
  ["time.setZone", "Set each cabinet to its site's time zone", "Each cabinet gets its own site's zone; cabinets already in it, or whose site has none set, are skipped."],
  ["time.sync", "Sync clocks", "Windows Time synchronizes with its configured source; the source is not changed."],
  ["firewall.applyPolicy", "Apply the firewall policy", "Each cabinet gets its client's firewall policy; cabinets that already match are skipped. The safety net applies."],
];
const PROBLEMS: [string, string][] = [["any", "Any cabinet"], ["time_zone_wrong", "Wrong time zone"], ["clock_off", "Clock is off"], ["firewall_drift", "Firewall differs from policy"]];
const LIMIT = 200;

interface Row { id: string; name: string; role: string; site: { id: string; name: string; timeZone: string | null }; client: { id: string; name: string }; demo: boolean;
  readOnly: boolean | null; online: boolean; timeZoneId: string | null; clockSkewSeconds: number | null; openAlerts: number }
interface Preview { operation: Operation; change: number; skip: number; cabinets: { id: string; name: string; site: string; client: string; params: unknown; skip: string | null }[] }

const KEY = "fleet-ops-selection";
const readSelection = (): Record<string, string> => { try { return JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as Record<string, string>; } catch { return {}; } };
const writeSelection = (s: Record<string, string>) => { try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ } };
const zone = (id: string | null) => id ? ZONE_NAMES[id] ?? id : "—";

export function FleetOperations() {
  const { navigate } = useRouter();
  const initial = new URLSearchParams(window.location.search);
  const [clientId, setClientId] = useState(initial.get("client") ?? "");
  const [siteId, setSiteId] = useState("");
  const [problem, setProblem] = useState(initial.get("problem") ?? "any");
  const [selected, setSelected] = useState<Record<string, string>>(readSelection);
  const [operation, setOperation] = useState<Operation>(initial.get("problem") === "clock_off" ? "time.sync" : "time.setZone");
  const [batchSize, setBatchSize] = useState(20);
  const [preview, setPreview] = useState<(Preview & { jobId: string; cabinetIds: string[] }) | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clients = useLoad<{ id: string; name: string }[]>("/api/fleet/clients");
  const query = new URLSearchParams({ ...(clientId ? { clientId } : {}), ...(siteId ? { siteId } : {}), problem }).toString();
  const list = useLoad<{ cabinets: Row[] }>(`/api/fleet-operations/cabinets?${query}`);
  const jobs = useLoad<{ jobs: { id: string; operation: string; state: string; startedAt: string; total: number; startedBy: string; verified: number; problems: number }[] }>("/api/fleet-operations/jobs");
  useEffect(() => writeSelection(selected), [selected]);
  const rows = list.data?.cabinets ?? [];
  const sites = useMemo(() => [...new Map(rows.map(r => [r.site.id, `${r.client.name} / ${r.site.name}`])).entries()], [rows]);
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
      { jobId: preview.jobId, operation: preview.operation, cabinetIds: preview.cabinetIds, batchSize, stepUpToken: token });
    setSelected({});
    navigate(`/fleet-operations/jobs/${r.jobId}`);
  };
  const opLabel = OPERATIONS.find(o => o[0] === operation)!;

  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Fleet", to: "/" }, { label: "Fleet operations" }]} />
      <h1>Fleet operations</h1>
      <p className="muted">Choose cabinets by client, site or problem, or tick them one by one, then run one change on all of them. You see what each cabinet would get before anything is sent; each one's result is checked from its next report.</p>

      <section className="panel" aria-labelledby="choose">
        <h2 id="choose">1. Choose cabinets</h2>
        <form className="row gap wrap" onSubmit={e => e.preventDefault()}>
          <label className="field inline"><span>Client</span><select value={clientId} onChange={e => { setClientId(e.target.value); setSiteId(""); }}>
            <option value="">All clients</option>{clients.data?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="field inline"><span>Site</span><select value={siteId} onChange={e => setSiteId(e.target.value)}>
            <option value="">All sites</option>{sites.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
          <label className="field inline"><span>Problem</span><select value={problem} onChange={e => setProblem(e.target.value)}>
            {PROBLEMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        </form>
        {list.problem && <p className="error" role="alert">{list.problem}</p>}
        <p className="row gap wrap">
          <button className="btn small" onClick={selectShown} disabled={rows.length === 0}>{allShown ? "Unselect" : "Select"} the {rows.length} shown</button>
          <button className="btn small ghost" onClick={() => { setSelected({}); setPreview(null); }} disabled={ids.length === 0}>Clear selection</button>
          <span role="status"><strong>{ids.length}</strong> selected{ids.length > LIMIT && <span className="error"> (at most {LIMIT})</span>}</span>
        </p>
        {list.data && (rows.length === 0 ? <Empty>No cabinet matches.</Empty> : (
          <div className="table-wrap"><table className="table compact">
            <caption className="sr-only">Cabinets to choose from</caption>
            <thead><tr><th scope="col"><span className="sr-only">Selected</span></th><th scope="col">Cabinet</th><th scope="col">Client / site</th><th scope="col">Status</th>
              <th scope="col">Time zone (site's)</th><th scope="col">Clock</th><th scope="col">Alerts</th></tr></thead>
            <tbody>{rows.map(r => (
              <tr key={r.id}>
                <td><input type="checkbox" checked={!!selected[r.id]} onChange={() => toggle(r)} aria-label={`Select ${r.name}`} /></td>
                <th scope="row"><Link to={`/cabinets/${r.id}`}>{r.name}</Link>{r.demo && <> <DemoTag /></>}</th>
                <td>{r.client.name} / {r.site.name}</td>
                <td><OnlineBadge online={r.online} />{r.readOnly && <> <Badge tone="info">Read-only</Badge></>}</td>
                <td>{zone(r.timeZoneId)}{r.site.timeZone && r.timeZoneId !== r.site.timeZone ? <> <Badge tone="warn">site: {zone(r.site.timeZone)}</Badge></> : null}</td>
                <td>{r.clockSkewSeconds === null ? "—" : Math.abs(r.clockSkewSeconds) > 120 ? <Badge tone="warn">{Math.round(r.clockSkewSeconds / 60)} min off</Badge> : "In step"}</td>
                <td>{r.openAlerts > 0 ? r.openAlerts : <span className="muted">None</span>}</td>
              </tr>))}
            </tbody>
          </table></div>))}
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
          <div className="table-wrap"><table className="table compact">
            <caption className="sr-only">What each cabinet would get</caption>
            <thead><tr><th scope="col">Cabinet</th><th scope="col">Client / site</th><th scope="col">What happens</th></tr></thead>
            <tbody>{preview.cabinets.map(c => (
              <tr key={c.id}><th scope="row">{c.name}</th><td>{c.client} / {c.site}</td>
                <td>{c.skip ? <><Badge tone="off">Skipped</Badge> {c.skip}</> : preview.operation === "time.setZone"
                  ? <>Set to {zone((c.params as { timeZoneId: string }).timeZoneId)}</> : preview.operation === "time.sync" ? "Sync the clock" : "Apply its client's policy"}</td></tr>))}
            </tbody>
          </table></div>
          <p><button className="btn primary" disabled={preview.change === 0} onClick={() => setConfirming(true)}>{opLabel[1]} on {preview.change} {preview.change === 1 ? "cabinet" : "cabinets"}</button></p>
        </>)}
        {preview && <PasswordDialog open={confirming} action="fleet.job" target={preview.jobId} onClose={() => setConfirming(false)}
          params={{ operation: preview.operation, cabinetIds: preview.cabinetIds, batchSize }}
          description={<p>{opLabel[1]} on <strong>{preview.change}</strong> {preview.change === 1 ? "cabinet" : "cabinets"} ({preview.skip} skipped), {batchSize} at a time. Each one's result is checked from its next report.</p>}
          onToken={start} />}
      </section>

      <section className="panel" aria-labelledby="recent">
        <h2 id="recent">Recent fleet operations</h2>
        {jobs.data && (jobs.data.jobs.length === 0 ? <Empty>None yet.</Empty> : (
          <ul className="plain">{jobs.data.jobs.map(j => (
            <li key={j.id}><Link to={`/fleet-operations/jobs/${j.id}`}>{OPERATIONS.find(o => o[0] === j.operation)?.[1] ?? j.operation}</Link>
              {" "}<span className="muted small">{j.total} cabinets · {j.verified} verified{j.problems > 0 && <>, {j.problems} need a look</>} · by {j.startedBy} {ago(j.startedAt)}</span>
              {" "}<Badge tone={j.state === "running" ? "info" : "off"}>{j.state}</Badge></li>))}
          </ul>))}
      </section>
    </div>
  );
}

const STATE: Record<string, ["ok" | "warn" | "crit" | "info" | "off", string]> = {
  pending: ["off", "Waiting"], issued: ["info", "Sent"], succeeded: ["info", "Done; verifying"], verified: ["ok", "Verified"],
  not_verified: ["warn", "Not verified"], failed: ["crit", "Failed"], skipped: ["off", "Skipped"], cancelled: ["off", "Cancelled"],
};

interface Job { id: string; operation: Operation; state: string; startedBy: string; startedAt: string; finishedAt: string | null; batchSize: number; total: number;
  counts: Record<string, number>; cabinets: { id: string; name: string; site: string; client: string; state: string; detail: string | null; updatedAt: string }[] }

export function FleetJob({ id }: { id: string }) {
  const { data, problem, reload } = useLoad<Job>(`/api/fleet-operations/jobs/${id}`);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (data?.state !== "running") return;
    const t = setInterval(reload, 1500);
    return () => clearInterval(t);
  }, [data?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const cancel = async () => { setError(null); try { await api("POST", `/api/fleet-operations/jobs/${id}/cancel`, {}); reload(); } catch (e) { setError(describeError(e)); } };
  const label = data ? OPERATIONS.find(o => o[0] === data.operation)?.[1] ?? data.operation : "Fleet operation";
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Fleet", to: "/" }, { label: "Fleet operations", to: "/fleet-operations" }, { label }]} />
      <h1>{label}</h1>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && (<>
        <p className="muted">Started by {data.startedBy} at {fullTime(data.startedAt)}, {data.batchSize} at a time.
          {data.finishedAt && <> Finished at {fullTime(data.finishedAt)}.</>}</p>
        <p className="row gap wrap" role="status" aria-live="polite">
          <Badge tone={data.state === "running" ? "info" : "off"}>{data.state === "running" ? "Running" : data.state === "cancelled" ? "Cancelled" : "Finished"}</Badge>
          {Object.entries(data.counts).map(([k, n]) => <Badge key={k} tone={STATE[k]?.[0] ?? "off"}>{n} {STATE[k]?.[1].toLowerCase() ?? k}</Badge>)}
          {data.state === "running" && <button className="btn small danger" onClick={() => void cancel()}>Cancel the rest</button>}
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="table-wrap"><table className="table compact">
          <caption className="sr-only">Each cabinet's result</caption>
          <thead><tr><th scope="col">Cabinet</th><th scope="col">Client / site</th><th scope="col">Result</th><th scope="col">Detail</th></tr></thead>
          <tbody>{data.cabinets.map(c => (
            <tr key={c.id}><th scope="row"><Link to={`/cabinets/${c.id}/${data.operation.startsWith("time") ? "time" : "firewall"}`}>{c.name}</Link></th>
              <td>{c.client} / {c.site}</td><td><Badge tone={STATE[c.state]?.[0] ?? "off"}>{STATE[c.state]?.[1] ?? c.state}</Badge></td><td className="small">{c.detail ?? ""}</td></tr>))}
          </tbody>
        </table></div>
      </>)}
    </div>
  );
}
