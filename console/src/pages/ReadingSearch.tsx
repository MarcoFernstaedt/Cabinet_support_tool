// Search the fleet by what its cabinets reported the last time they were read: "which cabinets have this program, this update, this
// startup item, this share, this signed-in user, a restart waiting, Defender off?" Nothing is sent to a cabinet; the answer says how many
// cabinets have been read at all, so an empty result is never mistaken for "none have it".
import { useState } from "react";
import { api, describeError } from "../lib/api";
import { ago, fullTime } from "../lib/time";
import { Link } from "../lib/router";
import { Badge, Empty } from "../components/ui";
import { DataTable } from "../components/DataTable";

interface Match { cabinetId: string; name: string; role: string; site: string; client: string; demo: boolean; readAt: string; found: string[] }
interface Result { operation: string; q: string; matches: Match[]; cabinetsRead: number; cabinetsInScope: number; truncated: boolean }

/** What can be searched, by the reading it comes from. A state search offers fixed choices; a name search takes text. */
const KINDS: { op: string; label: string; hint: string; choices?: [string, string][] }[] = [
  { op: "software.list", label: "Installed program or update", hint: "Part of a name, publisher or update number, such as BioScan or KB5034" },
  { op: "startup.list", label: "Startup item or scheduled task", hint: "Part of a name or command" },
  { op: "shares.list", label: "Network share", hint: "Part of a share name or its folder" },
  { op: "sessions.list", label: "Signed-in user", hint: "Part of a user name" },
  { op: "dns.cache", label: "DNS name looked up", hint: "Part of a host name or its answer" },
  { op: "system.security", label: "Security state", hint: "", choices: [["pending_restart", "A restart is waiting"], ["defender_off", "Defender or real-time protection is off"], ["bitlocker_off", "A drive is not encrypted"], ["cert_expiring", "A certificate expired or expires soon"], ["not_activated", "Windows is not activated"]] },
  { op: "power.status", label: "Power setting", hint: "", choices: [["usb_suspend", "USB selective suspend is on"], ["fast_startup", "Fast Startup is on"]] },
];

export function ReadingSearch() {
  const [op, setOp] = useState(KINDS[0]!.op);
  const kind = KINDS.find(k => k.op === op)!;
  const [text, setText] = useState("");
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const q = kind.choices ? (choice || kind.choices[0]![0]) : text.trim();

  const search = async () => {
    setBusy(true); setProblem(null);
    try { setResult(await api<Result>("GET", `/api/readings/search?operation=${encodeURIComponent(op)}&q=${encodeURIComponent(q)}`)); }
    catch (e) { setProblem(describeError(e)); setResult(null); }
    finally { setBusy(false); }
  };

  return (
    <div className="page">
      <h1>Search the fleet</h1>
      <p className="muted">Searches what cabinets reported the last time they were read. It does not ask any cabinet anything.</p>
      <form className="panel row gap wrap" aria-label="Search readings" onSubmit={e => { e.preventDefault(); if (q) void search(); }}>
        <label className="field inline"><span>Find</span>
          <select value={op} onChange={e => { setOp(e.target.value); setChoice(""); setResult(null); }}>{KINDS.map(k => <option key={k.op} value={k.op}>{k.label}</option>)}</select></label>
        {kind.choices
          ? <label className="field inline"><span>Where</span><select value={choice || kind.choices[0]![0]} onChange={e => setChoice(e.target.value)}>{kind.choices.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          : <label className="field inline grow"><span>Text</span><input value={text} maxLength={80} onChange={e => setText(e.target.value)} placeholder={kind.hint} /></label>}
        <button className="btn primary" type="submit" disabled={busy || !q}>{busy ? "Searching…" : "Search"}</button>
      </form>
      {problem && <p className="error" role="alert">{problem}</p>}
      {result && (<section className="panel" aria-label="Search results" aria-live="polite">
        <p>
          <strong>{result.matches.length}{result.truncated ? "+" : ""}</strong> {result.matches.length === 1 ? "cabinet" : "cabinets"} found among the <strong>{result.cabinetsRead}</strong> that have been read
          {result.cabinetsRead < result.cabinetsInScope && <> <Badge tone="warn">{result.cabinetsInScope - result.cabinetsRead} of {result.cabinetsInScope} never read</Badge></>}.
        </p>
        {result.cabinetsRead === 0 && <Empty>No cabinet has been read for this yet. Open a cabinet's Windows tab and run the reading, and it will be searchable.</Empty>}
        {result.cabinetsRead > 0 && (
          <DataTable label="cabinets" rows={result.matches} empty="No cabinet that has been read matches." filterable={false} columns={[
            { header: "Cabinet", first: true, cell: m => <Link to={`/cabinets/${m.cabinetId}/windows`}>{m.name}</Link> },
            { header: "Client · site", cell: m => <>{m.client} · {m.site}</> },
            { header: "Found", cell: m => <ul className="plain">{m.found.map((f, i) => <li key={i}>{f}</li>)}</ul> },
            { header: "Read", cell: m => <span title={fullTime(m.readAt)}>{ago(m.readAt)}</span> }]} />)}
      </section>)}
    </div>
  );
}
