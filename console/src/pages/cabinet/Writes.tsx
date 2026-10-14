// Write actions in the cabinet view (docs/spec/06-console-spec.md, 12-milestones-8-to-12.md): shown to the roles
// the catalog allows on cabinets that accept changes, each behind a confirmation that says exactly what changes on
// which cabinet: a click for quick, self-healing changes, or an authenticator code bound to the exact parameters.
// The server and the agent check all of it again; nothing here is the protection.
import { useEffect, useState, type ReactNode } from "react";
import type { NetworkFlushDnsOutput, UpdatesUninstallOutput, DriverUninstallOutput, FirewallApplyPolicyOutput, FirewallProfileState, FirewallRestoreOutput, FirewallRule, FirewallSetProfileOutput, FirewallSetRuleOutput,
  FirewallStateOutput, NetworkConfigOutput, NetworkRenewLeaseOutput, NetworkSetDnsOutput, NetworkSetIpOutput, ReportedFirewallRule } from "@mashura/cabinet-contracts/types";
import { useWrite, type CommandResult } from "../../lib/commands";
import { useSession } from "../../lib/session";
import { canWrite, useWriteStatus } from "../../lib/writes";
import { fullTime } from "../../lib/time";
import { useLoad } from "../../lib/useLoad";
import { Badge, ConfirmDialog, Empty, SAFETY_NET_NOTE, StepUpDialog, WriteOutcome } from "../../components/ui";
import { confirmFor } from "../../lib/confirm";
import type { CabinetDetail } from "./CabinetPage";

type Adapter = NetworkConfigOutput["adapters"][number];
type Profile = FirewallProfileState["profile"];

/** Whether write controls show for this cabinet (role, read-only, pauses); the server decides for real. */
export function useCanWrite(cabinet: CabinetDetail, operation?: string): boolean {
  const { me } = useSession();
  const { status } = useWriteStatus();
  return canWrite(me, cabinet, status, operation);
}

/**
 * One write with its confirmation: ask() opens the dialog the catalog calls for (a click, or an authenticator code
 * bound to these exact parameters), which issues the command once confirmed.
 */
export function useConfirmedWrite<T>(cabinet: CabinetDetail, operation: string, after?: (r: CommandResult<T>) => void) {
  const write = useWrite<T>(cabinet.id, operation);
  const [pending, setPending] = useState<{ params: Record<string, unknown>; description: ReactNode } | null>(null);
  const description = <>
    {pending?.description}
    <p>On cabinet <strong>{cabinet.name}</strong> ({cabinet.client.name} · {cabinet.site.name}).</p>
  </>;
  const dialog = confirmFor(operation) === "click"
    ? <ConfirmDialog open={pending !== null} onClose={() => setPending(null)} description={description}
        onConfirm={async () => { if (pending) await write.begin(pending.params, undefined, after); }} />
    : <StepUpDialog open={pending !== null} action={operation} target={cabinet.id} onClose={() => setPending(null)} description={description}
        params={pending?.params} onToken={async token => { if (pending) await write.begin(pending.params, token, after); }} />;
  return { run: write as typeof write, ask: (params: Record<string, unknown>, description: ReactNode) => setPending({ params, description }), dialog };
}

const deadlineNote = (deadline: string) => <> The safety net kept the change: the cabinet confirmed it reached the server before {fullTime(deadline)}.</>;

// ---- Network ------------------------------------------------------------------------------

/**
 * The IP and DNS writes for a cabinet's adapters. They live at the section level, not in the adapter card,
 * so the answer stays on screen while the adapter list is read again after the change.
 */
export function useAdapterWrites(cabinet: CabinetDetail, onChanged: () => void) {
  const ip = useConfirmedWrite<NetworkSetIpOutput>(cabinet, "network.setIp", r => { if (r.status === "succeeded") onChanged(); });
  const dns = useConfirmedWrite<NetworkSetDnsOutput>(cabinet, "network.setDns", r => { if (r.status === "succeeded") onChanged(); });
  const renew = useConfirmedWrite<NetworkRenewLeaseOutput>(cabinet, "network.renewLease", r => { if (r.status === "succeeded") onChanged(); });
  return {
    ip, dns, renew,
    outcome: <>
      <WriteOutcome run={renew.run} done={o => o.result === "renewed" ? <>Lease renewed: the cabinet now has {o.addressAfter}{o.addressBefore && o.addressBefore !== o.addressAfter ? <> (it had {o.addressBefore})</> : null}.</>
        : <>{o.message}</>} />
      <WriteOutcome run={ip.run} done={o => <>IP settings changed: {o.after.dhcp ? "DHCP" : o.after.addresses.map(a => `${a.address}/${a.prefixLength}`).join(", ")}.{deadlineNote(o.safetyNetDeadline)}</>} />
      <WriteOutcome run={dns.run} done={o => <>DNS changed: {o.after.automatic ? "automatic" : o.after.servers.join(", ")}.{deadlineNote(o.safetyNetDeadline)}</>} />
    </>,
    dialog: <>{ip.dialog}{dns.dialog}{renew.dialog}</>,
  };
}

