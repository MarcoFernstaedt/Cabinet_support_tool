// Is a TCP port reachable on this cabinet? Combines what is listening, the Windows firewall rules and profiles, and which firewall profile
// the connected network uses. Plain comparisons of the readings the agent already gives: no pattern matching of text.
export interface Rule { name: string; direction: string; action: string; protocol?: string | null; localPorts?: string | null; programPath?: string | null; localAddresses?: string | null; remoteAddresses?: string | null; profiles?: string[] | null; enabled: boolean }
export interface Profile { profile: string; enabled: boolean; defaultInbound: string }
export interface Listener { address: string; port: number; process: string | null; processId: number | null }

/** True when a rule's port list ("1433", "1000-2000, 3000", "Any") includes the port. Named groups such as "RPC" never match a number. */
export function portListIncludes(list: string | null | undefined, port: number): boolean {
  if (list === null || list === undefined || list.trim() === "" || list.trim().toLowerCase() === "any") return true;
  for (const part of list.split(",")) {
    const t = part.trim();
    const dash = t.indexOf("-");
    if (dash > 0) {
      const a = Number(t.slice(0, dash)), b = Number(t.slice(dash + 1));
      if (Number.isInteger(a) && Number.isInteger(b) && port >= a && port <= b) return true;
    } else if (t !== "" && Number(t) === port) return true;
  }
  return false;
}

const tcpApplies = (p: string | null | undefined) => p === null || p === undefined || ["any", "tcp", "6"].includes(p.trim().toLowerCase());

export interface ProfileVerdict { profile: string; inUse: boolean; outcome: "allowed" | "blocked" | "conditional"; because: string; rules: string[] }
export interface PortAnalysis { port: number; listeners: Listener[]; loopbackOnly: boolean; verdicts: ProfileVerdict[]; incomplete: string[]; summary: { tone: "ok" | "warn" | "crit"; text: string } }

/** A rule that applies only to some programs or some addresses is not a plain yes or no for the port. */
const scoped = (r: Rule) => !!r.programPath || (!!r.remoteAddresses && !isAny(r.remoteAddresses)) || (!!r.localAddresses && !isAny(r.localAddresses));
const isAny = (v: string) => ["any", "*", ""].includes(v.trim().toLowerCase());
const scopeText = (r: Rule) => [r.programPath ? `program ${r.programPath}` : null, r.remoteAddresses && !isAny(r.remoteAddresses) ? `remote ${r.remoteAddresses}` : null, r.localAddresses && !isAny(r.localAddresses) ? `local ${r.localAddresses}` : null].filter(Boolean).join(", ");
export const isLoopback = (a: string) => a === "::1" || a.startsWith("127.") || a.toLowerCase().startsWith("::ffff:127.");

export function analysePort(port: number, rules: Rule[], profiles: Profile[], listeners: Listener[], activeProfiles: string[], cut: { listeners?: boolean; rules?: boolean } = {}): PortAnalysis {
  const on = listeners.filter(l => l.port === port);
  const loopbackOnly = on.length > 0 && on.every(l => isLoopback(l.address));
  const inbound = rules.filter(r => r.enabled && r.direction === "in" && tcpApplies(r.protocol) && portListIncludes(r.localPorts, port));
  const verdicts: ProfileVerdict[] = profiles.map(p => {
    const inUse = activeProfiles.includes(p.profile);
    const applies = inbound.filter(r => !r.profiles || r.profiles.length === 0 || r.profiles.includes(p.profile));
    const blocks = applies.filter(r => r.action === "block"), allows = applies.filter(r => r.action === "allow");
    if (!p.enabled) return { profile: p.profile, inUse, outcome: "allowed", because: "the firewall is off for this profile", rules: [] };
    const hardBlocks = blocks.filter(r => !scoped(r)), hardAllows = allows.filter(r => !scoped(r));
    if (hardBlocks.length) return { profile: p.profile, inUse, outcome: "blocked", because: "an enabled block rule matches (block wins over allow)", rules: hardBlocks.map(r => r.name) };
    if (blocks.length) return { profile: p.profile, inUse, outcome: "conditional", because: `a block rule matches only some traffic (${blocks.map(scopeText).join("; ")})`, rules: blocks.map(r => r.name) };
    if (hardAllows.length) return { profile: p.profile, inUse, outcome: "allowed", because: "an enabled allow rule matches", rules: hardAllows.map(r => r.name) };
    if (allows.length) return { profile: p.profile, inUse, outcome: "conditional", because: `the only allow rules are limited (${allows.map(scopeText).join("; ")}), so other programs or addresses are not allowed`, rules: allows.map(r => r.name) };
    return p.defaultInbound === "allow"
      ? { profile: p.profile, inUse, outcome: "allowed", because: "no rule matches and the default for inbound is allow", rules: [] }
      : { profile: p.profile, inUse, outcome: "blocked", because: "no rule matches and the default for inbound is block", rules: [] };
  });
  const relevant = verdicts.filter(v => v.inUse).length ? verdicts.filter(v => v.inUse) : verdicts;
  const blocked = relevant.filter(v => v.outcome === "blocked"), limited = relevant.filter(v => v.outcome === "conditional");
  const incomplete = [...(cut.listeners ? ["The list of listening ports was cut short, so the application may be listening and not shown."] : []), ...(cut.rules ? ["The firewall rule list was cut short, so a matching rule may not be shown."] : [])];
  const summary: PortAnalysis["summary"] =
    on.length === 0 && cut.listeners ? { tone: "warn", text: `Port ${port} is not in the part of the listening list that was read. It may be listening; the list was cut short.` }
    : on.length === 0 ? { tone: "crit", text: `Nothing is listening on ${port}. A firewall rule cannot help until the application is running and bound to it.` }
    : loopbackOnly ? { tone: "crit", text: `Port ${port} is bound to the loopback address only, so no other computer can reach it.` }
    : blocked.length === relevant.length ? { tone: "crit", text: `Listening, but the firewall blocks inbound ${port} on ${blocked.map(v => v.profile).join(", ")}.` }
    : blocked.length ? { tone: "warn", text: `Listening. Blocked on ${blocked.map(v => v.profile).join(", ")}; allowed on the others.` }
    : limited.length ? { tone: "warn", text: `Listening, but the rules for ${limited.map(v => v.profile).join(", ")} apply only to some programs or addresses. Check the scope below.` }
    : { tone: "ok", text: `Listening and allowed through the firewall on ${relevant.map(v => v.profile).join(", ")}.` };
  return { port, listeners: on, loopbackOnly, verdicts, incomplete, summary };
}
