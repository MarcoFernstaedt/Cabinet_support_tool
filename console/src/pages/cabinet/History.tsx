import { useLoad } from "../Fleet";
import { fullTime } from "../../lib/time";
import { Badge, Empty } from "../../components/ui";

interface Row { id: string; operation: string; status: string; issuedAt: string; resultAt: string | null; issuedBy: string; errorCode: string | null; }

const TONE: Record<string, "ok" | "warn" | "crit" | "info" | "off"> = { succeeded: "ok", failed: "crit", rejected: "crit", expired: "warn", queued: "info", delivered: "info" };

export function History({ cabinetId }: { cabinetId: string }) {
  const { data, problem, reload } = useLoad<Row[]>(`/api/cabinets/${cabinetId}/commands`);
  return (
    <section className="panel" aria-labelledby="history-heading">
      <div className="panel-head"><h2 id="history-heading">Command history</h2><button className="btn" onClick={reload}>Refresh</button></div>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && data.length === 0 && <Empty>No commands have been run on this cabinet yet.</Empty>}
      {data && data.length > 0 && (
        <table className="table">
          <caption className="sr-only">Last 50 commands</caption>
          <thead><tr><th scope="col">Issued</th><th scope="col">Operation</th><th scope="col">By</th><th scope="col">Outcome</th><th scope="col">Answered</th></tr></thead>
          <tbody>{data.map(r => (
            <tr key={r.id}><td>{fullTime(r.issuedAt)}</td><td><code>{r.operation}</code></td><td>{r.issuedBy}</td>
              <td><Badge tone={TONE[r.status] ?? "off"}>{r.status}{r.errorCode ? ` (${r.errorCode})` : ""}</Badge></td><td>{r.resultAt ? fullTime(r.resultAt) : "—"}</td></tr>))}
          </tbody>
        </table>
      )}
    </section>
  );
}
