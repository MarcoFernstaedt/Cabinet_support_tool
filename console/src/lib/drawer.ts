// The drawer check. A drawer reaches the cabinet over a spoofed Ethernet link from the monitor; Windows lists it as an adapter on an
// "Unidentified network" with a fixed address in the drawer network. Plain comparisons of two network readings and the firewall state:
// no pattern matching of text.
import type { AdapterReading } from "../components/NetworkReadings";

/** Every drawer link has an address in this network. Change it here if the drawers move. */
export const DRAWER_NETWORK = { address: "172.20.1.0", prefixLength: 24 };
/** The mask the cabinets' drawer adapters use: 255.255.255.255, a single-address link (the owner's answer, 2026-10-28). */
export const DRAWER_PREFIX = 32;

export interface FirewallProfileReading { profile: string; enabled: boolean }
export type Tone = "ok" | "warn" | "crit" | "info";
export interface DrawerLine { id: string; tone: Tone; label: string; text: string }
export interface DrawerAnalysis { adapter: AdapterReading | null; lines: DrawerLine[]; tone: Tone; summary: string; profilesOn: string[] }

const octets = (a: string): number[] | null => {
  const p = a.split(".");
  if (p.length !== 4) return null;
  const n = p.map(x => (x !== "" && x.length <= 3 && [...x].every(c => c >= "0" && c <= "9") ? Number(x) : NaN));
  return n.every(x => x >= 0 && x <= 255) ? n : null;
};
const toInt = (o: number[]) => ((o[0]! * 2 ** 24) + (o[1]! << 16) + (o[2]! << 8) + o[3]!) >>> 0;

export function inDrawerNetwork(address: string, net = DRAWER_NETWORK): boolean {
  const a = octets(address), n = octets(net.address);
  if (!a || !n) return false;
  const bits = net.prefixLength;
  if (bits === 0) return true;
  const mask = bits >= 32 ? 0xffffffff : (~((2 ** (32 - bits)) - 1)) >>> 0;
  return ((toInt(a) & mask) >>> 0) === ((toInt(n) & mask) >>> 0);
}

const isApipa = (a: string) => a.startsWith("169.254.");
const unidentified = (a: AdapterReading) => (a.details?.networkProfile?.name ?? "").trim().toLowerCase() === "unidentified network";

/** The adapter that is the drawer link: one with an address in the drawer network, else an Ethernet adapter on an unidentified network. */
export function findDrawerAdapter(adapters: AdapterReading[]): AdapterReading | null {
  const eth = adapters.filter(a => a.type !== "wifi");
  return eth.find(a => a.ipv4.addresses.some(x => inDrawerNetwork(x.address))) ?? eth.find(unidentified) ?? null;
}

const mbit = (bps: number) => `${(bps / 1e6).toLocaleString("en-US")} Mbps`;
const n = (v: number) => v.toLocaleString("en-US");

/**
 * `first` and `second` are two network readings a few seconds apart (`seconds` between them). `profiles` is the firewall state; null when it could
 * not be read.
 */