export function AdapterEdit({ cabinet, adapter, writes }: { cabinet: CabinetDetail; adapter: Adapter; writes: ReturnType<typeof useAdapterWrites> }) {
  const allowed = useCanWrite(cabinet, "network.setIp");
  const canRenew = useCanWrite(cabinet, "network.renewLease");
  const { ip, dns, renew } = writes;
  const current = adapter.ipv4.addresses[0];
  const [editing, setEditing] = useState<null | "ip" | "dns">(null);
  const [ipForm, setIpForm] = useState({ mode: adapter.ipv4.dhcp ? "dhcp" : "static", address: current?.address ?? "", prefix: String(current?.prefixLength ?? 24), gateway: adapter.ipv4.gateways[0] ?? "" });
  const [dnsForm, setDnsForm] = useState({ mode: adapter.dns.automatic ? "automatic" : "static", servers: adapter.dns.servers.join(", ") });
  if (!allowed && !canRenew) return null;

  const warn = <div className="notice warn"><p>The cabinet may drop off the network for a moment while the adapter changes.</p><p>{SAFETY_NET_NOTE}</p></div>;
  const reviewIp = () => {
    setEditing(null);
    const params: Record<string, unknown> = ipForm.mode === "dhcp" ? { interfaceIndex: adapter.interfaceIndex, mode: "dhcp" }
      : { interfaceIndex: adapter.interfaceIndex, mode: "static", address: ipForm.address.trim(), prefixLength: Number(ipForm.prefix), gateway: ipForm.gateway.trim() };
    ip.ask(params, <>
      <p>Change the IP settings of adapter <strong>{adapter.name}</strong>:</p>
      <SideBySide rows={[
        ["Addressing", adapter.ipv4.dhcp ? "DHCP" : "Static", ipForm.mode === "dhcp" ? "DHCP" : "Static"],
        ["IPv4", adapter.ipv4.addresses.map(a => `${a.address}/${a.prefixLength}`).join(", ") || "none", ipForm.mode === "dhcp" ? "from DHCP" : `${ipForm.address.trim()}/${ipForm.prefix}`],
        ["Gateway", adapter.ipv4.gateways.join(", ") || "none", ipForm.mode === "dhcp" ? "from DHCP" : ipForm.gateway.trim()],
      ]} />
      {warn}
    </>);
  };
  const servers = dnsForm.servers.split(",").map(s => s.trim()).filter(Boolean);
  const reviewDns = () => {
    setEditing(null);
    dns.ask(dnsForm.mode === "automatic" ? { interfaceIndex: adapter.interfaceIndex, mode: "automatic" } : { interfaceIndex: adapter.interfaceIndex, mode: "static", servers }, <>
      <p>Change the DNS servers of adapter <strong>{adapter.name}</strong>:</p>
      <SideBySide rows={[["DNS servers", `${adapter.dns.servers.join(", ") || "none"} (${adapter.dns.automatic ? "automatic" : "set by hand"})`,
        dnsForm.mode === "automatic" ? "automatic (from DHCP)" : servers.join(", ")]]} />
      {warn}
    </>);
  };

  return (
    <div className="write-actions">
      <div className="row gap wrap">
        {canRenew && adapter.ipv4.dhcp && <button className="btn" disabled={renew.run.state === "running"}
          onClick={() => renew.ask({ interfaceIndex: adapter.interfaceIndex }, <><p>Ask the DHCP server for a new lease on adapter <strong>{adapter.name}</strong>.</p>
            <p className="muted small">No setting changes. If no server answers, the cabinet keeps what it has and the answer says so.</p></>)}>Renew DHCP lease</button>}
        {allowed && <button className="btn" disabled={ip.run.state === "running" || dns.run.state === "running"} onClick={() => setEditing(editing === "ip" ? null : "ip")} aria-expanded={editing === "ip"}>Edit IP settings</button>}
        {allowed && <button className="btn" disabled={ip.run.state === "running" || dns.run.state === "running"} onClick={() => setEditing(editing === "dns" ? null : "dns")} aria-expanded={editing === "dns"}>Edit DNS</button>}
      </div>
      {allowed && editing === "ip" && (
        <form className="form" aria-label={`IP settings for ${adapter.name}`} onSubmit={e => { e.preventDefault(); reviewIp(); }}>
          <fieldset><legend>Addressing</legend>
            {(["dhcp", "static"] as const).map(m => <label key={m} className="check"><input type="radio" name={`mode-${adapter.interfaceIndex}`} checked={ipForm.mode === m}
              onChange={() => setIpForm(f => ({ ...f, mode: m }))} /> {m === "dhcp" ? "DHCP (automatic)" : "Static"}</label>)}
          </fieldset>
          {ipForm.mode === "static" && <div className="row gap wrap">
            <label className="field inline"><span>IPv4 address</span><input required value={ipForm.address} onChange={e => setIpForm(f => ({ ...f, address: e.target.value }))} /></label>
            <label className="field inline"><span>Prefix length</span><input required inputMode="numeric" size={3} value={ipForm.prefix} onChange={e => setIpForm(f => ({ ...f, prefix: e.target.value.replace(/\D/g, "") }))} /></label>
            <label className="field inline"><span>Gateway</span><input required value={ipForm.gateway} onChange={e => setIpForm(f => ({ ...f, gateway: e.target.value }))} /></label>
          </div>}
          <button className="btn primary" type="submit">Review the change</button>
        </form>)}
      {allowed && editing === "dns" && (
        <form className="form" aria-label={`DNS for ${adapter.name}`} onSubmit={e => { e.preventDefault(); reviewDns(); }}>
          <fieldset><legend>DNS servers</legend>
            {(["automatic", "static"] as const).map(m => <label key={m} className="check"><input type="radio" name={`dns-${adapter.interfaceIndex}`} checked={dnsForm.mode === m}
              onChange={() => setDnsForm(f => ({ ...f, mode: m }))} /> {m === "automatic" ? "Automatic (from DHCP)" : "Set by hand"}</label>)}
          </fieldset>
          {dnsForm.mode === "static" && <label className="field"><span>Up to 4 servers, separated by commas</span>
            <input required value={dnsForm.servers} onChange={e => setDnsForm(f => ({ ...f, servers: e.target.value }))} /></label>}
          <button className="btn primary" type="submit" disabled={dnsForm.mode === "static" && (servers.length < 1 || servers.length > 4)}>Review the change</button>
        </form>)}
    </div>
  );
}

