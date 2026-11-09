// The text the fleet's readings search looks in, for each reading it can search by name (F21.R4, decision-log D63): the same fields the
// search matches on (readings.ts, NAMES), lower case, one value per line. It is stored with the result when the result arrives
// (commands.ts), so a search reads a short text per cabinet and opens the stored JSON only for the cabinets that can match.
type Out = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const list = (v: unknown): Out[] => Array.isArray(v) ? v.filter((x): x is Out => typeof x === "object" && x !== null) : [];
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** For each reading searched by name, the values the search matches: exactly the fields readings.ts NAMES compares. */
const FIELDS: Readonly<Record<string, (o: Out) => unknown[]>> = {
  "software.list": o => [...list(o.programs).flatMap(p => [p.name, p.publisher]), ...list(o.hotfixes).map(h => h.id)],
  "startup.list": o => [...list(o.startup).flatMap(s => [s.name, s.command]), ...list(o.tasks).flatMap(t => [t.name, t.path])],
  "shares.list": o => list(o.shares).flatMap(s => [s.name, s.path]),
  "sessions.list": o => list(o.sessions).map(s => s.user),
  "system.hardware": o => [o.model, o.manufacturer, o.bios?.version, o.bios?.vendor, o.cpu?.model],
  "system.identity": o => [o.name, ...strings(o.localAdministrators?.names)],
  "network.hosts": o => list(o.entries).flatMap(e => [e.address, ...strings(e.names)]),
  "dns.cache": o => list(o.entries).flatMap(e => [e.name, e.data]),
};

/**
 * The search text of one reading's output, or null for a reading the search does not cover by name. A value never holds a line break
 * once stored (each is cut at one), and a search's text holds no control character (its contract), so a match never spans two values.
 */
export function searchText(operation: string, output: unknown): string | null {
  const fields = FIELDS[operation];
  if (!fields || typeof output !== "object" || output === null) return null;
  return fields(output as Out).filter((v): v is string => typeof v === "string" && v !== "")
    .map(v => v.replace(/[\r\n]+/g, " ").toLowerCase()).join("\n");
}

export const SEARCHED_BY_NAME: readonly string[] = Object.keys(FIELDS);
