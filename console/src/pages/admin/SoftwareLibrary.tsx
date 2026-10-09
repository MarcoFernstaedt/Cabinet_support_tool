// The software library (docs/spec/06-console-spec.md "Admin screens"): upload a driver package or MSI,
// which the server checks (hash, signature, trusted publisher) as it arrives; a second Admin approves it;
// any Admin retires it. Each step asks for an authenticator code, and the server enforces the two-person rule.
import { useRef, useState } from "react";
import { api, describeError, upload } from "../../lib/api";
import { useSession } from "../../lib/session";
import { bytes, fullTime } from "../../lib/time";
import { Breadcrumbs } from "../../components/Layout";
import { Badge, Empty, StepUpDialog } from "../../components/ui";
import { useLoad } from "../../lib/useLoad";
import type { LibraryPackage } from "../cabinet/Software";

const STATE: Record<string, ["ok" | "warn" | "crit" | "info" | "off", string]> = {
  uploading: ["info", "Uploading"], uploaded: ["warn", "Waiting for a second Admin"], approved: ["ok", "Approved"], retired: ["off", "Retired"], refused: ["crit", "Refused"],
};

interface Draft { name: string; version: string; vendor: string; packageType: "driver" | "msi"; hardwareIds: string; notes: string }
const EMPTY: Draft = { name: "", version: "", vendor: "", packageType: "driver", hardwareIds: "", notes: "" };

