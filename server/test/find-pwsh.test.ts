import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { findPwsh } from "./find-pwsh.js";

const fakePwsh = () => { const dir = join(mkdtempSync(join(tmpdir(), "pwsh-home-")), ".dotnet", "tools"); mkdirSync(dir, { recursive: true });
  const p = join(dir, "pwsh"); writeFileSync(p, ""); chmodSync(p, 0o755); return { dir, p }; };

test("a pwsh on PATH outside the fixed install folders is found, by full path", () => {
  const { dir, p } = fakePwsh();
  assert.equal(findPwsh({ PATH: ["/nonexistent-a", dir].join(delimiter) }), p);
});

test("PWSH wins when it names a file by full path", () => {
  const { p } = fakePwsh(), other = fakePwsh();
  assert.equal(findPwsh({ PWSH: p, PATH: other.dir }), p);
});

test("hostile or useless settings never yield a relative path or a folder", () => {
  const { dir } = fakePwsh();
  // Every relative candidate "exists" here; none may be returned, and nothing absolute exists.
  const relativeOnly = (p: string) => !p.startsWith("/");
  for (const env of [{ PWSH: "pwsh", PATH: "" }, { PWSH: "../pwsh" }, { PATH: `.${delimiter}bin${delimiter}` }, {}])
    assert.equal(findPwsh(env, relativeOnly), undefined, JSON.stringify(env));
  // A folder named by PWSH is not a program.
  assert.notEqual(findPwsh({ PWSH: dir, PATH: "" }), dir);
});
