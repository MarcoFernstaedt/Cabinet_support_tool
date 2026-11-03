// The SQL connectivity ladder's check (contracts/diagnostics/modules/sql-connectivity-ladder.json; decision log D13 and D15): reads the
// database.connectivity result for the sync cabinet and says whether SQL Server answers there. A closed or silent port is left to the
// network diagnosis's own port tests, so nothing is said twice. Pure: no database, no network, no regular expressions.
import type { DatabaseConnectivityOutput } from "@mashura/cabinet-contracts/types";
import type { Finding, NetworkEvidence } from "./network-findings.js";

export interface DatabaseRun { key: string; label: string; params: Record<string, unknown>; output?: DatabaseConnectivityOutput; failure?: string }

/** SQL Server's default port: the only sync port the ladder checks (D15). */
export const SQL_SERVER_PORT = 1433;

const ENCRYPTION: Record<string, string> = { off: "encrypts the sign-in only", on: "encrypts the connection", required: "requires encryption", not_supported: "has no certificate, so it cannot encrypt" };
const PROBLEM: Record<string, string> = { name_mismatch: "it does not name the address the cabinets use", untrusted_chain: "it is not from an authority Windows trusts", missing: "none was presented" };

export function sqlFindings(e: NetworkEvidence): Finding[] {
  const runs = e.databases ?? [];
  if (runs.length === 0 || e.cabinet.role === "sync") return [];
  const name = e.sync.cabinet?.name ?? `the sync cabinet (${e.sync.address})`;
  const out: Finding[] = [];
  for (const r of runs) {
    const port = Number(r.params.port);
    if (!r.output) {
      out.push({ id: "sql-nc", layer: "sync", severity: "info", certainty: "not_checked", title: `Could not check SQL Server on ${name}`, evidence: [r.failure ?? "No answer."], fix: null });
      continue;
    }
    const o = r.output;
    if (o.result === "not_sql_server")
      out.push({ id: "sql-not-sql", layer: "sync", severity: "problem", certainty: "possible", title: `Port ${port} on ${name} answers, but not as SQL Server`,
        evidence: [`A connection to ${o.address}:${port} opened, but the answer to a SQL Server pre-login was not SQL Server's.`, ...(o.error ? [o.error] : [])],
        fix: `Another program holds port ${port}, or SQL Server listens on a different port: check the SQL Server service on ${name} and its TCP/IP port in SQL Server Configuration Manager.` });
    if (o.result === "sql_server" && o.prelogin) {
      const enc = o.prelogin.encryption;
      const cert = o.tls?.certificate;
      out.push({ id: "sql-ok", layer: "sync", severity: "ok", certainty: "confirmed", title: `SQL Server answers on ${name}`,
        evidence: [`${o.address}:${port} answered a SQL Server pre-login${o.prelogin.serverVersion ? `: version ${o.prelogin.serverVersion}` : ""}${enc ? `, and ${ENCRYPTION[enc]}` : ""}.`,
          ...(cert ? [`It presents the certificate ${cert.subject}${cert.selfSigned ? " (self-signed)" : ""}, valid until ${cert.notAfter.slice(0, 10)}.`] : []),
          "No sign-in was attempted: this proves SQL Server answers, not that the sync software can sign in."], fix: null });
      const untrusted = (o.tls?.problems ?? []).filter(p => p === "untrusted_chain" || p === "name_mismatch");
      if (enc === "required" && untrusted.length > 0)
        out.push({ id: "sql-cert", layer: "sync", severity: "info", certainty: "possible", title: `SQL Server on ${name} requires encryption with a certificate a checking client would not trust`,
          evidence: [`Its certificate${cert ? ` (${cert.subject})` : ""}: ${untrusted.map(p => PROBLEM[p]).join("; ")}.`],
          fix: `Only matters if the sync software checks certificates: then install a certificate on ${name}'s SQL Server from an authority the cabinets trust, naming the address they use.` });
    }
  }
  return out;
}