function SideBySide({ rows }: { rows: [string, string, string][] }) {
  return (
    <table className="table compact">
      <caption className="sr-only">Current and new values</caption>
      <thead><tr><th scope="col">Setting</th><th scope="col">Now</th><th scope="col">After the change</th></tr></thead>
      <tbody>{rows.map(([k, a, b]) => <tr key={k}><th scope="row">{k}</th><td>{a}</td><td><strong>{b}</strong></td></tr>)}</tbody>
    </table>
  );
}

// ---- Firewall profiles --------------------------------------------------------------------

const PROFILE_NAME: Record<Profile, string> = { domain: "Domain", private: "Private", public: "Public" };
const DURATIONS = [15, 30, 60, 120, 240, 480];
const durationLabel = (m: number) => m < 60 ? `${m} minutes` : m === 60 ? "1 hour" : `${m / 60} hours`;

/** "Turns back on in 42 min", ticking. */
export function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);
  const minutes = Math.max(0, Math.ceil((new Date(until).getTime() - now) / 60_000));
  return <span>Turns itself back on at {fullTime(until)} ({minutes <= 0 ? "any moment" : minutes === 1 ? "in 1 minute" : `in ${minutes} minutes`}).</span>;
}

/** The profile write, at the section level so its answer survives the firewall being read again. */
export function useProfileWrite(cabinet: CabinetDetail, onChanged: () => void) {
  const w = useConfirmedWrite<FirewallSetProfileOutput>(cabinet, "firewall.setProfile", r => { if (r.status === "succeeded") onChanged(); });
  return {
    ...w,
    outcome: <WriteOutcome run={w.run} done={o => <>{PROFILE_NAME[o.profile]} profile is now {o.after.enabled ? "on" : "off"}.{o.after.reenableAt && <> It turns back on at {fullTime(o.after.reenableAt)}.</>}</>} />,
  };
}

export function ProfileControl({ cabinet, profile, write: w }: { cabinet: CabinetDetail; profile: FirewallProfileState; write: ReturnType<typeof useProfileWrite> }) {
  const allowed = useCanWrite(cabinet, "firewall.setProfile");
  const [choosing, setChoosing] = useState(false);
  const [duration, setDuration] = useState<string>("60");
  if (!allowed) return null;
  const name = PROFILE_NAME[profile.profile];
  const base = { profile: profile.profile, defaultInbound: profile.defaultInbound, defaultOutbound: profile.defaultOutbound };
  const turnOff = () => {
    const noLimit = duration === "none";
    w.ask({ ...base, enabled: false, ...(noLimit ? { noTimeLimit: true } : { durationMinutes: Number(duration) }) }, <>
      <p>Turn the <strong>{name}</strong> firewall profile <strong>off</strong> {noLimit ? <strong>with no time limit</strong> : <>for <strong>{durationLabel(Number(duration))}</strong></>}.</p>
      {noLimit
        ? <div className="notice crit"><p>The profile stays off until someone turns it back on. The cabinet is unprotected by this profile until then.</p></div>
        : <p>It turns itself back on after {durationLabel(Number(duration))}, even if the cabinet restarts in between.</p>}
      <p className="muted small">{SAFETY_NET_NOTE}</p>
    </>);
    setChoosing(false);
  };
  const turnOn = () => w.ask({ ...base, enabled: true }, <>
    <p>Turn the <strong>{name}</strong> firewall profile back <strong>on</strong>{profile.reenableAt ? <>, before its timer does</> : null}.</p>
    <p className="muted small">{SAFETY_NET_NOTE}</p>
  </>);
  return (
    <div className="write-actions">
      {profile.enabled
        ? (choosing
          ? <form className="form" aria-label={`Turn off the ${name} profile`} onSubmit={e => { e.preventDefault(); turnOff(); }}>
              <label className="field inline"><span>Turn off for</span>
                <select value={duration} onChange={e => setDuration(e.target.value)}>
                  {DURATIONS.map(m => <option key={m} value={m}>{durationLabel(m)}</option>)}
                  <option value="none">No time limit</option>
                </select></label>
              {duration === "none" && <p className="notice crit small">With no time limit the profile stays off until someone turns it back on.</p>}
              <div className="row gap"><button type="button" className="btn" onClick={() => setChoosing(false)}>Cancel</button><button className="btn danger" type="submit">Review</button></div>
            </form>
          : <button className="btn" onClick={() => setChoosing(true)}>Turn off…</button>)
        : <button className="btn primary" disabled={w.run.state === "running"} onClick={turnOn}>Turn on</button>}
    </div>
  );
}

