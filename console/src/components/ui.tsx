import { paramsHash } from "../lib/confirm";
import { useId, useEffect, useRef, useState, type ReactNode } from "react";
import { api, describeError } from "../lib/api";
import type { CommandResult, Run } from "../lib/commands";
import { fullTime } from "../lib/time";

/** Online or offline, always with a word, never color alone. */
export function OnlineBadge({ online }: { online: boolean }) {
  return <span className={`badge ${online ? "ok" : "off"}`}><span aria-hidden="true">{online ? "●" : "○"}</span> {online ? "Online" : "Offline"}</span>;
}

export function Badge({ tone, children }: { tone: "ok" | "warn" | "crit" | "info" | "off"; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export const OUTCOME_TONE = { pass: "ok", warn: "warn", fail: "crit", unknown: "off" } as const;
export const OUTCOME_LABEL = { pass: "Pass", warn: "Check", fail: "Problem", unknown: "Unknown" } as const;

/** The common frame of a diagnostic: title, run button, progress, and the answer or why there is none. */
export function OperationPanel<T>({ title, description, run, onRun, buttonLabel = "Run", children }: {
  title: string; description?: string; run: Run<T>; onRun: () => void; buttonLabel?: string; children?: (output: T) => ReactNode;
}) {
  const busy = run.state === "running";
  return (
    <section className="panel" aria-busy={busy}>
      <div className="panel-head">
        <div>
          <h3>{title}</h3>
          {description && <p className="muted small">{description}</p>}
        </div>
        <button className="btn primary" onClick={onRun} disabled={busy}>{busy ? "Running…" : run.state === "done" ? "Run again" : buttonLabel}</button>
      </div>
      <div aria-live="polite">
        {busy && <p className="muted">Waiting for the cabinet to answer…</p>}
        {!busy && run.problem && <p className="error" role="alert">{run.problem}</p>}
        {!busy && run.result && run.result.status !== "succeeded" && <ResultProblem result={run.result} />}
        {!busy && run.result?.status === "succeeded" && run.result.output !== undefined && (
          <>
            {children?.(run.result.output)}
            <p className="muted small">Answered {fullTime(run.result.finishedAt ?? run.at)}</p>
          </>
        )}
      </div>
    </section>
  );
}

export function ResultProblem({ result }: { result: CommandResult }) {
  const label = result.status === "rejected" ? "The cabinet refused this command" : result.status === "expired" ? "No answer" : "The operation failed";
  return (
    <div className="notice crit" role="alert">
      <strong>{label}</strong>{result.error && <> ({result.error.code}): {result.error.message}</>}
    </div>
  );
}

/** Asks for a fresh authenticator code and turns it into a token bound to exactly this action and target. */
/**
 * Confirmation with an authenticator code. When params is given, the token is bound to exactly those parameters
 * (their canonical hash), so it cannot be used for any other change.
 */
export function StepUpDialog({ open, action, target, description, onToken, onClose, params }: {
  open: boolean; action: string; target: string; description: ReactNode; onToken: (token: string) => Promise<void>; onClose: () => void; params?: unknown;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { setCode(""); setProblem(null); d.showModal(); }
    if (!open && d.open) d.close();
  }, [open]);
  const submit = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const bound = params === undefined ? {} : { paramsHash: await paramsHash(params) };
      const { token } = await api<{ token: string }>("POST", "/api/auth/step-up", { code, action, target, ...bound });
      await onToken(token);
      onClose();
    } catch (e) { setProblem(describeError(e)); }
    finally { setBusy(false); }
  };
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="stepup-title" onClose={onClose}>
      <form method="dialog" onSubmit={e => { e.preventDefault(); void submit(); }}>
        <h2 id="stepup-title">Confirm with your authenticator</h2>
        <div className="dialog-body">{description}</div>
        <label className="field">
          <span>Authenticator code</span>
          <input autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, ""))} />
        </label>
        {problem && <p className="error" role="alert">{problem}</p>}
        <div className="row gap end">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || code.length !== 6}>{busy ? "Confirming…" : "Confirm"}</button>
        </div>
      </form>
    </dialog>
  );
}

