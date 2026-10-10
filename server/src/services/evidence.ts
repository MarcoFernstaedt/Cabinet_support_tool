// Evidence packages (docs/platform/data-classification.md, docs/spec/13-roadmap.md module 39): everything the platform
// holds about one cabinet for a period, in one file, so an investigation (a crash, a failing drive) can be handed on or
// kept. Each section says where its data came from; each section and the whole package carry a SHA-256 of their
// canonical JSON, so anyone can check nothing was changed afterwards; the export is in the audit log with that hash.
// Nothing is collected from the cabinet for it: it is what the cabinet already reported and what the platform did.
import { createHash } from "node:crypto";
import { audit, transaction, type Queryable } from "../db/db.js";
import type pg from "pg";
import { canonicalJson } from "../auth/canonical.js";
import { cabinetCrashes, timeline } from "./crashes.js";

const sha256 = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
const iso = (d: Date | null) => d === null ? null : d.toISOString();
export const MAX_EVENTS = 5000, MAX_COMMANDS = 500;

interface Section { title: string; provenance: string; truncated?: boolean; items: unknown }

/** Builds the package. The caller records the export (exportEvidence). */
export async function buildEvidence(db: Queryable, cabinetId: string, from: Date, to: Date, exportedBy: { userId: string; name: string }) {
  const k = (await db.query<{ id: string; name: string; hostname: string | null; serial_number: string | null; role: string; agent_version: string | null; status: string;
    time_zone_id: string | null; demo: boolean; site: string; client: string; enrolled_at: Date | null }>(
    `SELECT k.id, k.name, k.hostname, k.serial_number, k.role, k.agent_version, k.status, k.time_zone_id, k.demo_scenario IS NOT NULL AS demo,
            s.name AS site, c.name AS client, k.created_at AS enrolled_at
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id WHERE k.id = $1`, [cabinetId])).rows[0];
  if (!k) return null;
  const events = (await db.query<{ event_id: string; kind: string; occurred_at: Date; received_at: Date; severity_hint: string; source: unknown; device: unknown; detail: unknown }>(
    `SELECT event_id, kind, occurred_at, received_at, severity_hint, source, device, detail FROM events
      WHERE cabinet_id = $1 AND occurred_at BETWEEN $2 AND $3 ORDER BY occurred_at DESC LIMIT $4`, [cabinetId, from, to, MAX_EVENTS + 1])).rows;
  const boots = (await db.query<{ booted_at: Date; source: string }>(
    "SELECT booted_at, source FROM cabinet_boots WHERE cabinet_id = $1 AND booted_at BETWEEN $2 AND $3 ORDER BY booted_at", [cabinetId, from, to])).rows;
  const alerts = (await db.query<{ id: string; title: string; severity: string; state: string; first_seen: Date; last_seen: Date; occurrences: number; resolution: string | null }>(
    `SELECT id, title, severity, state, first_seen, last_seen, occurrences, resolution FROM alerts
      WHERE cabinet_id = $1 AND last_seen >= $2 AND first_seen <= $3 ORDER BY first_seen`, [cabinetId, from, to])).rows;
  const commands = (await db.query<{ id: string; operation: string; params: unknown; status: string; issued_at: Date; result_at: Date | null; result: unknown; username: string; bulk_id: string | null }>(
    `SELECT c.id, c.operation, c.params, c.status, c.issued_at, c.result_at, c.result, u.username, c.bulk_id
       FROM commands c JOIN users u ON u.id = c.issued_by WHERE c.cabinet_id = $1 AND c.issued_at BETWEEN $2 AND $3 ORDER BY c.issued_at DESC LIMIT $4`,
    [cabinetId, from, to, MAX_COMMANDS + 1])).rows;
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));

  const sections: Record<string, Section> = {
    cabinet: { title: "The cabinet", provenance: "The platform's records: enrollment, the cabinet's heartbeats (agent version, time zone).", items: {
      id: k.id, name: k.name, hostname: k.hostname, serialNumber: k.serial_number, role: k.role, client: k.client, site: k.site, agentVersion: k.agent_version,
      status: k.status, timeZoneId: k.time_zone_id, enrolledAt: iso(k.enrolled_at), simulated: k.demo } },
    events: { title: "Events the cabinet reported", truncated: events.length > MAX_EVENTS,
      provenance: "Sent by the cabinet's agent as they happened, from the Windows event logs and its own monitors. log, source, eventId and recordId identify the original Windows entry; receivedAt is when the server stored it.",
      items: events.slice(0, MAX_EVENTS).reverse().map(e => ({ eventId: e.event_id, kind: e.kind, occurredAt: iso(e.occurred_at), receivedAt: iso(e.received_at),
        severityHint: e.severity_hint, source: e.source, device: e.device, detail: e.detail })) },
    boots: { title: "Windows starts", provenance: "Recorded by the server: from the agent's uptime going back (heartbeat) or from Windows' own start record (event).",
      items: boots.map(b => ({ bootedAt: iso(b.booted_at), source: b.source })) },
    alerts: { title: "Alerts", provenance: "Raised by the server's alerts engine from the events above.",
      items: alerts.map(a => ({ id: a.id, title: a.title, severity: a.severity, state: a.state, firstSeen: iso(a.first_seen), lastSeen: iso(a.last_seen), occurrences: a.occurrences, resolution: a.resolution })) },
    commands: { title: "What the platform asked the cabinet to do", truncated: commands.length > MAX_COMMANDS,
      provenance: "Sent by the platform on a person's behalf (issuedBy); results as the cabinet's agent returned them, checked against each operation's contract. Results past their retention period are empty.",
      items: commands.slice(0, MAX_COMMANDS).reverse().map(c => ({ id: c.id, operation: c.operation, params: c.params, status: c.status, issuedAt: iso(c.issued_at),
        issuedBy: c.username, fleetJob: c.bulk_id, resultAt: iso(c.result_at), result: c.result })) },
    timeline: { title: "Timeline", provenance: "Derived by the server from the events, boots and commands above.", items: await timeline(db, cabinetId, from, to) },
    analysis: { title: "Crash analysis", provenance: "Derived by the server. Findings are correlation, not proof: a change before a crash is not shown to have caused it.",
      items: await cabinetCrashes(db, cabinetId, Math.min(days, 90)) },
  };
  const hashes = Object.fromEntries(Object.entries(sections).map(([name, s]) => [name, sha256(s)]));
  const manifest = {
    format: "mashura-cabinet-evidence/1", cabinetId: k.id, cabinet: k.name, from: from.toISOString(), to: to.toISOString(),
    exportedAt: new Date().toISOString(), exportedBy: exportedBy.name,
    note: "Each section's sha256 is of its canonical JSON (keys sorted, no spaces). packageSha256 is of the canonical JSON of {manifest without packageSha256, sections}.",
    sectionSha256: hashes,
  };
  const packageSha256 = sha256({ manifest, sections });
  return { manifest: { ...manifest, packageSha256 }, sections };
}

/** Builds the package and records its export, with its hash, in the audit log. */
export async function exportEvidence(pool: pg.Pool, cabinetId: string, from: Date, to: Date, user: { userId: string; name: string }) {
  const pkg = await buildEvidence(pool, cabinetId, from, to, user);
  if (!pkg) return null;
  await transaction(pool, c => audit(c, { actorKind: "user", actorId: user.userId, action: "evidence.export", targetKind: "cabinet", targetId: cabinetId, outcome: "succeeded",
    details: { from: from.toISOString(), to: to.toISOString(), packageSha256: pkg.manifest.packageSha256 } }));
  return pkg;
}

/** Checks a package: every section's hash and the package hash. True only when nothing was changed. */
export function verifyEvidence(pkg: { manifest: Record<string, unknown> & { sectionSha256: Record<string, string>; packageSha256: string }; sections: Record<string, unknown> }): boolean {
  const { packageSha256, ...manifest } = pkg.manifest;
  const names = Object.keys(pkg.sections);
  if (names.length !== Object.keys(manifest.sectionSha256).length) return false;
  for (const n of names) if (manifest.sectionSha256[n] !== sha256(pkg.sections[n])) return false;
  return sha256({ manifest, sections: pkg.sections }) === packageSha256;
}
