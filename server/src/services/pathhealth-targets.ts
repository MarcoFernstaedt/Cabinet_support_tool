// Which destinations the platform is allowed to sample, and the re-validation of anything that had to be resolved
// (docs/spec/18-built-designs.md §3).
//
// Two rules hold this file together:
//   1. A target is built by the server from settings only. There is no parameter here that names a host or a port, so neither the
//      console nor a cabinet can add a destination, and a sync target is accepted only as a private IPv4 address (RFC 1918). A
//      configured name is not a target: it would have to be resolved, and the platform does not aim ICMP or TCP at whatever a name
//      happens to resolve to.
//   2. If a name ever does have to be resolved (the platform endpoint configured as a name, or a site setting left as a name), the
//      resolved destination is checked again against what was approved before anything connects to it. A stale or hostile DNS or
//      hosts-file answer therefore cannot redirect a bounded test to another machine, which is the second half of the audit's
//      finding 8 ("restrict sync fallback to validated local private IPv4 and revalidate resolved destination before connection").
import type { PathHealthTarget, PathHealthTargetKind } from "./pathhealth-contracts.js";
import { MAX_TARGETS } from "./pathhealth-contracts.js";

/** The site's sync cabinet as the settings services report it (device-settings.ts SyncLevels, structural so this file needs no database). */
export interface PathHealthSyncSettings {
  address: string | null;
  /** The ports that apply: the site's own, else its client's, else the fleet default. */
  effective: number[];
}

/** Where the platform itself is reached. `address` must already be an IPv4 literal: the caller resolves a configured name once, at start-up. */
export interface PathHealthPlatformEndpoint {
  address: string;
  port: number;
}

export interface PathHealthSkippedTarget {
  kind: PathHealthTargetKind;
  /** A stable wording, not a submitted value. */
  reason: string;
}

export interface PathHealthSelection {
  targets: PathHealthTarget[];
  /** What was left out and why, so a report can say "no sync target" instead of silently measuring less. */
  skipped: PathHealthSkippedTarget[];
}

/** Four sync ports plus the platform endpoint is the whole surface (the same limit the site sync settings and the agent's validator use). */
export const SYNC_PORTS_MAX = 4;
/** Requests per minute the cabinet is allowed to make per target, for the durable budget the agent keeps. */
export const SAMPLES_PER_TARGET_MAX = 4;

interface ParsedIpv4 { a: number; b: number; c: number; d: number }

/** Parses dotted-quad IPv4 only: no leading zeros, no shorthand, no IPv6 (a sync cabinet is a same-site IPv4 host). */
function parseIpv4(value: string): ParsedIpv4 | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (part.length === 0 || part.length > 3 || (part.length > 1 && part[0] === "0")) return null;
    for (const ch of part) if (ch < "0" || ch > "9") return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return { a: out[0]!, b: out[1]!, c: out[2]!, d: out[3]! };
}

export function isIpv4(value: unknown): value is string {
  return typeof value === "string" && parseIpv4(value) !== null;
}

/**
 * A private address RFC 1918 defines, which is what the agent's own check accepts for a server-supplied sync address.
 * 169.254 (APIPA), loopback, CGNAT and multicast are not private here: none of them can be a working sync cabinet.
 */
export function isPrivateIpv4(value: string): boolean {
  const ip = parseIpv4(value);
  if (!ip) return false;
  return ip.a === 10 || (ip.a === 172 && ip.b >= 16 && ip.b <= 31) || (ip.a === 192 && ip.b === 168);
}

/** An address a test may be aimed at over the Internet: not loopback, not private, not link-local, not CGNAT, not documentation, not multicast or reserved. */
export function isGlobalIpv4(value: string): boolean {
  const ip = parseIpv4(value);
  if (!ip) return false;
  if (ip.a === 0 || ip.a === 10 || ip.a === 127 || ip.a >= 224) return false;
  if (ip.a === 100 && ip.b >= 64 && ip.b <= 127) return false;
  if (ip.a === 169 && ip.b === 254) return false;
  if (ip.a === 172 && ip.b >= 16 && ip.b <= 31) return false;
  if (ip.a === 192 && ip.b === 168) return false;
  if (ip.a === 192 && ip.b === 0 && (ip.c === 0 || ip.c === 2)) return false;
  if (ip.a === 198 && (ip.b === 18 || ip.b === 19)) return false;
  if (ip.a === 198 && ip.b === 51 && ip.c === 100) return false;
  if (ip.a === 203 && ip.b === 0 && ip.c === 113) return false;
  if (ip.a === 255 && ip.b === 255 && ip.c === 255 && ip.d === 255) return false;
  return true;
}