// ---- Client firewall policy ----------------------------------------------------------------

interface CabinetPolicy { policy: Record<Profile, "on" | "off">; source: "client" | "fleet"; reported: Record<Profile, boolean> | null; differs: boolean | null; readOnly: boolean | null }

/**
 * The client's firewall policy for this cabinet, what the cabinet last reported, and Apply policy (a click, Tier 1 and
 * up). The server fills the profiles in from the policy; the console sends none.
 */
export function FirewallPolicyPanel({ cabinet, version, onChanged }: { cabinet: CabinetDetail; version: number; onChanged: () => void }) {
  const { data, reload } = useLoad<CabinetPolicy>(`/api/cabinets/${cabinet.id}/firewall-policy`);
  useEffect(() => { if (version > 0) reload(); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const allowed = useCanWrite(cabinet, "firewall.applyPolicy");
  // The cabinet reports its profiles with each heartbeat: look again every 15 seconds until it has, and after a change.
  const waiting = data?.differs === null;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
  }, [waiting]); // eslint-disable-line react-hooks/exhaustive-deps
  const w = useConfirmedWrite<FirewallApplyPolicyOutput>(cabinet, "firewall.applyPolicy", r => { if (r.status === "succeeded") { onChanged(); reload(); } });
  if (!data) return null;
  const profiles: Profile[] = ["domain", "private", "public"];
  const wanted = profiles.map(p => `${PROFILE_NAME[p]} ${data.policy[p]}`).join(", ");
  return (
    <section className="panel" aria-labelledby="fw-policy">
      <h3 id="fw-policy">Firewall policy {data.differs === true ? <Badge tone="warn">Differs</Badge> : data.differs === false ? <Badge tone="ok">Matches</Badge> : <Badge tone="off">Not reported yet</Badge>}</h3>
      <p>{data.source === "client" ? `${cabinet.client.name}'s policy` : "The fleet default policy"}: <strong>{wanted}</strong>.</p>
      {data.reported && <p className="muted small">The cabinet last reported: {profiles.map(p => `${PROFILE_NAME[p]} ${data.reported![p] ? "on" : "off"}`).join(", ")}.</p>}
      {allowed && data.differs !== false && <button className="btn primary" disabled={w.run.state === "running"} onClick={() => w.ask({}, <>
        <p>Set the firewall profiles as the policy says: <strong>{wanted}</strong>.</p>
        <p className="muted small">Profiles turned off by the policy stay off with no timer. A snapshot is taken first. {SAFETY_NET_NOTE}</p>
      </>)}>Apply policy</button>}
      <WriteOutcome run={w.run} done={o => <>{o.changed.length === 0 ? "The cabinet already matched the policy." : `Changed: ${o.changed.map(p => PROFILE_NAME[p]).join(", ")}.`}{deadlineNote(o.safetyNetDeadline)}</>} />
      {w.dialog}
    </section>
  );
}

// ---- Firewall rules -----------------------------------------------------------------------

const PROTOCOLS = ["any", "tcp", "udp", "icmpv4"] as const;
type RuleForm = { name: string; direction: "in" | "out"; action: "allow" | "block"; protocol: (typeof PROTOCOLS)[number]; localPorts: string; remotePorts: string;
  localAddresses: string; remoteAddresses: string; programPath: string; profiles: Profile[]; enabled: boolean };

const EMPTY_RULE: RuleForm = { name: "MashuraDiag ", direction: "in", action: "allow", protocol: "tcp", localPorts: "", remotePorts: "", localAddresses: "", remoteAddresses: "",
  programPath: "", profiles: ["domain", "private", "public"], enabled: true };

const isAny = (s: string | undefined | null) => !s || s.trim() === "" || s.trim().toLowerCase() === "any" || s.trim() === "*";

