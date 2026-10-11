// The network diagnosis checks (docs/spec/12-milestones-8-to-12.md "Automatic network diagnosis"): fixed rules, written as
// code with tests, that read the results of the cabinet's own network reads and tests and say what is wrong, the evidence,
// how sure they are, and the fix. A check whose evidence is missing says "could not check"; nothing is guessed. Pure
// functions: no database, no network, no regular expressions.
import type { FirewallStateOutput, NetworkConfigOutput, NetworkTestOutput } from "@mashura/cabinet-contracts/types";

export type Severity = "problem" | "warning" | "info" | "ok";
export type Certainty = "confirmed" | "probable" | "possible" | "not_checked";
/** Where in the path a finding sits, so many cabinets can be shown side by side: the link, the address, the gateway, DNS, the platform, the sync cabinet, the firewall. */
export type Layer = "link" | "address" | "gateway" | "dns" | "platform" | "sync" | "firewall";
export const LAYERS: readonly Layer[] = ["link", "address", "gateway", "dns", "platform", "sync", "firewall"];
/** A fix the platform can make. The parameters are the operation's own (network.setDns, network.setIp), filled in by the server from the site baseline. */
export type FixAction =
  | { kind: "apply_policy"; cabinetId: string; cabinetName: string }
  | { kind: "open"; section: string; cabinetId: string; label: string }
  | { kind: "set_dns"; cabinetId: string; cabinetName: string; interfaceIndex: number; servers: string[]; label: string }
  | { kind: "renew_lease"; cabinetId: string; cabinetName: string; interfaceIndex: number; label: string }
  | { kind: "use_dhcp"; cabinetId: string; cabinetName: string; interfaceIndex: number; label: string }
  | { kind: "set_static"; cabinetId: string; cabinetName: string; interfaceIndex: number; address: string; prefixLength: number; gateway: string; label: string };
export interface Finding {
  id: string; layer: Layer; severity: Severity; certainty: Certainty; title: string; evidence: string[]; fix: string | null; action?: FixAction;
  /** The id of the finding that probably explains this one (a wrong DNS setting explains "no DNS server answers"). */
  causedBy?: string;
}
export interface NetworkBaseline { addressing: "dhcp" | "static"; prefixLength: number; gateway: string; dnsServers: string[] }

export interface TestRun { key: string; label: string; params: Record<string, unknown>; output?: NetworkTestOutput; failure?: string }
export interface Profiles { domain: boolean; private: boolean; public: boolean }
export interface NetworkEvidence {
  cabinet: { id: string; name: string; role: string };
  config?: NetworkConfigOutput; configFailure?: string;
  firewall?: FirewallStateOutput; firewallFailure?: string;
  /** What the client's firewall policy asks for (true = on). */
  policy: Profiles;
  /** What the site's network should look like; null when nobody has set it. */
  baseline?: NetworkBaseline | null;
  sync: { address: string | null; ports: number[]; cabinet: { id: string; name: string; online: boolean; minutesSilent: number | null; profiles: Profiles | null } | null };
  tests: TestRun[];
}