/** Confirmation with a click: single-cabinet changes that are quick to undo or heal themselves (docs/spec/12-milestones-8-to-12.md). */
export function ConfirmDialog({ open, title = "Confirm the change", description, confirmLabel = "Make the change", onConfirm, onClose }: {
  open: boolean; title?: string; description: ReactNode; confirmLabel?: string; onConfirm: () => Promise<void>; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { setProblem(null); d.showModal(); }
    if (!open && d.open) d.close();
  }, [open]);
  const submit = async () => {
    setBusy(true);
    setProblem(null);
    try { await onConfirm(); onClose(); } catch (e) { setProblem(describeError(e)); } finally { setBusy(false); }
  };
  return (
    <dialog ref={ref} className="dialog" aria-labelledby={titleId} onClose={onClose}>
      <form method="dialog" onSubmit={e => { e.preventDefault(); void submit(); }}>
        <h2 id={titleId}>{title}</h2>
        <div className="dialog-body">{description}</div>
        {problem && <p className="error" role="alert">{problem}</p>}
        <div className="row gap end">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" autoFocus disabled={busy}>{busy ? "Sending…" : confirmLabel}</button>
        </div>
      </form>
    </dialog>
  );
}

/** Confirmation with the password again, for a change to more than one cabinet; the token is bound to the scope and parameters. */
export function PasswordDialog({ open, action, target, params, description, onToken, onClose }: {
  open: boolean; action: string; target: string; params: unknown; description: ReactNode; onToken: (token: string) => Promise<void>; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { setPassword(""); setProblem(null); d.showModal(); }
    if (!open && d.open) d.close();
  }, [open]);
  const submit = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const { token } = await api<{ token: string }>("POST", "/api/auth/confirm-password", { password, action, target, paramsHash: await paramsHash(params) });
      setPassword("");
      await onToken(token);
      onClose();
    } catch (e) { setProblem(describeError(e)); }
    finally { setBusy(false); }
  };
  return (
    <dialog ref={ref} className="dialog" aria-labelledby={titleId} onClose={onClose}>
      <form method="dialog" onSubmit={e => { e.preventDefault(); void submit(); }}>
        <h2 id={titleId}>Confirm with your password</h2>
        <div className="dialog-body">{description}</div>
        <label className="field">
          <span>Your password</span>
          <input type="password" autoFocus autoComplete="current-password" required maxLength={256} value={password} onChange={e => setPassword(e.target.value)} />
        </label>
        {problem && <p className="error" role="alert">{problem}</p>}
        <div className="row gap end">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || password.length === 0}>{busy ? "Confirming…" : "Confirm"}</button>
        </div>
      </form>
    </dialog>
  );
}

export function KeyValues({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v ?? <span className="muted">unknown</span>}</dd></div>)}
    </dl>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty muted">{children}</p>;
}

/** A write's progress and answer, under the control that started it. */
export function WriteOutcome<T>({ run, done }: { run: Run<T>; done: (output: T) => ReactNode }) {
  if (run.state === "idle") return null;
  return (
    <div aria-live="polite" className="write-outcome">
      {run.state === "running" && <p className="muted" role="status">Sent. Waiting for the cabinet to make the change…</p>}
      {run.state === "done" && run.problem && <p className="error" role="alert">{run.problem}</p>}
      {run.state === "done" && run.result && run.result.status !== "succeeded" && <ResultProblem result={run.result} />}
      {run.state === "done" && run.result?.status === "succeeded" && run.result.output !== undefined && <div className="notice ok" role="status">{done(run.result.output)}</div>}
    </div>
  );
}

/** The safety net, in words, for confirmations of network and firewall changes. */
export const SAFETY_NET_NOTE = "If the cabinet cannot reach the server within 2 minutes after the change, it puts the old settings back by itself.";
