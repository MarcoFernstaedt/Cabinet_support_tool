// RFC 6238 time-based one-time passwords (30-second steps, 6 digits, HMAC-SHA1:
// what every authenticator app supports), and RFC 4648 base32 for the secret.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;

export function base32(bytes: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export const newSecret = (): Buffer => randomBytes(20);

export function code(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const n = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(n % 1_000_000).padStart(6, "0");
}

export const stepAt = (ms: number): number => Math.floor(ms / 1000 / STEP_SECONDS);

/**
 * Checks a code against the current step and one step either side (clock
 * drift). Returns the matched step, or null. A step at or before lastUsedStep
 * is refused, so a code cannot be used twice.
 */
export function verify(secret: Buffer, submitted: string, nowMs: number, lastUsedStep: number | null): number | null {
  if (!/^[0-9]{6}$/.test(submitted)) return null;
  const current = stepAt(nowMs);
  for (const step of [current - 1, current, current + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (timingSafeEqual(Buffer.from(code(secret, step)), Buffer.from(submitted))) return step;
  }
  return null;
}

export function otpauthUri(secret: Buffer, username: string, issuer = "Mashura Cabinet Platform"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?secret=${base32(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
