// The network diagnosis as a diagnostic module (docs/platform/diagnostic-engine-execution.md, item 4; contracts/diagnostics/modules/
// network-diagnosis.json). The diagnosis runs the module's rule steps instead of calling the network checks by hand; the checks
// themselves (network-findings.ts, network-observations.ts) are unchanged. server/test/network-module.test.ts keeps the module's
// reads, causes and repairs in step with the code.
import { readModules } from "@mashura/cabinet-contracts/load";
import { parseModule, type DiagnosticModule } from "./module.js";
import { networkFindings, type Finding, type NetworkEvidence } from "./network-findings.js";

/** The server rules the network module names. A module naming any other rule is refused. */
export const NETWORK_RULES: Readonly<Record<string, (e: NetworkEvidence) => Finding[]>> = {
  "network.findings": e => networkFindings(e),
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

/** Runs the network module's rule steps in order; their findings, in that order, are the diagnosis's findings. */
export function runNetworkModule(e: NetworkEvidence): Finding[] {
  const out: Finding[] = [];
  for (const step of networkModule().procedure) if (step.kind === "rule") out.push(...NETWORK_RULES[step.rule!]!(e));
  return out;
}
