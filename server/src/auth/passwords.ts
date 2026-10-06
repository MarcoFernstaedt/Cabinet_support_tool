// Argon2id password hashing (docs/spec/02-security-model.md control 6), with OWASP's
// minimum parameters: 19 MiB memory, 2 iterations, 1 lane.
import { hash, verify, type Algorithm } from "@node-rs/argon2";

// Algorithm is a const enum the compiler cannot inline here; 2 is Argon2id.
const OPTIONS = { algorithm: 2 as Algorithm, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
export const MIN_PASSWORD_LENGTH = 12;

export const hashPassword = (password: string): Promise<string> => hash(password, OPTIONS);

/** A hash of a random password, verified against when the account does not exist, so timing does not reveal valid usernames. */
let dummy: Promise<string> | null = null;
export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  dummy ??= hashPassword("not-a-real-password-" + Math.random());
  try { return await verify(stored ?? (await dummy), password); }
  catch { return false; }
}
