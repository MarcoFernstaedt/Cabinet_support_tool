// The SQL Server check (database.connectivity) as the console shows it in a diagnosis's full read. Kept free of React so it is tested
// on its own. Nothing here signs in: the check stops after the pre-login and the TLS handshake (decision D13).

export interface DatabaseOutput {
  port: number; address: string | null;
  result: "sql_server" | "not_sql_server" | "refused" | "no_answer" | "unreachable" | "no_sync_cabinet";
  tcp: { connected: boolean; ms: number | null };
  prelogin: { answered: boolean; ms: number | null; serverVersion: string | null; encryption: "off" | "on" | "required" | "not_supported" | null } | null;
  tls: { completed: boolean; ms: number | null; protocol: string | null;
    certificate: { subject: string; issuer: string; notAfter: string; sha256: string; selfSigned: boolean } | null;
    problems: ("name_mismatch" | "untrusted_chain" | "missing")[] } | null;
  error: string | null;
}
export interface DatabaseReading { key: string; label: string; params: Record<string, unknown>; output?: DatabaseOutput; failure?: string }

const RESULT: Record<string, string> = {
  sql_server: "SQL Server answered", not_sql_server: "Something answered, but not as SQL Server", refused: "The port is closed",
  no_answer: "No answer in time", unreachable: "The address could not be reached", no_sync_cabinet: "No sync cabinet to check",
};
const ENCRYPTION: Record<string, string> = { off: "Sign-in only", on: "Whole connection", required: "Required", not_supported: "Not supported (no certificate)" };
const PROBLEM: Record<string, string> = { name_mismatch: "does not name the address", untrusted_chain: "not from a trusted authority, or expired", missing: "none presented" };
const ms = (v: number | null) => v === null ? "no time" : `${v} ms`;

/** One line for the result, whatever it is (an unknown value is shown as it came). */
export function sqlResultText(result: string): string { return RESULT[result] ?? result; }

/** The rows of one check, step by step; a step that was never reached is left out rather than shown empty. */
export function sqlCheckRows(o: DatabaseOutput): [string, string][] {
  const rows: [string, string][] = [["Address", o.address ? `${o.address}:${o.port}` : `port ${o.port}, no address`], ["Result", sqlResultText(o.result)],
    ["TCP", o.tcp.connected ? `Connected in ${ms(o.tcp.ms)}` : "Did not connect"]];
  if (o.prelogin) {
    rows.push(["Pre-login", o.prelogin.answered ? `Answered in ${ms(o.prelogin.ms)}` : "Not answered"]);
    if (o.prelogin.serverVersion) rows.push(["Server version", o.prelogin.serverVersion]);
    if (o.prelogin.encryption) rows.push(["Encryption", ENCRYPTION[o.prelogin.encryption] ?? o.prelogin.encryption]);
  }
  if (o.tls) {
    rows.push(["TLS handshake", o.tls.completed ? `Completed in ${ms(o.tls.ms)}${o.tls.protocol ? ` (${o.tls.protocol})` : ""}` : "Not completed"]);
    const c = o.tls.certificate;
    if (c) rows.push(["Certificate", `${c.subject}${c.selfSigned ? " (self-signed)" : `, issued by ${c.issuer}`}, valid to ${c.notAfter.slice(0, 10)}`]);
    if (o.tls.problems.length) rows.push(["Certificate problems", o.tls.problems.map(p => PROBLEM[p] ?? p).join("; ")]);
  }
  if (o.error) rows.push(["Stopped because", o.error]);
  return rows;
}