/** "80, 443, 1000-2000" to port ranges; null when the text is not plain ports. */
export function parsePorts(text: string): { from: number; to: number }[] | null {
  if (isAny(text)) return [];
  const out: { from: number; to: number }[] = [];
  for (const part of text.split(",").map(p => p.trim()).filter(Boolean)) {
    const [a, b, extra] = part.split("-").map(x => x.trim());
    const from = Number(a), to = b === undefined ? from : Number(b);
    if (extra !== undefined || !a || !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > 65535 || from > to || String(from) !== a || (b !== undefined && String(to) !== b)) return null;
    out.push({ from, to });
  }
  return out;
}

const MASKS = new Map(Array.from({ length: 33 }, (_, n) => {
  const m = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
  return [[m >>> 24, (m >>> 16) & 255, (m >>> 8) & 255, m & 255].join("."), n] as const;
}));

/** Windows reports addresses as "10.0.0.1, 10.0.0.0/255.255.255.0"; the form uses prefixes. Null for anything else (ranges, keywords). */
export function parseAddresses(text: string | undefined | null): string[] | null {
  if (isAny(text)) return [];
  const out: string[] = [];
  for (const part of text!.split(",").map(p => p.trim()).filter(Boolean)) {
    const [address, mask, extra] = part.split("/");
    if (extra !== undefined || !address || !isIpv4(address)) return null;
    if (mask === undefined || mask === "255.255.255.255" || mask === "32") { out.push(address); continue; }
    const prefix = /^\d+$/.test(mask) ? Number(mask) : MASKS.get(mask);
    if (prefix === undefined || prefix < 0 || prefix > 32) return null;
    out.push(`${address}/${prefix}`);
  }
  return out;
}

const isIpv4 = (s: string) => { const p = s.split("."); return p.length === 4 && p.every(x => /^\d{1,3}$/.test(x) && Number(x) <= 255 && String(Number(x)) === x); };

/** A reported rule as form values; null when it uses something the platform does not write (it can still be enabled, disabled or deleted). */
export function ruleToForm(r: ReportedFirewallRule): RuleForm | null {
  const protocol = (r.protocol ?? "any").toLowerCase();
  const proto = protocol === "6" ? "tcp" : protocol === "17" ? "udp" : protocol === "1" ? "icmpv4" : protocol;
  if (!(PROTOCOLS as readonly string[]).includes(proto)) return null;
  const lp = parsePorts(r.localPorts ?? ""), rp = parsePorts(r.remotePorts ?? "");
  const la = parseAddresses(r.localAddresses), ra = parseAddresses(r.remoteAddresses);
  if (!lp || !rp || !la || !ra) return null;
  const ports = (x: { from: number; to: number }[]) => x.map(p => p.from === p.to ? String(p.from) : `${p.from}-${p.to}`).join(", ");
  return { name: r.name, direction: r.direction, action: r.action, protocol: proto as RuleForm["protocol"], localPorts: ports(lp), remotePorts: ports(rp),
    localAddresses: la.join(", "), remoteAddresses: ra.join(", "), programPath: r.programPath ?? "", profiles: r.profiles?.length ? [...r.profiles] : ["domain", "private", "public"], enabled: r.enabled };
}

/** Form values to the contract's structured rule; a list of problems when something is not right. */
export function formToRule(f: RuleForm): FirewallRule | string[] {
  const problems: string[] = [];
  const lp = parsePorts(f.localPorts), rp = parsePorts(f.remotePorts);
  if (!lp) problems.push("Local ports must be numbers or ranges like 80, 443, 1000-2000.");
  if (!rp) problems.push("Remote ports must be numbers or ranges like 80, 443, 1000-2000.");
  if ((lp?.length || rp?.length) && f.protocol !== "tcp" && f.protocol !== "udp") problems.push("Ports need the TCP or UDP protocol.");
  const addresses = (s: string) => s.split(",").map(x => x.trim()).filter(x => x && !isAny(x));
  for (const a of [...addresses(f.localAddresses), ...addresses(f.remoteAddresses)]) {
    const [ip, prefix, extra] = a.split("/");
    if (extra !== undefined || !ip || !isIpv4(ip) || (prefix !== undefined && !(/^\d{1,2}$/.test(prefix) && Number(prefix) <= 32))) problems.push(`${a} is not an IPv4 address or network like 10.0.0.0/24.`);
  }
  if (f.profiles.length === 0) problems.push("Choose at least one profile.");
  if (problems.length) return problems;
  const rule: FirewallRule = { name: f.name.trim(), direction: f.direction, action: f.action, protocol: f.protocol, profiles: f.profiles as FirewallRule["profiles"], enabled: f.enabled };
  if (lp!.length) rule.localPorts = lp!;
  if (rp!.length) rule.remotePorts = rp!;
  if (addresses(f.localAddresses).length) rule.localAddresses = addresses(f.localAddresses);
  if (addresses(f.remoteAddresses).length) rule.remoteAddresses = addresses(f.remoteAddresses);
  if (f.programPath.trim()) rule.programPath = f.programPath.trim();
  return rule;
}

