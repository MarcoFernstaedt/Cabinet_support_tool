// Which Windows the fleet runs (F20, decision-log D55): the active cabinets by edition, build family and architecture, from the latest
// system.info each answered. It says what is not known: cabinets never read, and the update source, which no read gives yet.
import { useLoad } from "../lib/useLoad";
import { architectureLabel } from "../lib/architecture";
import { ago } from "../lib/time";

interface Row { edition: string | null; buildFamily: string | null; architecture: string | null; cabinets: number; lowestBuild: string | null; highestBuild: string | null; lastReadAt: string }
interface Report { rows: Row[]; cabinetsInFleet: number; cabinetsRead: number; notRead: number; updateSource: "not_read" }

const builds = (r: Row) => r.lowestBuild === null ? "unknown" : r.lowestBuild === r.highestBuild ? r.lowestBuild : `${r.lowestBuild} to ${r.highestBuild}`;

export function WindowsInFleet() {
  const { data, problem } = useLoad<Report>("/api/fleet/compatibility");
  if (problem) return <p className="error" role="alert">{problem}</p>;
  if (!data || data.cabinetsInFleet === 0) return null;
  return (
    <section className="panel" aria-labelledby="windows-in-fleet">
      <h2 id="windows-in-fleet">Windows in the fleet</h2>
      <p className="muted">From the latest system information each cabinet answered: {data.cabinetsRead} of {data.cabinetsInFleet} cabinets
        {data.notRead > 0 ? `; ${data.notRead} not read yet` : ""}. Where each gets its updates from (Windows Update, WSUS) is not read yet.</p>
      {data.rows.length > 0 && (
        <div className="table-wrap">
          <table className="table compact">
            <caption className="sr-only">Windows editions, builds and architectures in the fleet</caption>
            <thead><tr><th scope="col">Windows</th><th scope="col">Build family</th><th scope="col">Builds seen</th><th scope="col">Architecture</th><th scope="col">Cabinets</th><th scope="col">Last read</th></tr></thead>
            <tbody>{data.rows.map((r, i) => (
              <tr key={i}>
                <th scope="row">{r.edition ?? <span className="muted">not reported</span>}</th>
                <td>{r.buildFamily ?? <span className="muted">unknown</span>}</td>
                <td>{builds(r)}</td>
                <td>{r.architecture ? architectureLabel(r.architecture) : <span className="muted">unknown</span>}</td>
                <td>{r.cabinets}</td>
                <td>{ago(r.lastReadAt)}</td>
              </tr>))}
            </tbody>
          </table>
        </div>)}
    </section>
  );
}
