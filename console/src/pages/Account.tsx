import { CaseNotes } from "../components/CaseNotes";
import { useState } from "react";
import { roleName, useSession } from "../lib/session";
import { PasswordChange, TotpSetup } from "./SignIn";
import { OwnSignIns } from "../components/SignIns";

export function Account({ onTour }: { onTour: () => void }) {
  const { me, refresh } = useSession();
  const [mode, setMode] = useState<"view" | "password" | "totp">("view");
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? "dark");
  if (mode === "password") return <PasswordChange forced={false} onCancel={() => setMode("view")} onStage={() => { setMode("view"); void refresh(); }} />;
  if (mode === "totp") return <TotpSetup required={false} onCancel={() => setMode("view")} onStage={() => { setMode("view"); void refresh(); }} />;
  const switchTheme = (t: string) => {
    setTheme(t);
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("theme", t); } catch { /* storage unavailable */ }
  };
  return (
    <div className="page">
      <h1>Your account</h1>
      <section className="panel">
        <h2>{me.name}</h2>
        <p>Username <strong>{me.username}</strong> · {roleName(me.role)}</p>
      </section>
      <CaseNotes title="Activity summary: everything you did" />
      <section className="panel">
        <h2>Two-factor sign-in</h2>
        {me.totpEnabled ? <p>On. You sign in with your authenticator app, and confirm changes that need a code with it. It stays on for every account; an admin can reset it if you lose your phone.</p>
          : <><p>Off. Turn it on to protect your account with an authenticator app.</p><button className="btn" onClick={() => setMode("totp")}>Turn on two-factor</button></>}
      </section>
      <section className="panel">
        <h2>Recent sign-ins</h2>
        <OwnSignIns />
      </section>
      <section className="panel">
        <h2>Password</h2>
        <button className="btn" onClick={() => setMode("password")}>Change password</button>
      </section>
      <section className="panel">
        <h2>Appearance</h2>
        <fieldset className="row gap"><legend className="sr-only">Theme</legend>
          {["dark", "light"].map(t => <label key={t} className="check"><input type="radio" name="theme" checked={theme === t} onChange={() => switchTheme(t)} /> {t === "dark" ? "Dark" : "Light"}</label>)}
        </fieldset>
      </section>
      <section className="panel">
        <h2>Tour</h2>
        <p>The guided tour of the console.</p>
        <button className="btn" onClick={onTour}>Run the tour</button>
      </section>
    </div>
  );
}
