import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useStepUp } from "../../components/StepUp";

type RecordRow = { id: string; kind: string; opened_at: string; closed_at: string | null };
type Frame = { kind?: string; data?: string; code?: number };
const encode = (text: string) => btoa(Array.from(new TextEncoder().encode(text), b => String.fromCharCode(b)).join(""));
const decode = (data: string) => new TextDecoder().decode(Uint8Array.from(atob(data), c => c.charCodeAt(0)));

/** All state is scoped to this mounted session; no browser or cross-session command history. */
export function DevelopmentShell({ cabinetId }: { cabinetId: string }) {
  const [available, setAvailable] = useState(false), [sessions, setSessions] = useState<RecordRow[]>([]);
  const [active, setActive] = useState<string | null>(null), [view, setView] = useState<string | null>(null);
  const [text, setText] = useState(""), [input, setInput] = useState(""), [reason, setReason] = useState("");
  const [problem, setProblem] = useState(""), [busy, setBusy] = useState(false);
  const step = useStepUp();
  const refresh = async () => {
    const data = await api<{ developmentShell: boolean; sessions: RecordRow[] }>("GET", `/api/cabinets/${cabinetId}/sessions`, undefined, { background: true });
    setAvailable(data.developmentShell); setSessions(data.sessions.filter(s => s.kind === "shell"));
  };
  useEffect(() => { void refresh().catch(() => setAvailable(false)); }, [cabinetId]);
  const record = async (id: string) => {
    const data = await api<{ frames: { direction: string; frame: Frame | string }[] }>("GET", `/api/sessions/${id}/record`);
    setText(data.frames.map(entry => {
      const frame = typeof entry.frame === "string" ? JSON.parse(entry.frame) as Frame : entry.frame;
      return `${entry.direction}: ${frame.kind}\n${frame.data ? decode(frame.data) : JSON.stringify(frame)}\n`;
    }).join(""));
  };
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const poll = async () => {
      try {
        const { frame } = await api<{ frame: Frame | null }>("POST", `/api/sessions/${active}/frames`, { control: "keepalive" }, { background: true });
        if (!stopped && view === active && frame?.data) setText(t => (t + decode(frame.data!)).slice(-262144));
        if (!stopped && frame?.kind === "shell.exit") { setActive(null); await record(active); await refresh(); }
      } catch (e) { if (!stopped) { setActive(null); setProblem(String(e)); await record(active).catch(() => undefined); await refresh().catch(() => undefined); } }
      if (!stopped) timer = window.setTimeout(() => void poll(), 300);
    };
    let timer = window.setTimeout(() => void poll(), 300);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [active, view]);
  const send = async (frame: object) => {
    if (!active || busy) return;
    setBusy(true); setProblem("");
    try {
      const result = await api<{ frame: Frame | null }>("POST", `/api/sessions/${active}/frames`, frame);
      if (result.frame?.data) setText(t => (t + decode(result.frame!.data!)).slice(-262144));
      setInput("");
    } catch (e) { setProblem(String(e)); }
    finally { setBusy(false); }
  };
  if (!available && sessions.length === 0) return null;
  return <section aria-label="Development shell">
    <h2>Shell sessions</h2>
    {available && <p role="note"><strong>Development only.</strong> Full shell access on this cabinet. Input and output are recorded. No command history is saved in this browser.</p>}
    {problem && <p role="alert">{problem}</p>}
    {available && !active && <form onSubmit={e => {
      e.preventDefault();
      const body = { kind: "shell", reason };
      step.ask("session.open", cabinetId, "Open a development shell on this cabinet", async stepUpToken => {
        const opened = await api<{ sessionId: string }>("POST", `/api/cabinets/${cabinetId}/sessions`, { ...body, stepUpToken });
        setText(""); setInput(""); setActive(opened.sessionId); setView(opened.sessionId); await refresh();
      }, body);
    }}><label>Why this session? <input required maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} /></label> <button>Open development shell</button></form>}
    {active && <>
      <form onSubmit={e => { e.preventDefault(); void send({ kind: "shell.in", data: encode(input + "\r") }); }}>
        <label>Shell input <input autoComplete="off" spellCheck={false} value={input} onChange={e => setInput(e.target.value)} /></label>
        <button disabled={busy}>Send</button>
      </form>
      <button disabled={busy} onClick={() => void send({ kind: "shell.in", data: encode("\u0003") })}>Interrupt (Ctrl+C)</button>
      <button disabled={busy} onClick={() => void send({ kind: "shell.resize", columns: 120, rows: 30 })}>Resize to 120 × 30</button>
      <button onClick={() => { void api("POST", `/api/sessions/${active}/end`, { reason: "Operator ended development shell" }).then(async () => { setActive(null); await record(active); await refresh(); }).catch(e => setProblem(String(e))); }}>End session</button>
    </>}
    {view && <pre aria-label="Shell transcript">{text}</pre>}
    {sessions.length > 0 && <details><summary>Session records and command logs</summary><ul>{sessions.map(s => <li key={s.id}>
      <button onClick={() => { setView(s.id); void record(s.id).catch(e => setProblem(String(e))); }}>{s.opened_at} · {s.closed_at ? "ended" : "live"}</button>
    </li>)}</ul></details>}
    {step.dialog}
  </section>;
}
