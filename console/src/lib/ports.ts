/**
 * The sync cabinet's TCP ports as typed ("1433, 1434"): up to 4 different ports between 1 and 65535, as the
 * server's schema requires. The server checks again; this only says what is wrong before anything is sent.
 */
export function parseSyncPorts(text: string): { ports: number[]; valid: boolean } {
  const ports = text.split(/[\s,]+/).filter(Boolean).map(Number);
  const valid = ports.length <= 4 && ports.every(p => Number.isInteger(p) && p >= 1 && p <= 65535) && new Set(ports).size === ports.length;
  return { ports, valid };
}

export const SYNC_PORTS_RULE = "Up to 4 different ports between 1 and 65535.";
