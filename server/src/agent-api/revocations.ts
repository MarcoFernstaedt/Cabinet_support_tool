// The agent API remembers, per TLS connection, which cabinet its certificate was accepted for (re-checked every minute). A revoked
// certificate must stop working at once, so every revocation moves this process's revocation epoch on, which empties that memory:
// revocations made in this process move it directly, and those made by another server process arrive through the notifications
// table (channel certificates_revoked, see CommandNotifier).

let epoch = 0;

/** A certificate or a cabinet was revoked somewhere: every remembered acceptance is checked against the database again. */
export function noteRevocation(): void { epoch++; }

export function revocationEpoch(): number { return epoch; }

export const REVOCATION_CHANNEL = "certificates_revoked";
