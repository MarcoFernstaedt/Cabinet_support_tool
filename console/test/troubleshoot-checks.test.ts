// Every step of every Troubleshoot playbook names a check that exists. A step naming a removed check took down every cabinet page when the
// module loaded (the SMART check, D152), so the names are compared here, from the source, without loading React.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const checks = readFileSync(join(src, "lib", "checks.ts"), "utf8");
const playbooks = readFileSync(join(src, "pages", "cabinet", "Troubleshoot.tsx"), "utf8");
const ids = (text: string, re: RegExp) => [...text.matchAll(re)].map(m => m[1]!);

test("each playbook step's check is one the checks list defines, and SMART is not among them", () => {
  const defined = new Set(ids(checks, /\{ id: "([a-z-]+)", label:/g));
  const used = ids(playbooks, /\{ check: "([a-z-]+)"/g);
  assert.ok(defined.size >= 10 && used.length >= 10, "both lists were read");
  for (const c of used) assert.ok(defined.has(c), `playbook step names a check that does not exist: ${c}`);
  assert.equal(defined.has("disk"), false, "no SMART check (D152)");
  assert.equal(/disk\.smart|storage\.health/.test(checks + playbooks), false);
});