export function SoftwareLibrary() {
  const { me } = useSession();
  const { data, problem, reload } = useLoad<LibraryPackage[]>("/api/admin/packages");
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [confirmUpload, setConfirmUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const [action, setAction] = useState<{ kind: "approve" | "retire"; p: LibraryPackage } | null>(null);
  const hardwareIds = draft.hardwareIds.split(/[\n,]/).map(h => h.trim()).filter(Boolean);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft(d => ({ ...d, [k]: v }));

  const send = async (token: string) => {
    // The metadata (with the step-up token) first, then the file itself; the server checks the file as it arrives.
    const { packageId } = await api<{ packageId: string }>("POST", "/api/admin/packages", {
      name: draft.name.trim(), version: draft.version.trim(), vendor: draft.vendor.trim(), packageType: draft.packageType, hardwareIds,
      ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}), stepUpToken: token });
    setUploading(true);
    setOutcome(null);
    upload<LibraryPackage>(`/api/admin/packages/${packageId}/content`, file!).then(
      p => { setOutcome({ ok: true, text: `${p.name} ${p.version} passed the server's checks (signed by ${p.signer}). Another Admin must approve it before cabinets can install it.` }); setDraft(EMPTY); setFile(null); if (fileInput.current) fileInput.current.value = ""; },
      e => setOutcome({ ok: false, text: `The server refused the package. ${describeError(e)}` }))
      .finally(() => { setUploading(false); reload(); });
  };

  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Software library" }]} />
      <h1>Software library</h1>
      <p className="muted">The only way files reach a cabinet. Each package is checked by the server on upload and again by the cabinet before it installs, and needs a second Admin's approval.</p>

      <section className="panel" aria-labelledby="upload-heading">
        <h2 id="upload-heading">Upload a package</h2>
        <form className="form" onSubmit={e => { e.preventDefault(); setConfirmUpload(true); }}>
          <div className="row gap wrap">
            <label className="field inline"><span>Name</span><input required maxLength={128} value={draft.name} onChange={e => set("name", e.target.value)} /></label>
            <label className="field inline"><span>Version</span><input required maxLength={64} value={draft.version} onChange={e => set("version", e.target.value)} /></label>
            <label className="field inline"><span>Vendor</span><input required maxLength={128} value={draft.vendor} onChange={e => set("vendor", e.target.value)} /></label>
            <label className="field inline"><span>Type</span><select value={draft.packageType} onChange={e => set("packageType", e.target.value as Draft["packageType"])}>
              <option value="driver">Driver package (.zip with .inf and signed .cat)</option><option value="msi">Installer (.msi)</option></select></label>
          </div>
          <label className="field"><span>Hardware IDs it is for (one per line; leave empty for an installer meant for any cabinet)</span>
            <textarea rows={3} value={draft.hardwareIds} onChange={e => set("hardwareIds", e.target.value)} /></label>
          <label className="field"><span>Notes (optional)</span><input maxLength={256} value={draft.notes} onChange={e => set("notes", e.target.value)} /></label>
          <label className="field"><span>File</span><input ref={fileInput} required type="file" accept={draft.packageType === "msi" ? ".msi" : ".zip"} onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
          <button className="btn primary" type="submit" disabled={!file || uploading}>{uploading ? "Uploading and checking…" : "Upload"}</button>
        </form>
        {outcome && <p className={outcome.ok ? "notice ok" : "notice crit"} role={outcome.ok ? "status" : "alert"}>{outcome.text}</p>}
        <StepUpDialog open={confirmUpload} action="package.upload" target="fleet" onClose={() => setConfirmUpload(false)} onToken={send}
          description={<p>Upload <strong>{draft.name} {draft.version}</strong> from {draft.vendor} ({file ? `${file.name}, ${bytes(file.size)}` : "no file"}) to the software library.</p>} />
      </section>

      <section className="panel" aria-labelledby="library-heading">
        <h2 id="library-heading">Packages</h2>
        {problem && <p className="error" role="alert">{problem}</p>}
        {data && data.length === 0 && <Empty>No packages yet.</Empty>}
        {data && data.length > 0 && (
          <table className="table compact">
            <caption className="sr-only">Every package in the library</caption>
            <thead><tr><th scope="col">Package</th><th scope="col">State</th><th scope="col">Signer and hash</th><th scope="col">People</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{data.map(p => {
              const [tone, label] = STATE[p.state] ?? ["off", p.state];
              return (
                <tr key={p.id}>
                  <th scope="row">{p.name} {p.version}<div className="muted small">{p.vendor} · {p.type === "driver" ? "driver" : "MSI"}{p.sizeBytes !== null && ` · ${bytes(p.sizeBytes)}`}</div>
                    {p.hardwareIds.length > 0 && <div className="muted small wrap">{p.hardwareIds.join(", ")}</div>}</th>
                  <td><Badge tone={tone}>{label}</Badge>{p.refusal && <div className="small">{p.refusal}</div>}</td>
                  <td className="small">{p.signer ?? "—"}{p.sha256 && <div className="muted wrap"><code>{p.sha256}</code></div>}</td>
                  <td className="small">Uploaded by {p.uploadedBy.name} {fullTime(p.uploadedAt)}
                    {p.approvedBy && <div>Approved by {p.approvedBy.name} {fullTime(p.approvedAt)}</div>}
                    {p.retiredBy && <div>Retired by {p.retiredBy.name} {fullTime(p.retiredAt)}</div>}</td>
                  <td>
                    {p.state === "uploaded" && (p.uploadedBy.id === me.id
                      ? <span className="muted small">Another Admin must approve</span>
                      : <button className="btn primary small" onClick={() => setAction({ kind: "approve", p })}>Approve</button>)}
                    {(p.state === "approved" || p.state === "uploaded") && <button className="btn small danger" onClick={() => setAction({ kind: "retire", p })}>Retire</button>}
                  </td>
                </tr>);
            })}</tbody>
          </table>)}
        <StepUpDialog open={action !== null} action={action?.kind === "retire" ? "package.retire" : "package.approve"} target={action?.p.id ?? ""} onClose={() => setAction(null)}
          description={action && (action.kind === "approve"
            ? <><p>Approve <strong>{action.p.name} {action.p.version}</strong> so Tier 2 and Admins can install it on cabinets.</p>
                <p className="small">Signed by {action.p.signer}; SHA-256 <code className="wrap">{action.p.sha256}</code>. Uploaded by {action.p.uploadedBy.name}.</p></>
            : <p>Retire <strong>{action.p.name} {action.p.version}</strong>. It can no longer be installed; installs already made are not changed.</p>)}
          onToken={async token => { await api("POST", `/api/admin/packages/${action!.p.id}/${action!.kind}`, { stepUpToken: token }); reload(); }} />
      </section>
    </div>
  );
}
