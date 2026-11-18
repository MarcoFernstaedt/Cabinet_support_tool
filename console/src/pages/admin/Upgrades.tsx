// Upgrades (docs/spec/06-console-spec.md "Admin screens"; docs/spec/07-upgrade-channel.md): add a signed agent release
// to the update store, start a staged rollout with step-up, pause, resume or stop it, and see each cabinet's result.
// A rollback is a new signed release with a higher version, rolled out the same way. The server enforces every rule
// shown here, and each cabinet checks every release again with its own compiled-in key before it installs anything.
// A release is one version for one Windows architecture and is only ever offered to cabinets built for it:
// the architecture is chosen here and never guessed from a cabinet's name.
import { useState } from "react";
import { api, describeError, upload } from "../../lib/api";
import { Link } from "../../lib/router";
import { bytes, fullTime } from "../../lib/time";
import { Breadcrumbs } from "../../components/Layout";
import { Badge, Empty } from "../../components/ui";
import { useStepUp } from "../../components/StepUp";
import { useLoad } from "../../lib/useLoad";
import { Pager, usePaged } from "../../components/Pager";
import { DEFAULT_INSTALL_ARCHITECTURE, INSTALL_ARCHITECTURES, architectureInfo, type InstallArchitecture } from "../../lib/install-command";
import { architectureLabel, architectureLine } from "../../lib/architecture";
import { TARGET_FILTERS, targetBadge, targetNote } from "../../lib/rollout-target";

interface Release { version: string; architecture: string | null; minimumVersion: string; sha256: string; sizeBytes: number; releasedAt: string; notes: string | null; state: string; refusal: string | null;
  keyId: string; addedBy: { id: string; name: string }; addedAt: string }
interface BatchCount { batch: number; total: number; succeeded: number; failed: number; offered: number; pending: number; skipped: number }
interface Rollout { id: string; version: string; architecture: string | null; state: "running" | "paused" | "completed" | "stopped"; currentBatch: number; successRatePercent: number; failureLimitPercent: number;
  startedBy: { id: string; name: string }; startedAt: string; pausedReason: string | null; finishedAt: string | null; batches: BatchCount[] }
interface Target { cabinetId: string; cabinet: string; site: string; client: string; batch: number; state: string; fromVersion: string | null; agentVersion: string | null;
  offeredAt: string | null; finishedAt: string | null; outcome: string | null; check: string | null; message: string | null; inOffice: boolean }
interface Candidate { id: string; name: string; site: string; client: string; architecture: string | null; agentVersion: string | null; inOffice: boolean; online: boolean }

const BATCH = ["", "One cabinet", "In-office cabinets", "About 5% of the field", "Everyone else"];
const ROLLOUT_TONE: Record<Rollout["state"], ["ok" | "warn" | "crit" | "info" | "off", string]> = {
  running: ["info", "Running"], paused: ["warn", "Paused"], completed: ["ok", "Completed"], stopped: ["off", "Stopped"],
};
const RELEASE_TONE: Record<string, ["ok" | "warn" | "crit" | "info" | "off", string]> = {
  awaiting_package: ["warn", "Waiting for its package"], ready: ["ok", "Ready"], refused: ["crit", "Refused"],
};
const CHECK: Record<string, string> = {
  download: "download", manifest_signature: "manifest signature", manifest: "manifest", package_hash: "package hash", version: "version",
  authenticode: "Authenticode signature", install: "install", check_in: "check-in within 5 minutes",
};

/** Base64 of a file's exact bytes: the manifest is sent exactly as it was signed. */
async function base64Of(file: File): Promise<string> {
  const data = new Uint8Array(await file.arrayBuffer());
  let text = "";
  for (let i = 0; i < data.length; i += 0x8000) text += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(text);
}

