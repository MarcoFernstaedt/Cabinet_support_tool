// Start from what the customer says is wrong. Each symptom runs a short fixed list of read-only checks, in the order a technician would
// do them by hand, and says what each answer means. The case notes at the bottom collect the findings with room for what you did and how
// it ended, ready to paste into a ticket. The checks only read; fixes stay in the sections that make them, with their own confirmations.
import { useMemo, useState } from "react";
import { Badge } from "../../components/ui";
import { CHECK_BY_ID, useChecks, type Check } from "../../lib/checks";
import { Link } from "../../lib/router";

interface Step { check: string; why: string }
interface Playbook { id: string; symptom: string; start: string; steps: Step[]; next: { to: string; label: string }[] }

const PLAYBOOKS: Playbook[] = [
  { id: "scanner", symptom: "The fingerprint scanner is not detected, or is detected but does not work", start: "Is it plugged in, is Windows seeing it, and is its service running.",
    steps: [
      { check: "devices", why: "A scanner Windows can see but cannot use shows here with a code: 10 means the driver would not start, 43 means the device reported a problem." },
      { check: "services", why: "Look for the scanner vendor's service and the Windows Biometric Service. A stopped one explains a scanner that is detected but dead." },
      { check: "system-log", why: "Look for USB, driver or biometric errors around the time it stopped." },
      { check: "updates", why: "If it stopped after an update, the installed update or driver from the same day is the first suspect." },
    ], next: [{ to: "scanner", label: "Fingerprint scanner section (port, driver and drop history)" }, { to: "devices", label: "Devices and drivers" }] },
  { id: "network", symptom: "No network, or the internet works but the cabinet's application cannot connect", start: "Does it have an address, can it reach the gateway, can it look up names.",
    steps: [
      { check: "net", why: "An address starting 169.254 means the DHCP server never answered. No gateway means nothing can leave the subnet." },
      { check: "loss", why: "Twenty requests to the gateway. Any loss on the first hop is the cable, the switch port or the adapter, not the internet. High jitter with no loss is a busy or half-failing link." },
      { check: "dns", why: "If the gateway answers but the name does not resolve, the DNS server addresses are wrong or unreachable." },
      { check: "trace", why: "Shows where the path stops. A first hop that answers and then silence points at the firewall or the router beyond it." },
      { check: "listeners", why: "If the application is the one that cannot be reached, confirm it is listening on its port and see who is connected to it." },
      { check: "firewall", why: "A profile that is on with a block rule for the application's port stops connections even when the network is fine. Never switch the whole firewall off." },
    ], next: [{ to: "network", label: "Network section (full read, one-click diagnosis)" }, { to: "firewall", label: "Firewall section" }] },
  { id: "sync", symptom: "The cabinet is not syncing, or remote access is unavailable", start: "Can it reach the other cabinet and the platform, and is something blocking the port.",
    steps: [
      { check: "ping", why: "The gateway first: if this fails, nothing past it will work." },
      { check: "trace", why: "The route to the platform server. Where the replies stop is where to look." },
      { check: "listeners", why: "On the sync cabinet, the database port (1433 for SQL Server) should be listening. On a satellite, look for the connection to it." },
      { check: "firewall", why: "A different network profile after a change, or a rule that was removed, is the usual reason a port that worked yesterday is closed today." },
      { check: "time", why: "Clocks that differ by more than a few minutes break sign-in and sync between machines." },
    ], next: [{ to: "network", label: "Network section" }, { to: "services", label: "Services" }] },
  { id: "slow", symptom: "The computer is slow, or the application freezes", start: "Processor, memory, drive space and drive busy time, then what is using them.",
    steps: [
      { check: "perf", why: "One sample of processor, memory, free space and drive busy time, with the busiest programs. Read it twice, a few seconds apart, before deciding." },
      { check: "disk", why: "A drive that is failing makes everything slow long before it fails outright." },
      { check: "storage-log", why: "Disk errors and retries in the System log back up a slow drive." },
      { check: "scm-log", why: "Services timing out or restarting over and over can be the load itself." },
    ], next: [{ to: "processes", label: "Processes (sort by processor or memory)" }, { to: "drives", label: "Drive health" }] },
  { id: "restart", symptom: "Random restarts or blue screens", start: "What the machine logged before it went down.",
    steps: [
      { check: "critical-log", why: "Kernel-Power 41 means the machine lost power or froze without shutting down. BugCheck 1001 means a blue screen with a code." },
      { check: "storage-log", why: "Disk errors just before a crash point at the drive or its controller." },
      { check: "devices", why: "A device with a problem code can be the driver that is crashing the machine." },
      { check: "updates", why: "If the first crash came soon after an update or driver install, that is the change to look at first." },
      { check: "perf", why: "Memory almost full, or a drive nearly full, can both end in crashes." },
    ], next: [{ to: "crashes", label: "Crashes and restarts (timeline and reboot loops)" }, { to: "drives", label: "Drive health" }] },
  { id: "update", symptom: "A Windows update fails, or something stopped working after an update", start: "What was installed, what failed, and whether there is room to install.",
    steps: [
      { check: "updates", why: "Failed installs with their error codes, and what is still waiting. Compare the install dates with when the problem began." },
      { check: "perf", why: "Updates fail when the system drive is short of space; free space under 10 GB is flagged." },
      { check: "services", why: "Windows Update, Background Intelligent Transfer and Cryptographic Services must be able to start." },
      { check: "devices", why: "A driver that came with the update can leave a device in an error state." },
    ], next: [{ to: "updates", label: "Windows updates" }, { to: "devices", label: "Devices and drivers" }] },
  { id: "disk", symptom: "The hard drive may be failing", start: "What the drive reports about itself, and what Windows logged.",
    steps: [
      { check: "disk", why: "Health, reallocated and pending sectors and uncorrectable errors. Healthy here is not a guarantee." },
      { check: "storage-log", why: "Disk and controller errors in the log are the second opinion." },
      { check: "perf", why: "A drive that is busy all the time with a long queue is struggling." },
    ], next: [{ to: "drives", label: "Drive health" }] },
  { id: "service", symptom: "A service keeps stopping", start: "Is it set to start, what account does it use, what does it depend on, and what did Windows log.",
    steps: [
      { check: "services", why: "State, start type, the account it runs as and the program it launches. Restart it once and watch; repeated restarts hide the cause." },
      { check: "scm-log", why: "The reason Windows gives for each stop: a dependency that did not start, a timeout, a crash." },
      { check: "app-log", why: "The application's own errors from the same minute." },
    ], next: [{ to: "services", label: "Services (restart, watch and auto-restart)" }] },
];