const PROFILE_NAMES = ["domain", "private", "public"] as const;
const onOff = (p: Profiles) => PROFILE_NAMES.map(k => `${k[0]!.toUpperCase()}${k.slice(1)} ${p[k] ? "on" : "off"}`).join(", ");
const differs = (want: Profiles, have: Profiles) => PROFILE_NAMES.some(k => want[k] !== have[k]);
const isApipa = (a: string) => a.startsWith("169.254.");
const octets = (a: string): number | null => {
  const p = a.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) {
    if (x === "" || x.length > 3 || [...x].some(ch => ch < "0" || ch > "9")) return null;
    const v = Number(x);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
};
/** Whether two IPv4 addresses are on the same network of this size. */
export function sameSubnet(a: string, b: string, prefix: number): boolean {
  const x = octets(a), y = octets(b);
  if (x === null || y === null || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((x & mask) >>> 0) === ((y & mask) >>> 0);
}
const networkOf = (b: NetworkBaseline) => { const g = octets(b.gateway)!; const mask = b.prefixLength === 0 ? 0 : (0xffffffff << (32 - b.prefixLength)) >>> 0;
  const n = (g & mask) >>> 0; return `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}/${b.prefixLength}`; };
const list = (xs: string[]) => xs.length ? xs.join(", ") : "none";
const describe = (t: TestRun) => !t.output ? `${t.label}: no result (${t.failure ?? "no answer"})`
  : t.output.success ? `${t.label}: reached${t.output.resolvedTarget ? ` ${t.output.resolvedTarget}` : ""}${t.output.latencyMs !== null ? ` in ${t.output.latencyMs} ms` : ""}`
  : `${t.label}: failed${t.output.resolvedTarget ? ` (${t.output.resolvedTarget})` : ""}${t.output.error ? `: ${t.output.error}` : ""}`;
const RANK: Record<Severity, number> = { problem: 0, warning: 1, info: 2, ok: 3 };

const LAYER_OF: [string, Layer][] = [["link", "link"], ["speed-", "link"], ["config", "link"], ["ip-", "address"], ["baseline-addressing", "address"], ["baseline-ok", "address"], ["baseline-subnet", "address"],
  ["gateway", "gateway"], ["baseline-gateway", "gateway"], ["dns", "dns"], ["baseline-dns", "dns"], ["platform", "platform"], ["sync", "sync"], ["firewall", "firewall"]];
const layerOf = (id: string): Layer => LAYER_OF.filter(([p]) => id.startsWith(p)).sort((a, b) => b[0].length - a[0].length)[0]?.[1] ?? "link";

export function networkFindings(e: NetworkEvidence): Finding[] {
  const f: Finding[] = [];
  const add = (x: Omit<Finding, "layer">) => f.push({ ...x, layer: layerOf(x.id) });
  const tests = (prefix: string) => e.tests.filter(t => t.key.startsWith(prefix));
  const answered = (t: TestRun) => t.output !== undefined;
  const ok = (t: TestRun) => t.output?.success === true;

  // ---- The link and the address -------------------------------------------------------------
  if (!e.config) {
    add({ id: "config", severity: "info", certainty: "not_checked", title: "Could not read the network settings", evidence: [e.configFailure ?? "No answer from the cabinet."], fix: "Run the diagnosis again; if it keeps failing, check the cabinet is online." });
  } else {
    const adapters = e.config.adapters.filter(a => a.type !== "other");
    const connected = adapters.filter(a => a.connected);
    if (connected.length === 0)
      add({ id: "link", severity: "problem", certainty: "confirmed", title: "No network link on any adapter",
        evidence: adapters.map(a => `${a.name}${a.description ? ` (${a.description})` : ""}: disconnected`),
        fix: "Physical: check the network cable at both ends and the switch port's link light. Try another switch port, then another cable. If the link light stays off with a known-good cable and port, the network card may have failed." });
    for (const a of connected) {
      const v4 = a.ipv4.addresses.map(x => x.address);
      if (v4.length === 0 || v4.every(isApipa))
        add({ id: `ip-${a.interfaceIndex}`, severity: "problem", certainty: "confirmed", title: `No usable IP address on ${a.name}`,
          evidence: [v4.length === 0 ? `${a.name} is connected but has no IPv4 address.` : `${a.name} has only ${v4.join(", ")}: Windows gave itself a 169.254 address because no DHCP server answered.`],
          fix: a.ipv4.dhcp ? "The DHCP server did not answer this cabinet. Renew the lease (one step below). If it keeps failing, check the DHCP server and that the switch port is on the right VLAN."
            : "The address is set by hand but missing: set the correct static address under Network → Edit IP.",
          ...(a.ipv4.dhcp ? { action: { kind: "renew_lease" as const, cabinetId: e.cabinet.id, cabinetName: e.cabinet.name, interfaceIndex: a.interfaceIndex, label: `Renew the DHCP lease on ${a.name}` } } : {}) });
      else add({ id: `ip-${a.interfaceIndex}`, severity: "ok", certainty: "confirmed", title: `${a.name} has an address`, evidence: [`${v4.join(", ")} (${a.ipv4.dhcp ? "DHCP" : "static"})`], fix: null });
      if (a.type === "ethernet" && a.linkSpeedBps !== null && a.linkSpeedBps > 0 && a.linkSpeedBps <= 100_000_000)
        add({ id: `speed-${a.interfaceIndex}`, severity: "warning", certainty: "probable", title: `${a.name} linked at only ${a.linkSpeedBps / 1e6} Mbps`,
          evidence: [`${a.description ?? a.name} negotiated ${a.linkSpeedBps / 1e6} Mbps. A gigabit link that falls back to 100 Mbps usually has a damaged cable pair.`],
          fix: "Physical: replace the patch cable (and check the wall jack). If it stays at 100 Mbps, check the switch port is not fixed to 100 Mbps." });
      else if (a.type === "ethernet" && a.linkSpeedBps)
        add({ id: `speed-${a.interfaceIndex}`, severity: "ok", certainty: "confirmed", title: `${a.name} link at ${a.linkSpeedBps >= 1e9 ? `${a.linkSpeedBps / 1e9} Gbps` : `${a.linkSpeedBps / 1e6} Mbps`}`, evidence: [a.description ?? a.name], fix: null });
    }
    if (connected.length > 0 && connected.every(a => a.ipv4.gateways.length === 0))
      add({ id: "gateway-none", severity: "problem", certainty: "confirmed", title: "No default gateway",
        evidence: connected.map(a => `${a.name}: no gateway`), fix: "Traffic cannot leave the local network. Fix the gateway in the adapter's IP settings (Network → Edit IP), or the DHCP scope if it is automatic." });

    // ---- Against the site's baseline ---------------------------------------------------------
    const b = e.baseline ?? null;
    if (b) for (const a of connected) {
      const addr = a.ipv4.addresses.find(x => !isApipa(x.address));
      const before = f.length;
      if (addr && !sameSubnet(addr.address, b.gateway, b.prefixLength)) {
        add({ id: `baseline-subnet-${a.interfaceIndex}`, severity: "problem", certainty: "confirmed", title: `${a.name} has an address outside the site's network`,
          evidence: [`${a.name} is ${addr.address}/${addr.prefixLength} (${a.ipv4.dhcp ? "DHCP" : "set by hand"}); the baseline for this site is ${networkOf(b)} with gateway ${b.gateway}.`,
            "A cabinet on another network cannot reach the site's gateway, DNS servers or sync cabinet."],
          fix: b.addressing === "dhcp" ? `This site uses DHCP: switch ${a.name} back to DHCP to get an address on ${networkOf(b)}.`
            : `This site uses fixed addresses: set ${a.name}'s address to one inside ${networkOf(b)} (Network → Edit IP).`,
          ...(b.addressing === "dhcp" ? { action: { kind: "use_dhcp" as const, cabinetId: e.cabinet.id, cabinetName: e.cabinet.name, interfaceIndex: a.interfaceIndex, label: `Switch ${a.name} to DHCP` } } : {}) });
        continue;
      }
      if (addr && b.addressing === "dhcp" && !a.ipv4.dhcp)
        add({ id: `baseline-addressing-${a.interfaceIndex}`, severity: "warning", certainty: "confirmed", title: `${a.name} has a fixed address, but this site uses DHCP`,
          evidence: [`${a.name} is set by hand to ${addr.address}. The baseline says addresses come from DHCP, so this one will not follow changes to the DHCP scope.`],
          fix: `Switch ${a.name} to DHCP.`,
          action: { kind: "use_dhcp" as const, cabinetId: e.cabinet.id, cabinetName: e.cabinet.name, interfaceIndex: a.interfaceIndex, label: `Switch ${a.name} to DHCP` } });
      const gw = a.ipv4.gateways[0];
      if (addr && gw !== undefined && gw !== b.gateway)
        add({ id: `baseline-gateway-${a.interfaceIndex}`, severity: "problem", certainty: "confirmed", title: `${a.name} uses the wrong gateway`,
          evidence: [`${a.name}'s gateway is ${gw}; the baseline for this site is ${b.gateway}.`, "Traffic to other networks goes to an address that is not the site's router."],
          fix: a.ipv4.dhcp ? "The gateway comes from DHCP, so the DHCP scope hands out the wrong router: fix it on the DHCP server." : `Set the gateway to ${b.gateway}; the address stays ${addr.address}.`,
          ...(!a.ipv4.dhcp ? { action: { kind: "set_static" as const, cabinetId: e.cabinet.id, cabinetName: e.cabinet.name, interfaceIndex: a.interfaceIndex, address: addr.address,
            prefixLength: b.prefixLength, gateway: b.gateway, label: `Set the gateway to ${b.gateway}` } } : {}) });
      const have = [...a.dns.servers].sort(), want = [...b.dnsServers].sort();
      if (have.length > 0 && (have.length !== want.length || have.some((x, i) => x !== want[i]))) {
        const none = !a.dns.servers.some(x => b.dnsServers.includes(x));
        add({ id: `baseline-dns-${a.interfaceIndex}`, severity: none ? "problem" : "warning", certainty: "confirmed", title: `${a.name} uses DNS servers that are not the site's`,
          evidence: [`${a.name} uses ${list(a.dns.servers)}; the baseline for this site is ${list(b.dnsServers)}.`,
            none ? "None of the site's DNS servers is in use, so names on the site network may not resolve." : "Some of the site's DNS servers are missing or extra ones are listed."],
          fix: `Set ${a.name}'s DNS servers to ${list(b.dnsServers)}.`,
          action: { kind: "set_dns" as const, cabinetId: e.cabinet.id, cabinetName: e.cabinet.name, interfaceIndex: a.interfaceIndex, servers: b.dnsServers, label: `Set DNS to ${list(b.dnsServers)}` } });
      }
      if (addr && f.length === before)
        add({ id: `baseline-ok-${a.interfaceIndex}`, severity: "ok", certainty: "confirmed", title: `${a.name} matches the site baseline`,
          evidence: [`Address ${addr.address} is on ${networkOf(b)}, the gateway is ${b.gateway}, DNS is ${list(b.dnsServers)}, ${b.addressing === "dhcp" ? "from DHCP" : "fixed"}.`], fix: null });
    }
  }

  // ---- Gateway, DNS, platform ------------------------------------------------------------
  const gateway = tests("gateway")[0];
  const beyond = [...tests("platform"), ...tests("dns"), ...tests("sync")].some(ok);
  if (gateway && answered(gateway)) {
    if (ok(gateway)) add({ id: "gateway", severity: "ok", certainty: "confirmed", title: "The gateway answers", evidence: [describe(gateway)], fix: null });
    else if (beyond) add({ id: "gateway", severity: "info", certainty: "possible", title: "The gateway does not answer ping, but traffic gets through",
      evidence: [describe(gateway), "Other tests reached their targets, so the gateway probably just blocks ping."], fix: null });
    else add({ id: "gateway", severity: "problem", certainty: "probable", title: "The gateway does not answer",
      evidence: [describe(gateway), "No other test reached its target either."],
      fix: "Check the cable and switch port, that the switch port is on the right VLAN, and that the gateway address in the IP settings is correct." });
  } else if (gateway) add({ id: "gateway", severity: "info", certainty: "not_checked", title: "Could not test the gateway", evidence: [describe(gateway)], fix: null });

  const dns = tests("dns");
  const dnsAnswered = dns.filter(answered);
  const dnsBad = dnsAnswered.filter(t => !ok(t));
  if (dnsAnswered.length > 0 && dnsBad.length === dnsAnswered.length)
    add({ id: "dns-all", severity: "problem", certainty: "confirmed", title: "No DNS server answers", evidence: dnsBad.map(describe),
      fix: "Names cannot be resolved, so anything addressed by name fails. Check the DNS servers set on the adapter (Network → Edit DNS) and that those servers are up." });
  else for (const t of dnsBad)
    add({ id: `dns-${t.key}`, severity: "warning", certainty: "confirmed", title: `${t.label} does not answer`, evidence: [describe(t), "Windows falls back to the next server, so lookups are slower and fail when the others are busy."],
      fix: "Remove or replace this server in the adapter's DNS settings (Network → Edit DNS), or fix the server." });
  if (dnsAnswered.length > 0 && dnsBad.length < dnsAnswered.length)
    add({ id: "dns-ok", severity: "ok", certainty: "confirmed", title: `${dnsAnswered.length - dnsBad.length} of ${dnsAnswered.length} DNS servers answer`, evidence: dnsAnswered.filter(ok).map(describe), fix: null });
  for (const t of dns.filter(t => !answered(t))) add({ id: `dns-${t.key}`, severity: "info", certainty: "not_checked", title: `Could not test ${t.label}`, evidence: [describe(t)], fix: null });

  const platform = tests("platform")[0];
  if (platform && answered(platform) && !ok(platform))
    add({ id: "platform-dns", severity: dnsBad.length === dnsAnswered.length ? "info" : "warning", certainty: "probable", title: "The platform server's name does not resolve",
      evidence: [describe(platform), "The agent is still connected, so it is using an address it resolved earlier; it will lose the server when that runs out."],
      fix: "Check the DNS servers (above) and any proxy or hosts-file entry for the platform server." });

  // ---- The sync cabinet ----------------------------------------------------------------------
  const isSync = e.cabinet.role === "sync";
  if (isSync) add({ id: "sync-self", severity: "info", certainty: "confirmed", title: "This is the site's sync cabinet", evidence: ["Its satellites connect to it; run the diagnosis on a satellite to test the connection to it."], fix: null });
  else if (!e.sync.address)
    add({ id: "sync-none", severity: "info", certainty: "not_checked", title: "The site has no sync cabinet address", evidence: ["Nothing to test the satellite-to-sync connection against."],
      fix: "An Admin sets the sync cabinet's address on the site page; then run the diagnosis again." });
  else {
    const ping = tests("sync-ping")[0];
    const ports = tests("sync-tcp");
    const portsOk = ports.filter(ok), portsBad = ports.filter(t => answered(t) && !ok(t));
    const sc = e.sync.cabinet;
    const scName = sc ? sc.name : `the sync cabinet (${e.sync.address})`;
    const scFirewallOn = sc?.profiles ? PROFILE_NAMES.filter(k => sc.profiles![k] && !e.policy[k]) : [];
    const silent = sc && !sc.online ? [`${sc.name} has not checked in with the platform for ${sc.minutesSilent ?? "?"} minutes: it may be off, restarting, or off the network.`] : [];
    if (ping && answered(ping) && !ok(ping) && portsOk.length === 0)
      add({ id: "sync-down", severity: "problem", certainty: "probable", title: `Cannot reach ${scName}`,
        evidence: [describe(ping), ...portsBad.map(describe), ...silent],
        fix: silent.length ? `Check ${sc!.name} is powered on and connected; open it in the platform once it is back.`
          : "It is up (it checks in with the platform) but this cabinet cannot reach it: check both are on the same network or VLAN, the routes, and the firewall on both." });
    else if (portsBad.length > 0) {
      if (scFirewallOn.length > 0)
        add({ id: "sync-firewall", severity: "problem", certainty: "probable", title: `The firewall on ${scName} is blocking port${portsBad.length > 1 ? "s" : ""} ${portsBad.map(t => t.params.port).join(", ")}`,
          evidence: [...(ping && ok(ping) ? [describe(ping)] : []), ...portsBad.map(describe),
            `${sc!.name} reports ${onOff(sc!.profiles!)}; the client policy says ${onOff(e.policy)}.`],
          fix: `Apply the client's firewall policy on ${sc!.name}: this is the usual fix for a satellite that cannot sync.`,
          action: { kind: "apply_policy", cabinetId: sc!.id, cabinetName: sc!.name } });
      else
        add({ id: "sync-port", severity: "problem", certainty: "possible", title: `Port${portsBad.length > 1 ? "s" : ""} ${portsBad.map(t => t.params.port).join(", ")} on ${scName} do not answer`,
          evidence: [...(ping ? [describe(ping)] : []), ...portsBad.map(describe), ...(sc?.profiles ? [`${sc.name} reports ${onOff(sc.profiles)}, as the policy asks.`] : ["The sync cabinet's firewall state is not known to the platform."]), ...silent],
          fix: `The sync software's service on ${scName} may be stopped (check its Services section), or another firewall or rule blocks the port.`,
          ...(sc ? { action: { kind: "open" as const, section: "services", cabinetId: sc.id, label: `Open ${sc.name}'s services` } } : {}) });
    } else if (portsOk.length > 0 || (ping && ok(ping)))
      add({ id: "sync-ok", severity: "ok", certainty: "confirmed", title: `${scName} is reachable`, evidence: [...(ping ? [describe(ping)] : []), ...portsOk.map(describe),
        ...(ports.length === 0 ? ["No sync ports are set for this site, so only ping was tested."] : [])], fix: null });
    if (ping && answered(ping) && !ok(ping) && portsOk.length > 0)
      add({ id: "sync-ping", severity: "info", certainty: "possible", title: `${scName} does not answer ping, but its ports do`, evidence: [describe(ping)], fix: null });
    for (const t of [ping, ...ports].filter((t): t is TestRun => !!t && !answered(t)))
      add({ id: `sync-nc-${t.key}`, severity: "info", certainty: "not_checked", title: `Could not test ${t.label}`, evidence: [describe(t)], fix: null });
  }

  // ---- This cabinet's firewall -----------------------------------------------------------------
  if (e.firewall) {
    const have: Profiles = { domain: false, private: false, public: false };
    for (const p of e.firewall.profiles) have[p.profile] = p.enabled;
    if (differs(e.policy, have))
      add({ id: "firewall", severity: "warning", certainty: "confirmed", title: "This cabinet's firewall differs from the client policy",
        evidence: [`Now: ${onOff(have)}. Policy: ${onOff(e.policy)}.`], fix: "Apply the client's firewall policy (one click).",
        action: { kind: "apply_policy", cabinetId: e.cabinet.id, cabinetName: e.cabinet.name } });
    else add({ id: "firewall", severity: "ok", certainty: "confirmed", title: "The firewall matches the client policy", evidence: [onOff(have)], fix: null });
  } else add({ id: "firewall", severity: "info", certainty: "not_checked", title: "Could not read the firewall", evidence: [e.firewallFailure ?? "No answer."], fix: null });

  // A wrong subnet, gateway or DNS setting explains the failed tests that follow from it: link them, so the cause is fixed first.
  const causes = f.filter(x => x.id.startsWith("baseline-") && x.severity === "problem");
  const link = (ids: string[], layers: Layer[]) => {
    const cause = causes.find(c => layers.includes(c.layer));
    if (cause) for (const x of f) if (ids.some(i => x.id === i || x.id.startsWith(i)) && x.severity !== "ok" && x.severity !== "info") x.causedBy = cause.id;
  };
  const subnetCause = causes.find(c => c.id.startsWith("baseline-subnet"));
  if (subnetCause) for (const x of f) if (["gateway", "dns-", "platform-dns", "sync-down", "sync-firewall", "sync-port"].some(i => x.id === i || x.id.startsWith(i)) && (x.severity === "problem" || x.severity === "warning")) x.causedBy = subnetCause.id;
  link(["gateway"], ["gateway"]);
  link(["dns-all", "dns-dns", "platform-dns"], ["dns"]);
  return f.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

/** One word per layer for a cabinet: how its path looks from the link up to the firewall. "unknown" when nothing there could be checked. */
export function layerStates(findings: Finding[]): Record<Layer, "ok" | "warning" | "problem" | "unknown"> {
  const out = {} as Record<Layer, "ok" | "warning" | "problem" | "unknown">;
  for (const layer of LAYERS) {
    const mine = findings.filter(x => x.layer === layer);
    out[layer] = mine.some(x => x.severity === "problem") ? "problem" : mine.some(x => x.severity === "warning") ? "warning" : mine.some(x => x.severity === "ok") ? "ok" : "unknown";
  }
  return out;
}
