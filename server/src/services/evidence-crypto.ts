// Passphrase-encrypted evidence exports (docs/platform/encryption.md). The file is: the 8 bytes "CABEV001", a 16-byte random salt, a 12-byte
// random nonce, the AES-256-GCM ciphertext and its 16-byte tag. The key is scrypt(passphrase, salt). The header is the associated data, so
// a changed header fails to open. The passphrase is used once and never stored or logged. Node's own crypto only: no dependency.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const MAGIC = Buffer.from("CABEV001", "ascii");
const SALT = 16, NONCE = 12, TAG = 16;
const KEY = (passphrase: string, salt: Buffer): Buffer => scryptSync(passphrase.normalize("NFKC"), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

export function encryptEvidence(plain: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(SALT), nonce = randomBytes(NONCE);
  const c = createCipheriv("aes-256-gcm", KEY(passphrase, salt), nonce);
  const header = Buffer.concat([MAGIC, salt, nonce]);
  c.setAAD(header);
  return Buffer.concat([header, c.update(plain), c.final(), c.getAuthTag()]);
}

/** Opens a file made by encryptEvidence; throws on a wrong passphrase, a changed byte or a file of another kind. */
export function decryptEvidence(file: Buffer, passphrase: string): Buffer {
  if (file.length < MAGIC.length + SALT + NONCE + TAG || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not an encrypted evidence package");
  const header = file.subarray(0, MAGIC.length + SALT + NONCE);
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT), nonce = header.subarray(MAGIC.length + SALT);
  const d = createDecipheriv("aes-256-gcm", KEY(passphrase, salt), nonce);
  d.setAAD(header);
  d.setAuthTag(file.subarray(file.length - TAG));
  return Buffer.concat([d.update(file.subarray(header.length, file.length - TAG)), d.final()]);
}
