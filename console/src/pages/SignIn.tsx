// Sign-in (docs/spec/06-console-spec.md): username and password, then the authenticator
// code. Every account sets up the authenticator at first sign-in,
// and anyone with a temporary password chooses a new one, before anything else.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, describeError } from "../lib/api";

export type Stage = "signed_out" | "totp" | "totp_setup" | "password_change" | "complete";

function Card({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <main className="signin" id="main">
      <div className="signin-card">
        <p className="brand"><span aria-hidden="true">▣</span> Cabinet Diagnostics</p>
        <h1>{title}</h1>
        {intro && <div className="muted">{intro}</div>}
        {children}
      </div>
    </main>
  );
}

function useSubmit(action: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try { await action(); } catch (err) { setProblem(describeError(err)); } finally { setBusy(false); }
  };
  return { busy, problem, submit };
}

export function SignIn({ onStage }: { onStage: (stage: Stage) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const { busy, problem, submit } = useSubmit(async () => {
    const r = await api<{ stage: Stage }>("POST", "/api/auth/login", { username: username.trim().toLowerCase(), password });
    onStage(r.stage);
  });
  return (
    <Card title="Sign in" intro="For Mashura support staff. Every cabinet you open and every action you take is recorded.">
      <form onSubmit={submit} className="stack">
        <label className="field"><span>Username</span>
          <input autoFocus autoComplete="username" required value={username} onChange={e => setUsername(e.target.value)} /></label>
        <label className="field"><span>Password</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
        {problem && <p className="error" role="alert">{problem}</p>}
        <button className="btn primary wide" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </Card>
  );
}

function CodeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="field"><span>6-digit code from your authenticator app</span>
      <input autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={value}
        onChange={e => onChange(e.target.value.replace(/\D/g, ""))} /></label>
  );
}

export function TotpStep({ onStage, onCancel }: { onStage: (s: Stage) => void; onCancel: () => void }) {
  const [code, setCode] = useState("");
  const { busy, problem, submit } = useSubmit(async () => onStage((await api<{ stage: Stage }>("POST", "/api/auth/totp", { code })).stage));
  return (
    <Card title="Enter your code" intro="Open your authenticator app and enter the current code for Cabinet Diagnostics.">
      <form onSubmit={submit} className="stack">
        <CodeField value={code} onChange={setCode} />
        {problem && <p className="error" role="alert">{problem}</p>}
        <button className="btn primary wide" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Continue"}</button>
        <button type="button" className="btn ghost wide" onClick={onCancel}>Use a different account</button>
      </form>
    </Card>
  );
}

/** The secret in groups of four, which is how authenticator apps ask for a manual key. */
const grouped = (s: string) => s.match(/.{1,4}/g)?.join(" ") ?? s;

export function TotpSetup({ onStage, onCancel, required }: { onStage: (s: Stage) => void; onCancel: () => void; required: boolean }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [code, setCode] = useState("");
  useEffect(() => { api<{ secret: string; otpauthUri: string }>("GET", "/api/auth/totp/setup").then(setSetup, e => setLoadProblem(describeError(e))); }, []);
  const { busy, problem, submit } = useSubmit(async () => onStage((await api<{ stage: Stage }>("POST", "/api/auth/totp/setup", { code })).stage));
  return (
    <Card title="Set up your authenticator" intro={required
      ? "Every account signs in with a code from an authenticator app (Microsoft Authenticator, Google Authenticator or similar), and confirms some changes with it. Set it up now to continue."
      : "Turn on two-factor sign-in with an authenticator app."}>
      {loadProblem && <p className="error" role="alert">{loadProblem}</p>}
      {setup && (
        <form onSubmit={submit} className="stack">
          <ol className="steps">
            <li>In your authenticator app, add an account and choose to enter a setup key.</li>
            <li>Account name: <strong>Cabinet Diagnostics</strong>. Key: <code className="secret" aria-label={`Setup key ${setup.secret.split("").join(" ")}`}>{grouped(setup.secret)}</code> (time-based).</li>
            <li>On a phone, you can instead <a href={setup.otpauthUri}>open this link</a> to add it directly.</li>
            <li>Enter the code the app now shows.</li>
          </ol>
          <CodeField value={code} onChange={setCode} />
          {problem && <p className="error" role="alert">{problem}</p>}
          <button className="btn primary wide" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Turn on two-factor"}</button>
          <button type="button" className="btn ghost wide" onClick={onCancel}>{required ? "Sign out" : "Cancel"}</button>
        </form>
      )}
    </Card>
  );
}

export function PasswordChange({ onStage, onCancel, forced }: { onStage: (s: Stage) => void; onCancel: () => void; forced: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const { busy, problem, submit } = useSubmit(async () => {
    if (next !== again) { setMismatch(true); return; }
    setMismatch(false);
    onStage((await api<{ stage: Stage }>("POST", "/api/auth/password", { currentPassword: current, newPassword: next })).stage);
  });
  return (
    <Card title={forced ? "Choose your password" : "Change password"} intro={forced ? "You signed in with a temporary password. Choose your own to continue." : undefined}>
      <form onSubmit={submit} className="stack">
        <label className="field"><span>{forced ? "Temporary password" : "Current password"}</span>
          <input type="password" autoComplete="current-password" required value={current} onChange={e => setCurrent(e.target.value)} /></label>
        <label className="field"><span>New password (at least 12 characters)</span>
          <input type="password" autoComplete="new-password" minLength={12} required value={next} onChange={e => setNext(e.target.value)} /></label>
        <label className="field"><span>New password again</span>
          <input type="password" autoComplete="new-password" minLength={12} required value={again} onChange={e => setAgain(e.target.value)} /></label>
        {mismatch && <p className="error" role="alert">The new passwords do not match.</p>}
        {problem && <p className="error" role="alert">{problem}</p>}
        <button className="btn primary wide" disabled={busy}>{busy ? "Saving…" : "Save password"}</button>
        <button type="button" className="btn ghost wide" onClick={onCancel}>{forced ? "Sign out" : "Cancel"}</button>
      </form>
    </Card>
  );
}