const describeRule = (r: FirewallRule | RuleForm) => {
  const ports = (label: string, v: unknown) => v && (Array.isArray(v) ? v.length : String(v).trim()) ? ` · ${label} ${Array.isArray(v) ? v.map((p: { from: number; to: number }) => p.from === p.to ? p.from : `${p.from}-${p.to}`).join(", ") : v}` : "";
  return `${r.direction === "in" ? "Inbound" : "Outbound"} · ${r.action} · ${r.protocol}${ports("local ports", r.localPorts)}${ports("remote ports", r.remotePorts)}`
    + `${ports("local addresses", r.localAddresses)}${ports("remote addresses", r.remoteAddresses)}${r.programPath ? ` · program ${r.programPath}` : ""}`
    + ` · profiles ${r.profiles.join(", ")} · ${r.enabled ? "enabled" : "disabled"}`;
};

export function RuleEditor({ cabinet, initial, mode, onCancel, onSubmit }: {
  cabinet: CabinetDetail; initial: RuleForm; mode: "create" | "update"; onCancel: () => void; onSubmit: (rule: FirewallRule) => void;
}) {
  const [f, setF] = useState<RuleForm>(initial);
  const [problems, setProblems] = useState<string[]>([]);
  const set = <K extends keyof RuleForm>(k: K, v: RuleForm[K]) => setF(x => ({ ...x, [k]: v }));
  return (
    <form className="form panel" aria-label={mode === "create" ? `New firewall rule on ${cabinet.name}` : `Edit rule ${initial.name}`}
      onSubmit={e => { e.preventDefault(); const r = formToRule(f); if (Array.isArray(r)) setProblems(r); else { setProblems([]); onSubmit(r); } }}>
      <h3>{mode === "create" ? "New firewall rule" : `Edit ${initial.name}`}</h3>
      <label className="field"><span>Name {mode === "create" && <span className="muted small">(rules the platform creates start with MashuraDiag)</span>}</span>
        <input required maxLength={128} readOnly={mode === "update"} value={f.name} onChange={e => set("name", e.target.value)} /></label>
      <div className="row gap wrap">
        <label className="field inline"><span>Direction</span><select value={f.direction} onChange={e => set("direction", e.target.value as RuleForm["direction"])}><option value="in">Inbound</option><option value="out">Outbound</option></select></label>
        <label className="field inline"><span>Action</span><select value={f.action} onChange={e => set("action", e.target.value as RuleForm["action"])}><option value="allow">Allow</option><option value="block">Block</option></select></label>
        <label className="field inline"><span>Protocol</span><select value={f.protocol} onChange={e => set("protocol", e.target.value as RuleForm["protocol"])}>{PROTOCOLS.map(p => <option key={p} value={p}>{p === "any" ? "Any" : p.toUpperCase()}</option>)}</select></label>
      </div>
      <div className="row gap wrap">
        <label className="field inline"><span>Local ports</span><input placeholder="Any" value={f.localPorts} onChange={e => set("localPorts", e.target.value)} /></label>
        <label className="field inline"><span>Remote ports</span><input placeholder="Any" value={f.remotePorts} onChange={e => set("remotePorts", e.target.value)} /></label>
      </div>
      <div className="row gap wrap">
        <label className="field inline"><span>Local addresses</span><input placeholder="Any" value={f.localAddresses} onChange={e => set("localAddresses", e.target.value)} /></label>
        <label className="field inline"><span>Remote addresses</span><input placeholder="Any" value={f.remoteAddresses} onChange={e => set("remoteAddresses", e.target.value)} /></label>
      </div>
      <label className="field"><span>Program (full path to an .exe, or empty for any program)</span><input value={f.programPath} onChange={e => set("programPath", e.target.value)} /></label>
      <fieldset><legend>Profiles</legend>
        {(["domain", "private", "public"] as const).map(p => <label key={p} className="check"><input type="checkbox" checked={f.profiles.includes(p)}
          onChange={e => set("profiles", e.target.checked ? [...f.profiles, p] : f.profiles.filter(x => x !== p))} /> {PROFILE_NAME[p]}</label>)}
      </fieldset>
      <label className="check"><input type="checkbox" checked={f.enabled} onChange={e => set("enabled", e.target.checked)} /> Enabled</label>
      {problems.length > 0 && <ul className="error" role="alert">{problems.map(p => <li key={p}>{p}</li>)}</ul>}
      <div className="row gap"><button type="button" className="btn" onClick={onCancel}>Cancel</button><button type="submit" className="btn primary">Review</button></div>
    </form>
  );
}

