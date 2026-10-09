// The cabinet's Software section (docs/spec/06-console-spec.md "Software"): approved packages from the
// library that match this cabinet's hardware, and Install for Tier 2 and Admin. The cabinet downloads the
// package from the server and checks its hash, signature and publisher itself before installing.
import { useEffect, useMemo, useState } from "react";
import type { DevicesListOutput, PackageInstallOutput } from "@mashura/cabinet-contracts/types";
import { useOperation, type CommandResult } from "../../lib/commands";
import { fullTime, bytes } from "../../lib/time";
import { useLoad } from "../../lib/useLoad";
import { Badge, Empty, ResultProblem } from "../../components/ui";
import type { CabinetDetail } from "./CabinetPage";
import { useCanWrite, useConfirmedWrite } from "./Writes";

export interface LibraryPackage {
  id: string; name: string; version: string; vendor: string; type: "driver" | "msi"; hardwareIds: string[]; notes: string | null; state: string;
  sha256: string | null; sizeBytes: number | null; signer: string | null; detail: string | null; refusal: string | null;
  uploadedBy: { id: string; name: string }; uploadedAt: string; approvedBy: { id: string; name: string } | null; approvedAt: string | null;
  retiredBy: { id: string; name: string } | null; retiredAt: string | null;
}

/** The check that refused a package on the cabinet, in plain words. */
export const REFUSAL: Record<string, string> = {
  hash_mismatch: "Hash check failed: the downloaded file is not the approved package.",
  signature_invalid: "Signature check failed: the package is unsigned, or was changed after it was signed.",
  publisher_not_trusted: "Publisher check failed: the package is signed by a publisher that is not on the cabinet's trusted list.",
  verification_failed: "The package could not be checked, so it was not installed.",
  unavailable: "The package could not be downloaded from the server.",
};

const matchesHardware = (p: LibraryPackage, ids: Set<string>) => p.hardwareIds.some(h => ids.has(h.toUpperCase()));

export function Software({ cabinet }: { cabinet: CabinetDetail }) {
  const { data, problem } = useLoad<LibraryPackage[]>("/api/packages");
  const devices = useOperation<DevicesListOutput>(cabinet.id, "devices.list");
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { void devices.start({ problemsOnly: false }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const hardware = useMemo(() => new Set((devices.result?.output?.devices ?? []).flatMap(d => d.hardwareIds.map(h => h.toUpperCase()))), [devices.result]);
  const matching = (data ?? []).filter(p => matchesHardware(p, hardware));
  const general = (data ?? []).filter(p => p.hardwareIds.length === 0);
  const others = (data ?? []).filter(p => p.hardwareIds.length > 0 && !matchesHardware(p, hardware));
  return (
    <section className="panel" aria-labelledby="software-heading">
      <h2 id="software-heading">Software</h2>
      <p className="muted small">Approved packages from the software library. Before installing, the cabinet checks the file's hash, its signature and that the publisher is on its trusted list, and refuses it if any check fails.</p>
      {problem && <p className="error" role="alert">{problem}</p>}
      {devices.state === "running" && <p className="muted" role="status">Reading this cabinet's hardware to find matching packages…</p>}
      {devices.result && devices.result.status !== "succeeded" && <ResultProblem result={devices.result} />}
      {data && data.length === 0 && <Empty>The software library has no approved packages yet.</Empty>}
      {data && data.length > 0 && <>
        <h3>For this cabinet's hardware</h3>
        <PackageList cabinet={cabinet} packages={matching} empty={devices.state === "done" ? "No approved driver matches this cabinet's devices." : "Waiting for the device list…"} />
        {general.length > 0 && <><h3>Installers for any cabinet</h3><PackageList cabinet={cabinet} packages={general} empty="" /></>}
        {others.length > 0 && (
          <details open={showAll} onToggle={e => setShowAll((e.target as HTMLDetailsElement).open)}>
            <summary>Other approved packages ({others.length}) for hardware this cabinet does not report</summary>
            <PackageList cabinet={cabinet} packages={others} empty="" />
          </details>)}
      </>}
    </section>
  );
}

/** Packages with Install; used here and in the fingerprint scanner section. */
export function PackageList({ cabinet, packages, empty }: { cabinet: CabinetDetail; packages: LibraryPackage[]; empty: string }) {
  if (packages.length === 0) return empty ? <Empty>{empty}</Empty> : null;
  return <ul className="plain packages">{packages.map(p => <PackageRow key={p.id} cabinet={cabinet} p={p} />)}</ul>;
}

function PackageRow({ cabinet, p }: { cabinet: CabinetDetail; p: LibraryPackage }) {
  const allowed = useCanWrite(cabinet);
  const w = useConfirmedWrite<PackageInstallOutput>(cabinet, "package.install");
  return (
    <li className="card">
      <div className="panel-head">
        <div>
          <strong>{p.name}</strong> {p.version} <Badge tone="info">{p.type === "driver" ? "Driver" : "Installer (MSI)"}</Badge>
          <div className="small">{p.vendor} · signed by {p.signer ?? "unknown"} · approved by {p.approvedBy?.name ?? "—"} {p.approvedAt && <>on {fullTime(p.approvedAt)}</>}</div>
          {p.notes && <div className="muted small">{p.notes}</div>}
        </div>
        {allowed && <button className="btn primary" disabled={w.run.state === "running"} onClick={() => w.ask({ packageId: p.id, packageType: p.type, sha256: p.sha256 }, <>
          <p>Install <strong>{p.name} {p.version}</strong> from {p.vendor} ({p.type === "driver" ? "driver package, installed with pnputil" : "MSI installer, run silently without restarting"}).</p>
          <ul className="small">
            <li>Signed by: {p.signer}</li>
            <li>Size: {p.sizeBytes === null ? "unknown" : bytes(p.sizeBytes)}</li>
            <li>SHA-256: <code className="wrap">{p.sha256}</code></li>
          </ul>
          <p className="muted small">The cabinet checks the hash, signature and publisher again before installing, and refuses the package if any check fails.</p>
        </>)}>{w.run.state === "running" ? "Installing…" : "Install"}</button>}
      </div>
      <InstallOutcome run={w.run} />
      {w.dialog}
    </li>
  );
}

function InstallOutcome({ run }: { run: { state: string; result: CommandResult<PackageInstallOutput> | null; problem: string | null } }) {
  if (run.state === "idle") return null;
  if (run.state === "running") return <p className="muted" role="status">Sent. The cabinet is downloading, checking and installing the package…</p>;
  if (run.problem) return <p className="error" role="alert">{run.problem}</p>;
  const r = run.result;
  if (!r) return null;
  if (r.status === "succeeded" && r.output) {
    const o = r.output;
    return (
      <div className="notice ok" role="status">
        <p>Installed. Hash, signature and publisher checks passed; signed by {o.signer ?? "unknown"}{o.exitCode !== null && <>; installer exit code {o.exitCode}</>}.</p>
        {o.rebootRequired && <p><strong>The cabinet needs a restart to finish.</strong></p>}
      </div>);
  }
  const code = r.error?.code ?? "";
  return (
    <div className="notice crit" role="alert">
      <p><strong>{r.status === "rejected" ? "The cabinet refused this package." : r.status === "expired" ? "No answer from the cabinet." : "The installation failed."}</strong></p>
      <p>{REFUSAL[code] ?? r.error?.message ?? ""}</p>
      {REFUSAL[code] && r.error?.message && <p className="muted small">{r.error.message}</p>}
    </div>);
}
