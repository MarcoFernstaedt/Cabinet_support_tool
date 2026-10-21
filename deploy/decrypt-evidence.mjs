// Opens an encrypted evidence package (.cabev) made by the console: node deploy/decrypt-evidence.mjs file.cabev > evidence.json
// The passphrase is read from the EVIDENCE_PASSPHRASE environment variable, or asked for on the terminal. Needs only Node.
import { createDecipheriv, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const file = process.argv[2];
if (!file) { console.error("usage: node deploy/decrypt-evidence.mjs file.cabev > evidence.json"); process.exit(2); }
const pass = process.env.EVIDENCE_PASSPHRASE ?? await new Promise(r => { const rl = createInterface({ input: process.stdin, output: process.stderr }); rl.question("Passphrase: ", a => { rl.close(); r(a); }); });
const f = readFileSync(file);
const MAGIC = Buffer.from("CABEV001", "ascii"), SALT = 16, NONCE = 12, TAG = 16;
if (f.length < MAGIC.length + SALT + NONCE + TAG || !f.subarray(0, MAGIC.length).equals(MAGIC)) { console.error("This is not an encrypted evidence package."); process.exit(1); }
const header = f.subarray(0, MAGIC.length + SALT + NONCE);
try {
  const d = createDecipheriv("aes-256-gcm", scryptSync(pass.normalize("NFKC"), header.subarray(MAGIC.length, MAGIC.length + SALT), 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }), header.subarray(MAGIC.length + SALT));
  d.setAAD(header); d.setAuthTag(f.subarray(f.length - TAG));
  process.stdout.write(Buffer.concat([d.update(f.subarray(header.length, f.length - TAG)), d.final()]));
} catch { console.error("Wrong passphrase, or the file was changed."); process.exit(1); }