export function analyseDrawer(first: AdapterReading[], second: AdapterReading[] | null, seconds: number, profiles: FirewallProfileReading[] | null): DrawerAnalysis {
  const found = findDrawerAdapter(first);
  const lines: DrawerLine[] = [];
  const add = (id: string, tone: Tone, label: string, text: string) => lines.push({ id, tone, label, text });
  const net = `${DRAWER_NETWORK.address}/${DRAWER_NETWORK.prefixLength}`;
  if (!found) {
    add("adapter", "crit", "Drawer adapter", `No adapter is on an unidentified network or has an address in ${net}. Seen: ${first.map(a => a.name).join(", ") || "no adapters"}.`);
    add("hint", "info", "Next", "Check the Ethernet cable between the monitor and the drawer, then the adapter's status under Devices and drivers. A drawer adapter that is missing here is not enumerated by Windows.");
    return { adapter: null, lines, tone: "crit", summary: "The drawer link does not appear as an adapter.", profilesOn: [] };
  }
  const a = found;
  add("adapter", "ok", "Drawer adapter", `${a.name}${a.description ? ` (${a.description})` : ""} on ${a.details?.networkProfile?.name ?? "an unnamed network"}.`);

  const admin = a.details?.adminStatus;
  if (admin && admin !== "up") add("status", "crit", "Status", `The adapter is disabled (admin ${admin}). Enable it under Network.`);
  else if (!a.connected) add("status", "crit", "Status", "Disconnected: no link. Check the cable and the monitor's drawer port.");
  else add("status", "ok", "Status", a.linkSpeedBps ? `Connected at ${mbit(a.linkSpeedBps)}.` : "Connected.");

  const v4 = a.ipv4.addresses;
  if (v4.length === 0) add("ip", "crit", "IPv4", "No IPv4 address.");
  else if (v4.every(x => isApipa(x.address))) add("ip", "crit", "IPv4", `Only ${v4.map(x => x.address).join(", ")}: Windows gave itself an address because nothing answered DHCP. The drawer address was not set.`);
  else {
    const mine = v4.find(x => inDrawerNetwork(x.address));
    if (!mine) add("ip", "crit", "IPv4", `${v4.map(x => `${x.address}/${x.prefixLength}`).join(", ")} is not in the drawer network ${net}.`);
    else if (mine.prefixLength !== DRAWER_PREFIX) add("ip", "warn", "IPv4", `${mine.address}/${mine.prefixLength}: drawer adapters use the mask 255.255.255.255 (/${DRAWER_PREFIX}).`);
    else add("ip", "ok", "IPv4", `${mine.address}/${mine.prefixLength}, inside ${net}, mask 255.255.255.255.`);
  }
  add("mode", a.ipv4.dhcp ? "warn" : "ok", "Addressing", a.ipv4.dhcp ? "DHCP. The drawer address is fixed; switch the adapter to a static address." : "Static.");
  add("gateway", a.ipv4.gateways.length ? "warn" : "ok", "Gateway", a.ipv4.gateways.length ? `${a.ipv4.gateways.join(", ")}. The drawer link has no router; a gateway here can pull traffic onto the wrong adapter.` : "None, as it should be.");

  // Packet information: counters now, and the change between the two readings.
  const s1 = a.details?.statistics ?? null;
  const b = second?.find(x => x.interfaceIndex === a.interfaceIndex) ?? null;
  const s2 = b?.details?.statistics ?? null;
  if (!s1) add("packets", "info", "Packets", "The cabinet did not report counters for this adapter.");
  else if (!s2 || seconds <= 0) add("packets", "info", "Packets", `${n(s1.bytesReceived)} bytes in, ${n(s1.bytesSent)} out; ${n(s1.receiveErrors)} receive and ${n(s1.sendErrors)} send errors, ${n(s1.receiveDiscards)} and ${n(s1.sendDiscards)} dropped (since boot).`);
  else {
    const din = s2.bytesReceived - s1.bytesReceived, dout = s2.bytesSent - s1.bytesSent;
    const derr = (s2.receiveErrors - s1.receiveErrors) + (s2.sendErrors - s1.sendErrors);
    const ddrop = (s2.receiveDiscards - s1.receiveDiscards) + (s2.sendDiscards - s1.sendDiscards);
    const text = `In ${seconds} s: ${n(Math.max(din, 0))} bytes in, ${n(Math.max(dout, 0))} out; ${n(Math.max(derr, 0))} errors, ${n(Math.max(ddrop, 0))} dropped. Since boot: ${n(s2.receiveErrors)} receive and ${n(s2.sendErrors)} send errors.`;
    if (din < 0 || dout < 0) add("packets", "info", "Packets", `The counters went backwards between readings (adapter reset). ${text}`);
    else if (derr > 0) add("packets", "crit", "Packets", `Errors are still increasing. ${text}`);
    else if (a.connected && din === 0 && dout === 0) add("packets", "warn", "Packets", `No traffic in either direction. ${text} The link is up but the drawer is not talking.`);
    else if (a.connected && dout > 0 && din === 0) add("packets", "warn", "Packets", `The cabinet sends but nothing comes back. ${text}`);
    else add("packets", ddrop > 0 ? "warn" : "ok", "Packets", text);
  }

  // Firewall: the drawer network is unidentified, so Windows treats it as Public unless set otherwise.
  const on = (profiles ?? []).filter(p => p.enabled).map(p => p.profile);
  if (profiles === null) add("firewall", "info", "Firewall", "The firewall state could not be read.");
  else if (on.length === 0) add("firewall", "ok", "Firewall", "Off on every profile.");
  else add("firewall", "crit", "Firewall", `On for ${on.join(", ")}. The drawer network is ${unidentified(a) ? "unidentified, which Windows treats as Public" : a.details?.networkProfile?.category ?? "unknown"}; the firewall must be off for the drawer to work.`);

  const order: Tone[] = ["ok", "info", "warn", "crit"];
  const tone = lines.reduce<Tone>((t, l) => (order.indexOf(l.tone) > order.indexOf(t) ? l.tone : t), "ok");
  const worst = lines.find(l => l.tone === "crit") ?? lines.find(l => l.tone === "warn");
  return { adapter: a, lines, tone, profilesOn: on, summary: worst ? `${worst.label}: ${worst.text}` : "The drawer link is connected, set correctly and passing traffic." };
}

/** Whether the drawer link's address, addressing or gateway is not as the drawer network needs it, so setting it by hand would help. */
export const needsDrawerAddress = (a: DrawerAnalysis): boolean =>
  a.adapter !== null && a.lines.some(l => (l.id === "ip" || l.id === "mode" || l.id === "gateway") && l.tone !== "ok");

/**
 * The network.setIp parameters that give the drawer link a fixed address in the drawer network with the drawer mask (/32) and no
 * gateway, or null when the last number is not 0 to 254 (with a /32 mask every one of them is a usable address).
 */
export function drawerAddressParams(interfaceIndex: number, lastNumber: string, net = DRAWER_NETWORK): { interfaceIndex: number; mode: "static"; address: string; prefixLength: number } | null {
  if (lastNumber === "" || lastNumber.length > 3 || ![...lastNumber].every(c => c >= "0" && c <= "9")) return null;
  const n = Number(lastNumber);
  if (n > 254) return null;
  const base = net.address.split(".").slice(0, 3).join(".");
  return { interfaceIndex, mode: "static", address: `${base}.${n}`, prefixLength: DRAWER_PREFIX };
}

/** The result as plain text for a ticket. */
export function drawerText(cabinet: string, a: DrawerAnalysis): string {
  return [`${cabinet}: drawer check`, ...a.lines.map(l => `${l.label.padEnd(15, ".")} [${l.tone === "ok" ? "OK" : l.tone === "crit" ? "PROBLEM" : l.tone === "warn" ? "CHECK" : "INFO"}] ${l.text}`)].join("\n");
}