/** A usable service port; anything else is dropped rather than clamped. */
const usablePort = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null);

/**
 * The targets for one cabinet, from the settings the server already holds.
 * A sync cabinet is not given a sync target (it is the endpoint its satellites connect to); a site with no valid private address
 * and no valid ports simply gets fewer targets, and the reason is reported.
 */
export function selectTargets(input: { role: "sync" | "satellite" | "standalone"; sync: PathHealthSyncSettings | null; platform: PathHealthPlatformEndpoint }): PathHealthSelection {
  const targets: PathHealthTarget[] = [];
  const skipped: PathHealthSkippedTarget[] = [];

  if (isIpv4(input.platform.address)) {
    const port = usablePort(input.platform.port);
    if (port === null) skipped.push({ kind: "platform_server", reason: "the platform endpoint's port is not a service port" });
    else targets.push({ kind: "platform_server", address: input.platform.address, port });
  } else skipped.push({ kind: "platform_server", reason: "the platform endpoint is not an address: resolve it once at start-up, never per sample" });

  if (input.role === "sync") skipped.push({ kind: "sync_cabinet", reason: "this cabinet is the site's sync cabinet" });
  else if (!input.sync || input.sync.address === null) skipped.push({ kind: "sync_cabinet", reason: "no sync cabinet address is set for this site" });
  else if (!isIpv4(input.sync.address)) skipped.push({ kind: "sync_cabinet", reason: "the sync cabinet's address is not an IPv4 address" });
  else if (!isPrivateIpv4(input.sync.address)) skipped.push({ kind: "sync_cabinet", reason: "the sync cabinet's address is not a private address on the site's own network" });
  else {
    const ports: number[] = [];
    for (const candidate of input.sync.effective) {
      const port = usablePort(candidate);
      if (port !== null && !ports.includes(port)) ports.push(port);
      if (ports.length === SYNC_PORTS_MAX) break;
    }
    if (ports.length === 0) targets.push({ kind: "sync_cabinet", address: input.sync.address, port: null });
    else for (const port of ports) targets.push({ kind: "sync_cabinet", address: input.sync.address, port });
  }

  const unique = targets.filter((t, i) => targets.findIndex(o => o.kind === t.kind && o.address === t.address && o.port === t.port) === i).slice(0, MAX_TARGETS);
  if (unique.length < targets.length) skipped.push({ kind: "sync_cabinet", reason: `only the first ${MAX_TARGETS} targets are sampled` });
  return { targets: unique, skipped };
}

/** One port per target: the four site-configured sync ports and the platform port are the whole set. */
export function isConfiguredPort(selection: readonly PathHealthTarget[], address: string, port: number): boolean {
  return selection.some(t => t.address === address && t.port === port);
}

/**
 * Re-validates a resolved destination before it is used (audit finding 8): the answer a resolver gave is only accepted when it
 * matches what was approved. The first approved address is returned so the caller pins the rest of the series to it.
 */
export function validateResolvedDestination(target: PathHealthTarget, resolved: readonly unknown[]): { approved: string | null; addresses: string[]; reason: string | null } {
  const answers = resolved.filter(isIpv4);
  if (answers.length === 0) return { approved: null, addresses: [], reason: "the name resolved to no IPv4 address" };
  if (target.kind === "sync_cabinet") {
    // A sync endpoint is never reached through a name-derived address: only the exact approved private address is used.
    if (!isPrivateIpv4(target.address)) return { approved: null, addresses: [], reason: "the sync cabinet's approved address is not a private IPv4 address" };
    const match = answers.filter(a => a === target.address);
    return match.length > 0 ? { approved: target.address, addresses: match, reason: null }
      : { approved: null, addresses: [], reason: "the name resolved to an address that is not the approved sync cabinet address" };
  }
  const global = answers.filter(isGlobalIpv4);
  return global.length > 0 ? { approved: global[0]!, addresses: global, reason: null }
    : { approved: null, addresses: [], reason: "the name resolved only to private or non-routable addresses" };
}