export function Upgrades() {
  const releases = useLoad<Release[]>("/api/admin/releases");
  const rollouts = useLoad<Rollout[]>("/api/admin/rollouts");
  const candidates = useLoad<Candidate[]>("/api/admin/upgrade-candidates");
  const rolloutsPaged = usePaged(rollouts.data ?? []);
  const releasesPaged = usePaged(releases.data ?? []);
  const step = useStepUp();
  const [done, setDone] = useState<{ ok: boolean; text: string } | null>(null);
  const after = (text: string, ok = true) => { setDone({ ok, text }); releases.reload(); rollouts.reload(); candidates.reload(); };
  const active = rollouts.data?.find(r => r.state === "running" || r.state === "paused") ?? null;

  const change = (r: Rollout, action: "pause" | "resume" | "stop") => step.ask(`rollout.${action}`, r.id,
    <><p>{action === "pause" ? "Pause" : action === "resume" ? "Resume" : "Stop"} the rollout of agent <strong>{r.version}</strong>.</p>
      {action === "resume" && r.pausedReason && <p className="notice warn">{r.pausedReason} Resuming accepts the failures so far; new ones above the limit pause it again.</p>}
      {action === "stop" && <p className="muted">No more cabinets are offered this version. Cabinets already upgraded keep it; to go back, publish the older code as a new release with a higher version.</p>}</>,
    async token => { await api("POST", `/api/admin/rollouts/${r.id}/${action}`, { stepUpToken: token }); after(`Rollout of ${r.version} ${action === "stop" ? "stopped" : action + "d"}.`); });

  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Upgrades" }]} />
      <h1>Agent upgrades</h1>
      <p className="muted">Releases are signed outside this server; cabinets verify signature, hash and version.</p>
      {done && <p className={`notice ${done.ok ? "ok" : "error"}`} role="status">{done.text}</p>}

      <section className="panel" aria-labelledby="rollouts">
        <h2 id="rollouts">Rollouts</h2>
        {rollouts.problem && <p className="error" role="alert">{rollouts.problem}</p>}
        {rollouts.data && (rollouts.data.length === 0 ? <Empty>No rollouts yet.</Empty> : (
          <table className="table">
            <caption className="sr-only">Rollouts, newest first</caption>
            <thead><tr><th scope="col">Version</th><th scope="col">State</th><th scope="col">Batches</th><th scope="col">Started</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{rolloutsPaged.rows.map(r => (
              <tr key={r.id}>
                <th scope="row"><Link to={`/admin/upgrades/${r.id}`}>{r.version}</Link><div className="small muted">{architectureLine(r.architecture)}</div></th>
                <td><Badge tone={ROLLOUT_TONE[r.state][0]}>{ROLLOUT_TONE[r.state][1]}</Badge>{r.state === "running" && <span className="muted"> batch {r.currentBatch}: {BATCH[r.currentBatch]}</span>}
                  {r.pausedReason && r.state === "paused" && <div className="small">{r.pausedReason}</div>}</td>
                <td><ul className="plain small">{r.batches.map(b => <li key={b.batch}>{BATCH[b.batch]}: {b.succeeded} of {b.total} upgraded{b.failed ? `, ${b.failed} failed` : ""}{b.offered ? `, ${b.offered} in progress` : ""}{b.skipped ? `, ${b.skipped} skipped` : ""}</li>)}</ul></td>
                <td><span title={fullTime(r.startedAt)}>{fullTime(r.startedAt)}</span> <span className="muted">by {r.startedBy.name}</span></td>
                <td><div className="row gap wrap">
                  {r.state === "running" && <button className="btn small" onClick={() => change(r, "pause")}>Pause</button>}
                  {r.state === "paused" && <button className="btn small primary" onClick={() => change(r, "resume")}>Resume</button>}
                  {(r.state === "running" || r.state === "paused") && <button className="btn small danger" onClick={() => change(r, "stop")}>Stop</button>}
                </div></td>
              </tr>))}
            </tbody>
          </table>))}
        <Pager {...rolloutsPaged} label="rollouts" />
      </section>

      <StartRollout releases={releases.data ?? []} candidates={candidates.data ?? []} blocked={active} ask={step.ask} after={after} />
      <AddRelease ask={step.ask} after={after} />

      <section className="panel" aria-labelledby="releases">
        <h2 id="releases">Releases in the update store</h2>
        {releases.problem && <p className="error" role="alert">{releases.problem}</p>}
        {releases.data && (releases.data.length === 0 ? <Empty>No releases yet.</Empty> : (
          <table className="table compact">
            <caption className="sr-only">Releases, newest first</caption>
            <thead><tr><th scope="col">Version</th><th scope="col">State</th><th scope="col">Upgrades from</th><th scope="col">Package</th><th scope="col">Added</th></tr></thead>
            <tbody>{releasesPaged.rows.map(r => (
              <tr key={`${r.version}-${r.architecture ?? "none"}`}>
                <th scope="row">{r.version}{r.notes && <div className="small muted">{r.notes}</div>}<div className="small muted">{architectureLine(r.architecture)}</div></th>
                <td><Badge tone={(RELEASE_TONE[r.state] ?? ["off", r.state])[0]}>{(RELEASE_TONE[r.state] ?? ["off", r.state])[1]}</Badge>{r.refusal && <div className="small">{r.refusal}</div>}</td>
                <td>{r.minimumVersion} or later</td>
                <td>{bytes(r.sizeBytes)} <code className="small" title={r.sha256}>{r.sha256.slice(0, 12)}…</code></td>
                <td>{fullTime(r.addedAt)} <span className="muted">by {r.addedBy.name}</span></td>
              </tr>))}
            </tbody>
          </table>))}
        <Pager {...releasesPaged} label="releases" />
      </section>

      <InOffice candidates={candidates.data} problem={candidates.problem} ask={step.ask} after={after} />
      {step.dialog}
    </div>
  );
}

