import { test } from "node:test";
import assert from "node:assert/strict";
import { decryptEvidence, encryptEvidence } from "../src/services/evidence-crypto.js";

const plain = Buffer.from(JSON.stringify({ hello: "world", n: [1, 2, 3] }), "utf8");

test("an encrypted evidence file opens with its passphrase and not with another", () => {
  const f = encryptEvidence(plain, "correct horse battery staple");
  assert.ok(!f.includes(Buffer.from("hello")), "no plaintext in the file");
  assert.deepEqual(decryptEvidence(f, "correct horse battery staple"), plain);
  assert.throws(() => decryptEvidence(f, "correct horse battery stapl3"));
  assert.notDeepEqual(encryptEvidence(plain, "correct horse battery staple"), f, "a fresh salt and nonce every time");
});

test("a changed or cut file, a changed header, or another kind of file is refused", () => {
  const pass = "correct horse battery staple";
  const f = encryptEvidence(plain, pass);
  for (const at of [0, 9, 25, 40, f.length - 1]) { const x = Buffer.from(f); x[at]! ^= 1; assert.throws(() => decryptEvidence(x, pass), `byte ${at}`); }
  assert.throws(() => decryptEvidence(f.subarray(0, f.length - 3), pass));
  assert.throws(() => decryptEvidence(Buffer.alloc(0), pass));
  assert.throws(() => decryptEvidence(Buffer.from("just some text that is long enough to pass the length check"), pass));
});
