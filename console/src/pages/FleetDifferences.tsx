// Where the fleet differs from its baselines, counted across cabinets: the same difference on many cabinets at once points at one cause
// (a change made everywhere, an update, a policy) rather than at one cabinet. A group shows the cabinets that differ and how many report the
// same item and do not. Nothing here changes a cabinet.
import { useState } from "react";
import { Link, useRouter } from "../lib/router";
import { useLoad } from "../lib/useLoad";
import { Badge, Empty } from "../components/ui";
import { Breadcrumbs } from "../components/Layout";
import { Pager, usePaged } from "../components/Pager";
import { categoryName, show } from "../components/ConfigParts";
import { fullTime } from "../lib/time";

interface Group { category: string; itemKey: string; field: string; cabinets: number; major: number; required: number }
interface Overview { cabinetsReporting: number; cabinetsJudged: number; groups: Group[] }

const query = (p: Record<string, string | undefined>) => { const q = new URLSearchParams(); for (const [k, v] of Object.entries(p)) if (v) q.set(k, v); const s = q.toString(); return s ? `?${s}` : ""; };

export function FleetDifferences() {
  const { path } = useRouter();
  const search = new URLSearchParams(path.split("?")[1] ?? "");
  const scope = { clientId: search.get("clientId") ?? undefined, siteId: search.get("siteId") ?? undefined };
  const { data, problem } = useLoad<Overview>(`/api/fleet/differences${query(scope)}`);
  const [q, setQ] = useState("");
  const rows = (data?.groups ?? []).filter(g => !q.trim() || `${g.category} ${g.itemKey} ${g.field}`.toLowerCase().includes(q.trim().toLowerCase()));
  const paged = usePaged(rows);
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Fleet", to: "/" }, { label: "Differences from baselines" }]} />
      <h1>Differences from baselines</h1>
      <p className="muted">Each line is one way cabinets differ from the baseline that applies to them, with how many cabinets do. A difference on many cabinets at once is worth looking at first. It is a place to start, not a finding about the cause.</p>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && <p className="muted" role="status">{data.cabinetsReporting} cabinets report their configuration; {data.cabinetsJudged} of them have a baseline that applies. A cabinet that has not reported, or has no baseline, is not in these counts.</p>}
      {data && data.groups.length === 0 && <Empty>{data.cabinetsJudged === 0 ? "No cabinet is judged against a baseline yet." : "No cabinet differs from its baseline."}</Empty>}
      {data && data.groups.length > 0 && (<>
        <label className="field inline"><span>Find a difference</span><input type="search" maxLength={100} value={q} onChange={e => setQ(e.target.value)} /></label>
        <div className="table-wrap"><table className="table">
          <caption className="sr-only">Differences from baselines, by how many cabinets</caption>
          <thead><tr><th scope="col">Difference</th><th scope="col">Cabinets</th><th scope="col">Of which</th></tr></thead>
          <tbody>{paged.rows.map(g => (
            <tr key={`${g.category}|${g.itemKey}|${g.field}`}>
              <th scope="row"><Link to={`/fleet-differences/group${query({ ...scope, category: g.category, itemKey: g.itemKey, field: g.field })}`}>{categoryName(g.category)}: {g.itemKey}{g.field && <> · {g.field}</>}</Link></th>
              <td>{g.cabinets} of {data.cabinetsJudged}</td>
              <td>{g.major > 0 && <Badge tone="crit">{g.major} major</Badge>} {g.required > 0 && <Badge tone="info">{g.required} required</Badge>}</td>
            </tr>))}</tbody>
        </table></div>
        <Pager {...paged} label="differences" />
      </>)}
    </div>
  );
}

interface GroupDetail { category: string; itemKey: string; field: string; affected: number; listed: number; unaffected: number;
  cabinets: { id: string; name: string; site: string; client: string; model: string | null; mode: string; severity: string; expected: unknown; actual: unknown; since: string; online: boolean }[] }

export function FleetDifferenceGroup() {
  const { path } = useRouter();
  const search = new URLSearchParams(path.split("?")[1] ?? "");
  const p = { category: search.get("category") ?? undefined, itemKey: search.get("itemKey") ?? undefined, field: search.get("field") ?? undefined, clientId: search.get("clientId") ?? undefined, siteId: search.get("siteId") ?? undefined };
  const { data, problem } = useLoad<GroupDetail>(p.category && p.itemKey ? `/api/fleet/differences/group${query(p)}` : null);
  const paged = usePaged(data?.cabinets ?? []);
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Fleet", to: "/" }, { label: "Differences from baselines", to: `/fleet-differences${query({ clientId: p.clientId, siteId: p.siteId })}` }, { label: "One difference" }]} />
      <h1>{p.category ? `${categoryName(p.category)}: ${p.itemKey}` : "Difference"}{p.field && <> · {p.field}</>}</h1>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && (<>
        <p className="muted" role="status">{data.affected} {data.affected === 1 ? "cabinet differs" : "cabinets differ"}; {data.unaffected} {data.unaffected === 1 ? "cabinet reports" : "cabinets report"} the same item and {data.unaffected === 1 ? "does" : "do"} not.
          {data.listed < data.affected && ` The first ${data.listed} are listed.`} Comparing the two groups (the same model, site or update) is how a common cause shows up.</p>
        <div className="table-wrap"><table className="table">
          <caption className="sr-only">Cabinets with this difference</caption>
          <thead><tr><th scope="col">Cabinet</th><th scope="col">Should be</th><th scope="col">Is</th><th scope="col">Since</th></tr></thead>
          <tbody>{paged.rows.map(c => (
            <tr key={c.id}><th scope="row"><Link to={`/cabinets/${c.id}/baseline`}>{c.name}</Link> {!c.online && <Badge tone="off">Not in contact</Badge>}<div className="muted small">{c.client} / {c.site}{c.model && <> · {c.model}</>}</div></th>
              <td>{c.mode === "present" ? "Present" : c.mode === "absent" ? "Not present" : show(c.expected)}</td>
              <td>{c.mode === "present" ? "Missing" : c.mode === "absent" ? "Present" : show(c.actual)}</td>
              <td title={fullTime(c.since)}>{fullTime(c.since)}</td></tr>))}</tbody>
        </table></div>
        <Pager {...paged} label="cabinets" />
      </>)}
    </div>
  );
}