/** Add a rule, and the per-rule actions; one setRule write behind them. */
export function useRuleWrites(cabinet: CabinetDetail, onChanged: () => void) {
  const w = useConfirmedWrite<FirewallSetRuleOutput>(cabinet, "firewall.setRule", r => { if (r.status === "succeeded") onChanged(); });
  const [editing, setEditing] = useState<null | { mode: "create" | "update"; initial: RuleForm }>(null);
  const note = <p className="muted small">{SAFETY_NET_NOTE}</p>;
  const submit = (rule: FirewallRule) => {
    const mode = editing!.mode;
    w.ask(mode === "create" ? { change: "create", rule } : { change: "update", ruleName: editing!.initial.name, rule },
      <><p>{mode === "create" ? "Create" : "Change"} firewall rule <strong>{rule.name}</strong>:</p>
        {mode === "update" && <p className="muted">Now: {describeRule(editing!.initial)}</p>}
        <p><strong>{mode === "update" ? "After: " : ""}{describeRule(rule)}</strong></p>{note}</>);
    setEditing(null);
  };
  const simple = (change: "enable" | "disable" | "delete", r: ReportedFirewallRule) => w.ask({ change, ruleName: r.name }, <>
    <p>{change === "delete" ? "Delete" : change === "enable" ? "Enable" : "Disable"} firewall rule <strong>{r.name}</strong>.</p>
    {change === "delete" && <p className="notice warn">A snapshot is taken first, so the rule can be put back with Restore.</p>}{note}</>);
  return {
    editor: editing && <RuleEditor cabinet={cabinet} initial={editing.initial} mode={editing.mode} onCancel={() => setEditing(null)} onSubmit={submit} />,
    add: () => setEditing({ mode: "create", initial: EMPTY_RULE }),
    actions: (r: ReportedFirewallRule) => {
      const form = ruleToForm(r);
      return (
        <span className="row gap rule-actions">
          <button className="btn small" onClick={() => simple(r.enabled ? "disable" : "enable", r)}>{r.enabled ? "Disable" : "Enable"}</button>
          <button className="btn small" disabled={!form} title={form ? undefined : "This rule uses settings the platform does not write; it can be enabled, disabled or deleted"}
            onClick={() => form && setEditing({ mode: "update", initial: form })}>Edit</button>
          <button className="btn small danger" onClick={() => simple("delete", r)}>Delete</button>
        </span>);
    },
    outcome: <WriteOutcome run={w.run} done={o => <>Rule {o.change === "delete" ? `${o.before?.name} deleted` : `${o.after?.name} ${o.change === "create" ? "created" : o.change === "update" ? "changed" : o.change + "d"}`}. Snapshot {o.snapshotId.slice(0, 8)} was taken first.</>} />,
    dialog: w.dialog,
  };
}

// ---- Snapshots and history ----------------------------------------------------------------

export function Snapshots({ cabinet, state, onChanged }: { cabinet: CabinetDetail; state: FirewallStateOutput; onChanged: () => void }) {
  const allowed = useCanWrite(cabinet, "firewall.restore");
  const w = useConfirmedWrite<FirewallRestoreOutput>(cabinet, "firewall.restore", r => { if (r.status === "succeeded") onChanged(); });
  return (
    <section className="panel" aria-labelledby="snapshots-heading">
      <h3 id="snapshots-heading">Saved snapshots</h3>
      {state.snapshots.length === 0 ? <Empty>No snapshots yet.</Empty> : (
        <ul className="plain">{state.snapshots.map(s => (
          <li key={s.snapshotId} className="row gap">
            <span>{fullTime(s.takenAt)} <span className="muted small">{s.commandId ? "before a platform change" : "taken by the cabinet"}</span></span>
            {allowed && <button className="btn small" onClick={() => w.ask({ snapshotId: s.snapshotId }, <>
              <p>Put back the whole firewall as it was at <strong>{fullTime(s.takenAt)}</strong>: every profile and every rule.</p>
              <p className="notice warn">Changes made since then are undone. The current firewall is saved first, so this can be undone too.</p>
              <p className="muted small">{SAFETY_NET_NOTE}</p></>)}>Restore</button>}
          </li>))}
        </ul>)}
      <WriteOutcome run={w.run} done={o => <>Restored the snapshot from {fullTime(state.snapshots.find(s => s.snapshotId === o.restoredSnapshotId)?.takenAt ?? o.restoredAt)}. The firewall before the restore was saved too.</>} />
      {w.dialog}
    </section>
  );
}

interface HistoryRow { id: string; commandId: string | null; explained: boolean; operation: string | null; before: unknown; after: unknown; detail: { message?: string } | null;
  occurredAt: string; by: string | null }

const summarize = (v: unknown): string => {
  if (!v || typeof v !== "object") return "—";
  const o = v as Record<string, unknown>;
  if ("profile" in o) return `${String(o.profile)}: ${o.enabled ? "on" : "off"}, inbound ${String(o.defaultInbound)}, outbound ${String(o.defaultOutbound)}`;
  if ("name" in o) return `${String(o.name)} (${o.enabled ? "enabled" : "disabled"}, ${o.direction === "in" ? "inbound" : "outbound"} ${String(o.action)})`;
  return JSON.stringify(o).slice(0, 160);
};

