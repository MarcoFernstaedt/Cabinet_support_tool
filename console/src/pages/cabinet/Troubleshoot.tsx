// Symptom-driven workbench. Each symptom runs a fixed list of read-only checks in the order a technician would work them. A check that
// comes back worth a look carries the fixes the team saved for it, and can take a new one: that is how the tool learns. Fixes are keyed
// exactly (check id, or symptom id), never by pattern, and apply to every cabinet in the fleet.
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "../../components/ui";
import { CHECK_BY_ID, useChecks, type Check } from "../../lib/checks";
import { Link } from "../../lib/router";
import { KEY_LABEL, KnownFixes, SaveFix } from "../../components/KnownFixes";

interface Step { check: string; why: string }
interface Playbook { id: string; symptom: string; steps: Step[]; next: { to: string; label: string }[] }

const PLAYBOOKS: Playbook[] = [
  { id: "scanner", symptom: "The fingerprint scanner is not detected, or is detected but does not work",
    steps: [
      { check: "usb", why: "The hub and port the scanner was last on, and any port that reports a problem. Not connected on its last port means reseat, change port or change cable." },
      { check: "devices", why: "A scanner Windows can see but cannot use shows here with a code: 10 means the driver would not start, 43 means the device reported a problem." },
      { check: "services", why: "Look for the scanner vendor's service and the Windows Biometric Service. A stopped one explains a scanner that is detected but dead." },
      { check: "system-log", why: "Look for USB, driver or biometric errors around the time it stopped." },
      { check: "updates", why: "If it stopped after an update, the installed update or driver from the same day is the first suspect." },
    ], next: [{ to: "scanner", label: "Fingerprint scanner section" }, { to: "devices", label: "Devices and drivers" }] },
  { id: "network", symptom: "No network, or the internet works but the cabinet's application cannot connect",
    steps: [
      { check: "net", why: "An address starting 169.254 means the DHCP server never answered. No gateway means nothing can leave the subnet." },
      { check: "loss", why: "Twenty requests to the gateway. Any loss on the first hop is the cable, the switch port or the adapter, not the internet. High jitter with no loss is a busy or half-failing link." },
      { check: "dns", why: "If the gateway answers but the name does not resolve, the DNS server addresses are wrong or unreachable." },
      { check: "trace", why: "Shows where the path stops. A first hop that answers and then silence points at the firewall or the router beyond it." },
      { check: "listeners", why: "If the application is the one that cannot be reached, confirm it is listening on its port and see who is connected to it." },
      { check: "firewall", why: "A profile that is on with a block rule for the application's port stops connections even when the network is fine. Never switch the whole firewall off." },
    ], next: [{ to: "network", label: "Network section" }, { to: "firewall", label: "Firewall section" }] },
  { id: "sync", symptom: "The cabinet is not syncing, or remote access is unavailable",
    steps: [
      { check: "ping", why: "The gateway first: if this fails, nothing past it will work." },
      { check: "trace", why: "The route to the platform server. Where the replies stop is where to look." },
      { check: "listeners", why: "On the sync cabinet, the database port (1433 for SQL Server) should be listening. On a satellite, look for the connection to it." },
      { check: "firewall", why: "A different network profile after a change, or a rule that was removed, is the usual reason a port that worked yesterday is closed today." },
      { check: "time", why: "Clocks that differ by more than a few minutes break sign-in and sync between machines." },
    ], next: [{ to: "network", label: "Network section" }, { to: "services", label: "Services" }] },
  { id: "slow", symptom: "The computer is slow, or the application freezes",
    steps: [
      { check: "perf", why: "One sample of processor, memory, free space and drive busy time, with the busiest programs. Read it twice, a few seconds apart, before deciding." },
      { check: "storage-log", why: "Disk errors and retries in the System log back up a slow drive." },
      { check: "scm-log", why: "Services timing out or restarting over and over can be the load itself." },
    ], next: [{ to: "processes", label: "Processes" }, { to: "events", label: "Event logs" }] },
  { id: "restart", symptom: "Random restarts or blue screens",
    steps: [
      { check: "critical-log", why: "Kernel-Power 41 means the machine lost power or froze without shutting down. BugCheck 1001 means a blue screen with a code." },
      { check: "storage-log", why: "Disk errors just before a crash point at the drive or its controller." },
      { check: "devices", why: "A device with a problem code can be the driver that is crashing the machine." },
      { check: "updates", why: "If the first crash came soon after an update or driver install, that is the change to look at first." },
      { check: "perf", why: "Memory almost full, or a drive nearly full, can both end in crashes." },
    ], next: [{ to: "crashes", label: "Crashes and restarts" }, { to: "events", label: "Event logs" }] },
  { id: "update", symptom: "A Windows update fails, or something stopped working after an update",
    steps: [
      { check: "updates", why: "Failed installs with their error codes, and what is still waiting. Compare the install dates with when the problem began." },
      { check: "perf", why: "Updates fail when the system drive is short of space; free space under 10 GB is flagged." },
      { check: "services", why: "Windows Update, Background Intelligent Transfer and Cryptographic Services must be able to start." },
      { check: "devices", why: "A driver that came with the update can leave a device in an error state." },
    ], next: [{ to: "updates", label: "Windows updates" }, { to: "devices", label: "Devices and drivers" }] },
  { id: "disk", symptom: "The hard drive may be failing",
    steps: [
      { check: "storage-log", why: "Disk and controller errors in the log are the second opinion." },
      { check: "perf", why: "A drive that is busy all the time with a long queue is struggling." },
    ], next: [{ to: "events", label: "Event logs" }] },
  { id: "service", symptom: "A service keeps stopping",
    steps: [
      { check: "services", why: "State, start type, the account it runs as and the program it launches. Restart it once and watch; repeated restarts hide the cause." },
      { check: "scm-log", why: "The reason Windows gives for each stop: a dependency that did not start, a timeout, a crash." },
      { check: "app-log", why: "The application's own errors from the same minute." },
    ], next: [{ to: "services", label: "Services" }] },
];