const STATUS_TEXT = { passed: "Looks fine", failed: "Look closer", running: "Running", waiting: "Waiting" } as const;

export function Troubleshoot({ cabinetId, cabinetName }: { cabinetId: string; cabinetName: string }) {
  const [id, setId] = useState(PLAYBOOKS[0]!.id);
  const playbook = PLAYBOOKS.find(p => p.id === id)!;
  const checks = useMemo<Check[]>(() => playbook.steps.map(s => CHECK_BY_ID[s.check]!), [playbook]);
  const { rows, busy, start } = useChecks(cabinetId, checks);
  const [actions, setActions] = useState("");
  const [result, setResult] = useState("");
  const [copied, setCopied] = useState(false);
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
      <h2 id="troubleshoot-heading">Troubleshoot {cabinetName}</h2>
      <p className="muted small">Pick what the customer is describing. The checks run in the order a technician would do them by hand, and each says what its answer means. They only read; nothing on the cabinet changes.</p>
      <label htmlFor="symptom">What is wrong?</label>
      <select id="symptom" value={id} onChange={e => { setId(e.target.value); setCopied(false); }} disabled={busy}>
        {PLAYBOOKS.map(p => <option key={p.id} value={p.id}>{p.symptom}</option>)}
      </select>
      <p className="small"><strong>Start here:</strong> {playbook.start}</p>
      <button className="btn primary" onClick={() => { setCopied(false); void start(); }} disabled={busy}>{busy ? "Running the checks…" : ran ? "Run the checks again" : "Run the checks"}</button>
      <ol className="plain live-check">{playbook.steps.map(s => {
        const c = CHECK_BY_ID[s.check]!, r = rows[c.id];
        return (
          <li key={c.id} className="row gap wrap">
            <span style={{ minWidth: "6.5rem" }}>{!r ? <Badge tone="off">Not run</Badge> : <Badge tone={r.status === "passed" ? "ok" : r.status === "failed" ? "warn" : "info"}>{STATUS_TEXT[r.status]}</Badge>}</span>
            <strong>{c.label}</strong>
            <div className="small muted" style={{ flexBasis: "100%" }}>{s.why}</div>
            {r?.text && <div className="small" style={{ flexBasis: "100%" }}>{r.text}</div>}
            {r?.raw && <details style={{ flexBasis: "100%" }}><summary className="small">What the cabinet sent</summary><pre className="small" style={{ maxHeight: "16rem", overflow: "auto" }}>{r.raw}</pre></details>}
          </li>);
      })}</ol>
      <p className="small"><strong>Then look at:</strong> {playbook.next.map((x, i) => <span key={x.to}>{i > 0 && " · "}<Link to={`/cabinets/${cabinetId}/${x.to}`}>{x.label}</Link></span>)}</p>
      <h3>Case notes</h3>
      <label htmlFor="case-actions">Actions taken</label>
      <textarea id="case-actions" rows={2} value={actions} onChange={e => setActions(e.target.value.slice(0, 1000))} />
      <label htmlFor="case-result">Result and next steps</label>
      <textarea id="case-result" rows={2} value={result} onChange={e => setResult(e.target.value.slice(0, 1000))} />
      <p><button className="btn" onClick={() => void copy()}>{copied ? "Copied" : "Copy case notes"}</button></p>
    </section>
  );
}