export function FirewallHistory({ cabinet, version }: { cabinet: CabinetDetail; version: number }) {
  const { data, problem, reload } = useLoad<HistoryRow[]>(`/api/cabinets/${cabinet.id}/firewall-history`);
  useEffect(() => { if (version > 0) reload(); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="panel" aria-labelledby="fw-history-heading">
      <div className="panel-head"><h3 id="fw-history-heading">Firewall history</h3><button className="btn" onClick={reload}>Refresh</button></div>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && data.length === 0 && <Empty>No firewall changes recorded yet.</Empty>}
      {data && data.length > 0 && (
        <ul className="history" aria-label="Firewall changes, newest first">{data.map(h => (
          <li key={h.id}>
            <div>{fullTime(h.occurredAt)} {h.explained ? <Badge tone="info">Through the platform</Badge> : <Badge tone="warn">Outside change</Badge>}
              {h.explained && <> by <strong>{h.by ?? "unknown"}</strong> ({h.operation ?? "write"})</>}</div>
            {(h.before !== null || h.after !== null)
              ? <div className="small">Before: {summarize(h.before)} → After: {summarize(h.after)}</div>
              : h.detail?.message && <div className="small">{h.detail.message}</div>}
          </li>))}
        </ul>)}
    </section>
  );
}

// ---- Drivers ------------------------------------------------------------------------------

/** Third-party drivers have published names like oem12.inf; only those can be removed. */
export const isThirdParty = (publishedName: string) => {
  const n = publishedName.toLowerCase();
  return n.startsWith("oem") && n.endsWith(".inf") && n.length > 7 && [...n.slice(3, -4)].every(c => c >= "0" && c <= "9");
};

export function useDriverUninstall(cabinet: CabinetDetail, onChanged: () => void) {
  const allowed = useCanWrite(cabinet, "driver.uninstall");
  const w = useConfirmedWrite<DriverUninstallOutput>(cabinet, "driver.uninstall", r => { if (r.status === "succeeded") onChanged(); });
  return {
    allowed,
    button: (d: { publishedName: string; originalName?: string | null; provider?: string | null; version?: string | null }) => allowed && isThirdParty(d.publishedName)
      ? <button className="btn small danger" onClick={() => w.ask({ publishedName: d.publishedName }, <>
          <p>Uninstall driver <strong>{d.publishedName}</strong>{d.originalName ? <> ({d.originalName}{d.provider ? `, ${d.provider}` : ""}{d.version ? ` ${d.version}` : ""})</> : null}.</p>
          <p className="notice warn">Devices using it stop working until another driver is installed. The cabinet may need a restart.</p></>)}>Uninstall</button>
      : null,
    outcome: <WriteOutcome run={w.run} done={o => <>{o.publishedName} was removed.{o.rebootRequired && " The cabinet needs a restart to finish."}</>} />,
    dialog: w.dialog,
  };
}

// ---- Windows update rollback ----------------------------------------------------------------

/** Rolls back one installed update by KB number (wusa /uninstall). The cabinet is never restarted; if Windows needs one, the result says so. */
export function useUpdateRollback(cabinet: CabinetDetail, onChanged: () => void) {
  const allowed = useCanWrite(cabinet, "updates.uninstall");
  const w = useConfirmedWrite<UpdatesUninstallOutput>(cabinet, "updates.uninstall", r => { if (r.status === "succeeded") onChanged(); });
  return {
    allowed,
    button: (u: { kb: string | null; title: string }) => allowed && u.kb && /^KB[0-9]{6,8}$/.test(u.kb)
      ? <button className="btn small danger" onClick={() => w.ask({ kb: u.kb }, <>
          <p>Roll back <strong>{u.kb}</strong>: {u.title}.</p>
          <p className="notice warn">The update is removed with Windows' own uninstaller. The cabinet is not restarted; if Windows needs a restart to finish, it is reported and waits.</p></>)}>Roll back</button>
      : null,
    outcome: <WriteOutcome run={w.run} done={o => <>{o.kb} was rolled back.{o.rebootRequired && " Windows needs a restart to finish; the cabinet has not been restarted."}</>} />,
    dialog: w.dialog,
  };
}

// ---- DNS cache ------------------------------------------------------------------------------

/** Empties the Windows DNS resolver cache (ipconfig /flushdns). Changes no setting. */
export function useFlushDns(cabinet: CabinetDetail) {
  const allowed = useCanWrite(cabinet, "network.flushDns");
  const w = useConfirmedWrite<NetworkFlushDnsOutput>(cabinet, "network.flushDns");
  return {
    allowed,
    button: allowed ? <button className="btn small" onClick={() => w.ask({}, <p>Empty the DNS resolver cache on <strong>{cabinet.name}</strong>. No setting changes; names are looked up again on next use.</p>)}>Flush DNS cache</button> : null,
    outcome: <WriteOutcome run={w.run} done={o => <>{o.flushed ? "The DNS cache was emptied." : "Windows did not report success."}</>} />,
    dialog: w.dialog,
  };
}
