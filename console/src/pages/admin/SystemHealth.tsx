// System health: the host admin's view of the platform itself (docs/platform/operations.md). Counts and sizes only; nothing secret.
import { Breadcrumbs } from "../../components/Layout";
import { Badge, Empty, KeyValues } from "../../components/ui";
import { fullTime } from "../../lib/time";
import { useLoad } from "../../lib/useLoad";
import { Pager, usePaged } from "../../components/Pager";

interface Health {
  generatedAt: string;
  database: { edition: string | null; limitBytes: number | null; dataBytes: number; logBytes: number; percent: number | null; warnAtPercent: number; criticalAtPercent: number };
  disk: { readable: boolean; volumes: { mount: string; totalBytes: number; freeBytes: number; freePercent: number }[] };
  backup: { readable: boolean; ageHours: number | null; maxHours: number };
  certificates: { ca: { notAfter: string; daysLeft: number } | null; nextCabinetCertificateNotAfter: string | null };
  auditChain: { lastVerifiedAt: string | null; lastRun: { at: string; ok: boolean; mode: string | null } | null };
  retention: { lastRunAt: string | null };
  cabinets: { online: number; offline: number };
  counters: { kind: string; code: string; last24h: number; last7d: number; gauge: boolean }[];
  alerts: { id: string; kind: string; title: string; occurrences: number; firstSeen: string; lastSeen: string }[];
}

const size = (b: number): string => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);

export function SystemHealth() {
  const { data: h, problem } = useLoad<Health>("/api/admin/system-health");
  const counters = usePaged(h?.counters ?? []);
  if (problem) return <div className="page"><p className="error" role="alert">{problem}</p></div>;
  if (!h) return <div className="page"><p className="muted" role="status">Loading…</p></div>;
  const d = h.database;
  const dbTone = d.percent === null ? "off" : d.percent >= d.criticalAtPercent ? "crit" : d.percent >= d.warnAtPercent ? "warn" : "ok";
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "System health" }]} />
      <h1>System health</h1>
      <p className="muted small">As of {fullTime(h.generatedAt)}. Counts and sizes only: no messages, names or contents are collected. The platform sends no email or other notification; check this page, or point an uptime monitor at the /health address.</p>

      <section className="panel" aria-labelledby="h-alerts">
        <h2 id="h-alerts">Open operations alerts</h2>
        {h.alerts.length === 0 ? <Empty>No open operations alerts.</Empty> : (
          <ul className="plain">{h.alerts.map(a => (
            <li key={a.id}><Badge tone="crit">{a.kind.replace(/^ops_/, "").replace(/_/g, " ")}</Badge> <strong>{a.title}</strong>
              <div className="small">{a.occurrences > 1 ? `${a.occurrences} times, ` : ""}since {fullTime(a.firstSeen)}</div></li>))}
          </ul>)}
        <p className="small">Close alerts on the Security alerts page; size, disk, backup and certificate-authority alerts clear on their own when the condition is gone.</p>
      </section>

      <section className="panel" aria-labelledby="h-state">
        <h2 id="h-state">State</h2>
        <KeyValues rows={[
          ["Database", <>{size(d.dataBytes)} data, {size(d.logBytes)} log {d.limitBytes ? <><Badge tone={dbTone}>{d.percent}% of the {size(d.limitBytes)} limit</Badge> ({d.edition})</> : <>(no size limit for {d.edition ?? "this edition"})</>}</>],
          ["Free disk", h.disk.readable ? (h.disk.volumes.length ? h.disk.volumes.map(v => `${v.mount} ${size(v.freeBytes)} free of ${size(v.totalBytes)} (${v.freePercent}%)`).join("; ") : "no volumes reported") : "unknown"],
          ["Last backup", !h.backup.readable ? "unknown (the database account cannot read the backup history)" : h.backup.ageHours === null ? <Badge tone="crit">none recorded</Badge> : <><Badge tone={h.backup.ageHours > h.backup.maxHours ? "crit" : "ok"}>{h.backup.ageHours} hours ago</Badge> (alert after {h.backup.maxHours})</>],
          ["Certificate authority", h.certificates.ca ? `expires ${fullTime(h.certificates.ca.notAfter)} (${h.certificates.ca.daysLeft} days)` : "unknown"],
          ["Next cabinet certificate to expire", h.certificates.nextCabinetCertificateNotAfter ? fullTime(h.certificates.nextCabinetCertificateNotAfter) : "none"],
          ["Audit chain last verified", <>{fullTime(h.auditChain.lastVerifiedAt)}{h.auditChain.lastRun && !h.auditChain.lastRun.ok && <> <Badge tone="crit">the last check found a break</Badge></>}</>],
          ["Retention last ran", fullTime(h.retention.lastRunAt)],
          ["Cabinets", `${h.cabinets.online} online, ${h.cabinets.offline} offline`],
        ]} />
      </section>

      <section className="panel" aria-labelledby="h-counters">
        <h2 id="h-counters">Counters</h2>
        {h.counters.length === 0 ? <Empty>Nothing counted yet.</Empty> : (
          <table>
            <caption className="small">Last 24 hours and last 7 days. Rows starting with g_ are the highest value seen, in milliseconds.</caption>
            <thead><tr><th scope="col">What</th><th scope="col">Where</th><th scope="col">24 hours</th><th scope="col">7 days</th></tr></thead>
            <tbody>{counters.rows.map(c => <tr key={`${c.kind}|${c.code}`}><td>{c.kind}</td><td>{c.code}</td><td>{c.last24h}</td><td>{c.last7d}</td></tr>)}</tbody>
          </table>)}
        <Pager {...counters} label="counters" />
      </section>
    </div>
  );
}
