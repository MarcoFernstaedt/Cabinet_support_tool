import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const root = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const templates = readdirSync(join(root, "deploy/env")).filter(n => n.endsWith(".env.example")).map(n => "deploy/env/" + n);
test("every environment template is tracked", () => {
  assert.ok(templates.length >= 2);
  const tracked = new Set(execFileSync("git", ["ls-files", "--", "deploy/env"], { cwd: root, encoding: "utf8" }).trim().split("\n"));
  for (const file of templates) assert.ok(tracked.has(file), file + " must be tracked");
});
test("templates contain no plausible live secrets", () => {
  for (const file of templates) for (const line of read(file).split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (!match || !/password|secret|key|token/i.test(match[1]!)) continue;
    const value = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
    assert.doesNotMatch(value, /[A-Za-z0-9+/=_-]{24,}/, file + ": " + match[1]);
  }
});
test("templates cover Compose and setup inputs", () => {
  const names = new Set(templates.flatMap(f => [...read(f).matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(m => m[1]!)));
  const required = [...read("deploy/compose.yaml").matchAll(/(?<!\$)\$\{([A-Z][A-Z0-9_]*)/g)].map(m => m[1]!);
  required.push("PUBLIC_IP", "CONSOLE_DOMAIN", "ADMIN_USERNAME", "ADMIN_NAME");
  for (const name of required) assert.ok(names.has(name), "missing variable " + name);
});
test("repository ignore rules protect real env files and allow examples", () => {
  const rules = read(".gitignore").split("\n").map(s => s.trim());
  for (const rule of ["deploy/env/*.env", "deploy/**/*.env", "!deploy/**/*.env.example"]) assert.ok(rules.includes(rule), "missing rule " + rule);
});
