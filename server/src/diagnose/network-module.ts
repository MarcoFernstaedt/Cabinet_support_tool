// The network diagnosis as a diagnostic module (docs/spec/18-built-designs.md §2, item 4; contracts/diagnostics/modules/
// network-diagnosis.json). The diagnosis runs the module's rule steps instead of calling the network checks by hand; the checks
// themselves (network-findings.ts, network-observations.ts) are unchanged. server/test/network-module.test.ts keeps the module's
// reads, causes and repairs in step with the code.
import { readModules } from "@mashura/cabinet-contracts/load";
import { parseModule, type DiagnosticModule } from "./module.js";
import { networkFindings, type Finding, type NetworkEvidence } from "./network-findings.js";
import { sqlFindings } from "./sql-findings.js";

/** The server rules the network module names. A module naming any other rule is refused. */
export const NETWORK_RULES: Readonly<Record<string, (e: NetworkEvidence) => Finding[]>> = {
  "network.findings": e => networkFindings(e),
};
/** The rules the SQL connectivity ladder names (its own module, run with the network diagnosis; D15). */
export const SQL_RULES: Readonly<Record<string, (e: NetworkEvidence) => Finding[]>> = {
  "sql.findings": e => sqlFindings(e),
};

let cache: DiagnosticModule | null = null;
/** The network module, read and checked once (a module that fails its checks stops the diagnosis rather than running half). */
export function networkModule(): DiagnosticModule {
  if (cache) return cache;
  const file = readModules().find(f => f.file === "network-diagnosis.json");
  if (!file) throw new Error("the network-diagnosis module is missing");
  cache = parseModule(file.data, new Set(Object.keys(NETWORK_RULES)));
  return cache;
}

let ladderCache: DiagnosticModule | null = null;
/** The SQL connectivity ladder module, read and checked once. */
export function sqlLadderModule(): DiagnosticModule {
  if (ladderCache) return ladderCache;
  const file = readModules().find(f => f.file === "sql-connectivity-ladder.json");
  if (!file) throw new Error("the sql-connectivity-ladder module is missing");
  ladderCache = parseModule(file.data, new Set(Object.keys(SQL_RULES)));
  return ladderCache;
}

/**
 * Runs the network module's rule steps, then the SQL connectivity ladder's, in order; their findings, in that order, are the diagnosis's
 * findings. The ladder's findings sit in the sync layer beside the port tests they extend.
 */
export function runNetworkModule(e: NetworkEvidence): Finding[] {
  const out: Finding[] = [];
  for (const step of networkModule().procedure) if (step.kind === "rule") out.push(...NETWORK_RULES[step.rule!]!(e));
  for (const step of sqlLadderModule().procedure) if (step.kind === "rule") out.push(...SQL_RULES[step.rule!]!(e));
  return out;
}
