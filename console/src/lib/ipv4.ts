// A client-side shape check for a sync cabinet's address, so an obvious typo is caught before an authenticator code is asked for.
// The server and the contract decide; this only spares the person a refusal they could have seen first.

/** Four decimal parts of digits only (no sign, spaces or leading zeros), each 0-255, in a private range: 10.x, 172.16-31.x or 192.168.x. */
export function looksPrivate(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some(p => p === "" || p.length > 3 || ![...p].every(ch => ch >= "0" && ch <= "9") || String(Number(p)) !== p || Number(p) > 255)) return false;
  const [a, b] = parts.map(Number) as [number, number];
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}
