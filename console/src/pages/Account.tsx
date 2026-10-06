import { useState } from "react";
import { roleName, useSession } from "../lib/session";
import { PasswordChange, TotpSetup } from "./SignIn";

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
      <section className="panel">
        <h2>Two-factor sign-in</h2>
        {me.totpEnabled ? <p>On. You confirm sign-in and every change with your authenticator app.{me.role !== "tier1" && " Tier 2 and Admin accounts keep it on; an admin can reset it if you lose your phone."}</p>
          : <><p>Off. Turn it on to protect your account with an authenticator app.</p><button className="btn" onClick={() => setMode("totp")}>Turn on two-factor</button></>}
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
        <h2>Getting started</h2>
        <p>A short tour of the console.</p>
        <button className="btn" onClick={onTour}>Run the tour again</button>
      </section>
    </div>
  );
}
