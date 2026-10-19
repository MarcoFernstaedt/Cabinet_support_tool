// "What did I do?" as case notes for a ticket: your own changes, what you checked, alerts you resolved and fixes you saved, over the last few hours.
// Built on the server from the command history, so it is the same whichever console you used.
import { useState } from "react";
import { api, describeError } from "../lib/api";

interface Report { text: string; changes: number; checks: number; alerts: number; fixes: number }
const WINDOWS: [string, string][] = [["1", "1 hour"], ["4", "4 hours"], ["8", "8 hours"], ["24", "24 hours"], ["72", "3 days"], ["168", "7 days"]];

export function CaseNotes({ cabinetId, title = "Case notes" }: { cabinetId?: string; title?: string }) {
  const [hours, setHours] = useState("8");
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const build = async () => {
    setBusy(true); setProblem(null); setCopied(false);
    try { setReport(await api<Report>("GET", `/api/reports/activity?hours=${hours}${cabinetId ? `&cabinetId=${cabinetId}` : ""}`)); }
    catch (e) { setProblem(describeError(e)); setReport(null); }
    finally { setBusy(false); }
  };
  const copy = async () => { if (!report) return; try { await navigator.clipboard.writeText(report.text); setCopied(true); } catch { setCopied(false); } };
  return (
    <section className="panel" aria-labelledby={`notes-${cabinetId ?? "all"}`}>
      <div className="panel-head">
        <h2 id={`notes-${cabinetId ?? "all"}`}>{title}</h2>
        <div className="row gap wrap">
          <label className="sr-only" htmlFor={`notes-hours-${cabinetId ?? "all"}`}>Period</label>
          <select id={`notes-hours-${cabinetId ?? "all"}`} value={hours} onChange={e => { setHours(e.target.value); setReport(null); }}>{WINDOWS.map(([v, l]) => <option key={v} value={v}>Last {l}</option>)}</select>
          <button className="btn primary" disabled={busy} onClick={() => void build()}>{busy ? "Building…" : "Build notes"}</button>
        </div>
      </div>
      {problem && <p className="error" role="alert">{problem}</p>}
      {report && (<>
        <textarea readOnly className="mono" rows={Math.min(18, report.text.split("\n").length + 1)} value={report.text} aria-label="Case notes" style={{ width: "100%" }} />
        <p className="row gap small"><button className="btn" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
          <span className="muted">{report.changes} {report.changes === 1 ? "change" : "changes"} · {report.checks} kinds of check · {report.alerts} alerts · {report.fixes} fixes</span></p>
      </>)}
    </section>
  );
}