type Ask = ReturnType<typeof useStepUp>["ask"];

function AddRelease({ ask, after }: { ask: Ask; after: (t: string, ok?: boolean) => void }) {
  const [files, setFiles] = useState<{ manifest: File | null; signature: File | null; pkg: File | null }>({ manifest: null, signature: null, pkg: null });
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(0);
  const [architecture, setArchitecture] = useState<InstallArchitecture>(DEFAULT_INSTALL_ARCHITECTURE);
  const chosen = architectureInfo(architecture);
  const submit = async () => {
    let manifest: string, signature: unknown, version: string;
    try {
      manifest = await base64Of(files.manifest!);
      signature = JSON.parse(await files.signature!.text());
      version = String((JSON.parse(await files.manifest!.text()) as { version?: unknown }).version ?? "");
    } catch { after("The manifest and signature must be the JSON files the build pipeline produced.", false); return; }
    ask("release.add", "fleet", <><p>Add agent release <strong>{version}</strong> for <strong>{chosen.label}</strong> to the update store. Nothing is installed until you start a rollout.</p>
      <p className="muted">The package has to be the one built for that Windows — {chosen.packageName}. The server reads the programs inside the zip and refuses a release that does not match.</p></>, async token => {
      const r = await api<{ version: string }>("POST", "/api/admin/releases", { manifest, signature, architecture, stepUpToken: token });
      setBusy(true);
      upload<Release>(`/api/admin/releases/${r.version}/package?architecture=${encodeURIComponent(architecture)}`, files.pkg!).then(
        p => { after(`Release ${p.version} for ${chosen.label} is ready: its signature and package hash check out.`); setFiles({ manifest: null, signature: null, pkg: null }); setKey(k => k + 1); },
        e => after(`The server refused the package. ${describeError(e)}`, false)).finally(() => setBusy(false));
    }, { manifest, signature: signature as Record<string, unknown>, architecture });
  };
  return (
    <section className="panel" aria-labelledby="add-release">
      <h2 id="add-release">Add a release</h2>
      <form key={key} className="row gap wrap" onSubmit={e => { e.preventDefault(); void submit(); }}>
        <label className="field inline"><span>Manifest (manifest.json)</span><input type="file" accept=".json,application/json" required onChange={e => setFiles(f => ({ ...f, manifest: e.target.files?.[0] ?? null }))} /></label>
        <label className="field inline"><span>Signature (signature.json)</span><input type="file" accept=".json,application/json" required onChange={e => setFiles(f => ({ ...f, signature: e.target.files?.[0] ?? null }))} /></label>
        <label className="field inline"><span>Package (.zip)</span><input type="file" accept=".zip,application/zip" required onChange={e => setFiles(f => ({ ...f, pkg: e.target.files?.[0] ?? null }))} /></label>
        <label className="field inline"><span>Windows</span><select value={architecture} onChange={e => setArchitecture(e.target.value as InstallArchitecture)}>
          {INSTALL_ARCHITECTURES.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label>
        <button className="btn primary" type="submit" disabled={busy}>{busy ? "Uploading…" : "Add release"}</button>
      </form>
      <p className="small muted">The archive for it is {chosen.packageName}.</p>
    </section>
  );
}

function StartRollout({ releases, candidates, blocked, ask, after }: { releases: Release[]; candidates: Candidate[]; blocked: Rollout | null; ask: Ask; after: (t: string) => void }) {
  const ready = releases.filter(r => r.state === "ready");
  const [draft, setDraft] = useState({ pick: "", pilot: "", success: "95", failure: "5" });
  const pairs = ready.map(r => ({ key: `${r.version}|${r.architecture ?? "none"}`, release: r }));
  const picked = draft.pick || pairs[0]?.key || "";
  const release = pairs.find(p => p.key === picked)?.release ?? null;
  const version = release?.version ?? "";
  const architecture = release?.architecture ?? null;
  // Only cabinets of the release's own Windows can be offered it, and a cabinet that has never reported one is a
  // 64-bit agent: 64-bit is the only build that has ever shipped.
  const windowsOf = (c: Candidate) => c.architecture ?? "windows-x64";
  const older = (c: Candidate) => c.agentVersion !== version && windowsOf(c) === architecture;
  const pilots = candidates.filter(c => c.online && older(c));
  const leftOut = candidates.filter(c => c.online && c.agentVersion !== version && !older(c)).length;
  const pilot = candidates.find(c => c.id === draft.pilot);
  if (blocked) return (
    <section className="panel" aria-labelledby="start">
      <h2 id="start">Start a rollout</h2>
      <p className="muted">The rollout of {blocked.version} is {blocked.state}. Finish or stop it before starting another.</p>
    </section>);
  return (
    <section className="panel" aria-labelledby="start">
      <h2 id="start">Start a rollout</h2>
      {ready.length === 0 ? <Empty>No release is ready. Add one below.</Empty> : !architecture ? (
        <Empty>That release does not say which Windows it is for, so nothing may be offered it. Add it again with its architecture.</Empty>
      ) : (
        <form className="row gap wrap" onSubmit={e => {
          e.preventDefault();
          const body = { version, architecture, pilotCabinetId: draft.pilot, successRatePercent: Number(draft.success), failureLimitPercent: Number(draft.failure) };
          ask("rollout.start", "fleet", <><p>Roll out agent <strong>{version}</strong> for <strong>{architectureLabel(architecture)} Windows</strong>, first to <strong>{pilot?.name}</strong> ({pilot?.client} / {pilot?.site}),
            then the in-office cabinets, then about 5% of the field, then everyone else.</p><p className="muted">Each batch must reach {draft.success}% upgraded before the next starts; failures above {draft.failure}% of a batch pause it on their own.
            Cabinets of the other Windows are left out of every batch, and the audit records them as the wrong architecture.</p></>,
            async token => {
              await api("POST", "/api/admin/rollouts", { ...body, stepUpToken: token });
              after(`Rollout of ${version} for ${architectureLabel(architecture)} Windows started with ${pilot?.name}.`);
            }, body);
        }}>
          <label className="field inline"><span>Release</span><select value={picked} onChange={e => setDraft(d => ({ ...d, pick: e.target.value }))}>
            {pairs.map(p => <option key={p.key} value={p.key}>{p.release.version} · {architectureLabel(p.release.architecture) ?? "architecture not recorded"}</option>)}</select></label>
          <label className="field inline"><span>First cabinet (batch 1)</span><select required value={draft.pilot} onChange={e => setDraft(d => ({ ...d, pilot: e.target.value }))}>
            <option value="">Choose an online cabinet…</option>
            {pilots.map(c => <option key={c.id} value={c.id}>{c.name} · {c.client} / {c.site} · {c.agentVersion ?? "unknown"}{c.inOffice ? " · in office" : ""}</option>)}</select></label>
          <label className="field inline"><span>Success rate %</span><input inputMode="numeric" size={3} value={draft.success} onChange={e => setDraft(d => ({ ...d, success: e.target.value.replace(/\D/g, "") }))} /></label>
          <label className="field inline"><span>Failure limit %</span><input inputMode="numeric" size={3} value={draft.failure} onChange={e => setDraft(d => ({ ...d, failure: e.target.value.replace(/\D/g, "") }))} /></label>
          <button className="btn primary" type="submit" disabled={!draft.pilot}>Start rollout</button>
        </form>)}
      {ready.length > 0 && architecture && pilots.length === 0 && <p className="notice warn">No online cabinet of that Windows can be upgraded to {version} yet, so batch 1 has nothing to offer.</p>}
      {ready.length > 0 && architecture && pilots.length > 0 && leftOut > 0 && <p className="small muted">{leftOut} online {leftOut === 1 ? "cabinet is" : "cabinets are"} of the other Windows or already on {version}, so {leftOut === 1 ? "it is" : "they are"} not offered this release.</p>}
    </section>
  );
}

function InOffice({ candidates, problem, ask, after }: { candidates: Candidate[] | null; problem: string | null; ask: Ask; after: (t: string) => void }) {
  const [filter, setFilter] = useState("");
  const shown = (candidates ?? []).filter(c => c.inOffice || (filter.trim() && `${c.name} ${c.client} ${c.site}`.toLowerCase().includes(filter.trim().toLowerCase())));
  const paged = usePaged(shown);
  const toggle = (c: Candidate) => ask("cabinet.in_office", c.id, <p>{c.inOffice ? "Remove" : "Add"} <strong>{c.name}</strong> ({c.client} / {c.site}) {c.inOffice ? "from" : "to"} the in-office cabinets (batch 2 of every rollout).</p>,
    async token => { await api("PUT", `/api/admin/cabinets/${c.id}/in-office`, { inOffice: !c.inOffice, stepUpToken: token }); after(`${c.name} is ${c.inOffice ? "no longer" : "now"} an in-office cabinet.`); },
    { inOffice: !c.inOffice });
  return (
    <section className="panel" aria-labelledby="office">
      <h2 id="office">In-office cabinets</h2>
      {problem && <p className="error" role="alert">{problem}</p>}
      <label className="field inline"><span>Find a cabinet</span><input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Name, client or site" /></label>
      {shown.length === 0 ? <Empty>No in-office cabinets yet.</Empty> : (
        <ul className="plain">{paged.rows.map(c => (
          <li key={c.id} className="row gap wrap"><Link to={`/cabinets/${c.id}`}>{c.name}</Link> <span className="muted">{c.client} / {c.site} · agent {c.agentVersion ?? "unknown"} · {architectureLine(c.architecture)}</span>
            {c.inOffice && <Badge tone="info">In office</Badge>}
            <button className="btn small" onClick={() => toggle(c)}>{c.inOffice ? "Remove" : "Add to office"}</button></li>))}
        </ul>)}
      <Pager {...paged} label="cabinets" />
    </section>
  );
}

/** One rollout: every cabinet, its batch, and how its upgrade ended (with the exact failed check). */
export function RolloutDetail({ id }: { id: string }) {
  const { data, problem } = useLoad<Rollout & { targets: Target[] }>(`/api/admin/rollouts/${id}`);
  const [only, setOnly] = useState("all");
  const rows = (data?.targets ?? []).filter(t => only === "all" || t.state === only);
  const paged = usePaged(rows);
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Upgrades", to: "/admin/upgrades" }, { label: data ? `Rollout of ${data.version}` : "Rollout" }]} />
      <h1>{data ? `Rollout of agent ${data.version}` : "Rollout"}</h1>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && <>
        <p><Badge tone={ROLLOUT_TONE[data.state][0]}>{ROLLOUT_TONE[data.state][1]}</Badge> <span className="muted">{architectureLine(data.architecture)} · started {fullTime(data.startedAt)} by {data.startedBy.name}; success rate {data.successRatePercent}%, failure limit {data.failureLimitPercent}%</span></p>
        {data.pausedReason && data.state === "paused" && <p className="notice warn">{data.pausedReason}</p>}
        <label className="field inline"><span>Show</span><select value={only} onChange={e => setOnly(e.target.value)}>
          <option value="all">Every cabinet</option>{TARGET_FILTERS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></label>
        {rows.length === 0 ? <Empty>No cabinets.</Empty> : (
          <table className="table compact">
            <caption className="sr-only">Cabinets in this rollout</caption>
            <thead><tr><th scope="col">Cabinet</th><th scope="col">Batch</th><th scope="col">Result</th><th scope="col">Versions</th><th scope="col">When</th></tr></thead>
            <tbody>{paged.rows.map(t => (
              <tr key={t.cabinetId}>
                <th scope="row"><Link to={`/cabinets/${t.cabinetId}`}>{t.cabinet}</Link> <span className="muted small">{t.client} / {t.site}</span></th>
                <td>{t.batch}: {BATCH[t.batch]}</td>
                <td><Badge tone={targetBadge(t)[0]}>{targetBadge(t)[1]}</Badge>
                  {targetNote(t, c => CHECK[c] ?? c) && <div className="small">{targetNote(t, c => CHECK[c] ?? c)}</div>}</td>
                <td>{t.fromVersion ?? "unknown"} → now {t.agentVersion ?? "unknown"}</td>
                <td className="small">{t.finishedAt ? fullTime(t.finishedAt) : t.offeredAt ? `offered ${fullTime(t.offeredAt)}` : "—"}</td>
              </tr>))}
            </tbody>
          </table>)}
        <Pager {...paged} label="cabinets" />
      </>}
    </div>
  );
}
