// Authenticator secrets are stored encrypted (AES-256-GCM). The key comes from
// the environment or a secret store, never the repository or the database.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class SecretBox {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, "base64");
    if (key.length !== 32) throw new Error("CONSOLE_SECRET_KEY must be 32 random bytes, base64-encoded.");
    this.key = key;
  }

  seal(plain: Buffer): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]); // version 1
  }

  open(sealed: Buffer): Buffer {
    if (sealed.length < 29 || sealed[0] !== 1) throw new Error("unreadable sealed secret");
    const decipher = createDecipheriv("aes-256-gcm", this.key, sealed.subarray(1, 13));
    decipher.setAuthTag(sealed.subarray(13, 29));
    return Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]);
  }
}
