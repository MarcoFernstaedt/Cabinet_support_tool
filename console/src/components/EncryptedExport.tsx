// Downloads an evidence package encrypted with a passphrase chosen here. The passphrase goes in the request body (never a URL) and is not kept.
import { useState } from "react";
import { describeError } from "../lib/api";

export function EncryptedExport({ cabinetId, days }: { cabinetId: string; days: string }) {
  const [open, setOpen] = useState(false);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setProblem(null);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/evidence/encrypted`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ days, passphrase: pass }) });
      if (!r.ok) throw new Error(r.status === 400 ? "Use a passphrase of 12 to 128 characters." : "The package could not be made.");
      const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "evidence.cabev";
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
      setPass(""); setOpen(false);
    } catch (e) { setProblem(e instanceof Error && e.message ? e.message : describeError(e)); } finally { setBusy(false); }
  };
  if (!open) return <button className="btn small" onClick={() => setOpen(true)}>Download encrypted</button>;
  return (
    <form className="row gap wrap" onSubmit={e => { e.preventDefault(); void go(); }}>
      <label className="field inline"><span>Passphrase</span><input type="password" autoComplete="new-password" minLength={12} maxLength={128} value={pass} onChange={e => setPass(e.target.value)} autoFocus /></label>
      <button className="btn small primary" disabled={busy || pass.length < 12}>{busy ? "Preparing…" : "Download"}</button>
      <button type="button" className="btn small ghost" onClick={() => { setOpen(false); setPass(""); }}>Cancel</button>
      {problem && <span className="error" role="alert">{problem}</span>}
    </form>
  );
}