const STATUS_TEXT = { passed: "Looks fine", failed: "Look closer", running: "Running", waiting: "Waiting" } as const;

for (const p of PLAYBOOKS) { KEY_LABEL[`tsh-${p.id}`] = p.symptom; for (const s of p.steps) KEY_LABEL[`chk-${s.check}`] = CHECK_BY_ID[s.check]!.label; }

export function Troubleshoot({ cabinetId, cabinetName }: { cabinetId: string; cabinetName: string }) {
  const [id, setId] = useState(() => { const q = new URLSearchParams(window.location.search).get("symptom"); return PLAYBOOKS.some(p => p.id === q) ? q! : PLAYBOOKS[0]!.id; });
  const playbook = PLAYBOOKS.find(p => p.id === id)!;
  const checks = useMemo<Check[]>(() => playbook.steps.map(s => CHECK_BY_ID[s.check]!), [playbook]);
  const { rows, busy, start } = useChecks(cabinetId, checks);
  const [actions, setActions] = useState("");
  const [result, setResult] = useState("");
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(0);
  // Checks that failed on an earlier run and pass now were fixed in between: only those offer "Save what fixed this".
  const failedBefore = useRef<Set<string>>(new Set());
  const [wasFailing, setWasFailing] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (busy) return;
    const failed = new Set(checks.filter(c => rows[c.id]?.status === "failed").map(c => c.id));
    const finished = checks.some(c => rows[c.id]?.status === "passed" || rows[c.id]?.status === "failed");
    if (!finished) return;
    setWasFailing(new Set([...failedBefore.current].filter(id => rows[id]?.status === "passed")));
    failedBefore.current = failed;
  }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps
  const ran = checks.some(c => rows[c.id] && rows[c.id]!.status !== "waiting");
  const notes = () => [
    `Cabinet: ${cabinetName}`,
    `Issue / symptoms: ${playbook.symptom}`,
    "",
    "Findings / evidence:",
    ...playbook.steps.map(s => { const c = CHECK_BY_ID[s.check]!, r = rows[c.id]; return `- ${r?.status === "passed" ? "OK" : r?.status === "failed" ? "CHECK" : "not run"}: ${c.label}: ${r?.text || "not run"}`; }),
    "",
    `Actions taken: ${actions.trim() || "none yet"}`,
    `Result / next steps: ${result.trim() || "open"}`,
  ].join("\n");
  const copy = async () => { try { await navigator.clipboard.writeText(notes()); setCopied(true); } catch { setCopied(false); } };

  return (
    <section className="panel" aria-labelledby="troubleshoot-heading">
      <div className="panel-head">
        <h2 id="troubleshoot-heading">Troubleshoot</h2>
        <div className="row gap wrap">
          <label className="sr-only" htmlFor="symptom">Symptom</label>
          <select id="symptom" value={id} onChange={e => { setId(e.target.value); setCopied(false); }} disabled={busy}>
            {PLAYBOOKS.map(p => <option key={p.id} value={p.id}>{p.symptom}</option>)}
          </select>
          <button className="btn primary" onClick={() => { setCopied(false); void start(); }} disabled={busy}>{busy ? "Running…" : ran ? "Run again" : "Run"}</button>
        </div>
      </div>
      <KnownFixes symptom={{ kind: "finding", key: `tsh-${playbook.id}` }} cabinetId={cabinetId} reloadKey={saved} />
      <table className="table compact">
        <caption className="sr-only">{playbook.symptom}</caption>
        <thead><tr><th scope="col">Result</th><th scope="col">Check</th><th scope="col">Reading</th></tr></thead>
        <tbody>{playbook.steps.map(s => {
          const c = CHECK_BY_ID[s.check]!, r = rows[c.id], key: { kind: "finding"; key: string } = { kind: "finding", key: `chk-${c.id}` };
          return (
            <tr key={c.id} title={s.why}>
              <td style={{ whiteSpace: "nowrap" }}>{!r ? <Badge tone="off">—</Badge> : <Badge tone={r.status === "passed" ? "ok" : r.status === "failed" ? "warn" : "info"}>{STATUS_TEXT[r.status]}</Badge>}</td>
              <th scope="row">{c.label}<div className="muted small"><code>{c.operation}</code>{r?.ms != null && ` · ${(r.ms / 1000).toFixed(1)} s`}</div></th>
              <td className="small">
                {r?.text}
                {r?.status === "failed" && <KnownFixes symptom={key} cabinetId={cabinetId} reloadKey={saved} />}
                {r?.status === "passed" && wasFailing.has(c.id) && <SaveFix symptom={key} cabinetId={cabinetId} suggestedTitle={c.label} onSaved={() => setSaved(n => n + 1)} />}
                {r?.raw && <details><summary>Raw</summary><pre style={{ maxHeight: "16rem", overflow: "auto" }}>{r.raw}</pre></details>}
              </td>
            </tr>);
        })}</tbody>
      </table>
      <p className="small row gap wrap">{playbook.next.map(x => <Link key={x.to} to={`/cabinets/${cabinetId}/${x.to}`}>{x.label}</Link>)}</p>
      <details>
        <summary>Write-up for the ticket</summary>
        <div className="stack">
          <label className="field"><span>Actions taken</span><textarea rows={2} value={actions} onChange={e => setActions(e.target.value.slice(0, 1000))} /></label>
          <label className="field"><span>Result</span><textarea rows={2} value={result} onChange={e => setResult(e.target.value.slice(0, 1000))} /></label>
          <p><button className="btn" onClick={() => void copy()}>{copied ? "Copied" : "Copy case notes"}</button></p>
        </div>
      </details>
    </section>
  );
}
