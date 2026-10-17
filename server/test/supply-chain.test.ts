// The supply-chain controls that can be checked from the repository itself (docs/platform/supply-chain.md). They are checked here so a later change
// cannot quietly undo them: images stay pinned by digest, installs stay locked and script-free, workflows stay read-only and actions stay pinned.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const lines = (p: string) => read(p).split("\n");

test("every base image is pinned by digest as well as by tag", () => {
  for (const file of ["deploy/Dockerfile", "deploy/compose.yaml", ".github/workflows/platform-contracts.yml"]) {
    const images = lines(file).filter(l => /^\s*(ARG \w*IMAGE=|image: )/.test(l)).filter(l => !l.includes("cabinet-platform:local") && !l.includes("${"));
    assert.ok(images.length > 0 || file.endsWith("compose.yaml"), `${file} names no images`);
    for (const l of images) assert.match(l, /@sha256:[0-9a-f]{64}/, `${file}: ${l.trim()}`);
  }
});

test("the Dockerfile installs only from lock files and runs no install scripts", () => {
  for (const l of lines("deploy/Dockerfile").filter(l => !l.trim().startsWith("#") && /\bnpm (ci|install|i)\b/.test(l))) {
    assert.match(l, /npm ci\b/, `uses the lock file: ${l.trim()}`);
    assert.match(l, /--ignore-scripts/, `runs no install scripts: ${l.trim()}`);
  }
  assert.ok(!/curl[^\n]*\|\s*(sh|bash)/.test(read("deploy/Dockerfile")), "no piping a download into a shell");
});

test("workflows are read-only, keep no credentials, and install only from lock files without scripts", () => {
  for (const f of readdirSync(join(root, ".github/workflows")).filter(f => f.endsWith(".yml"))) {
    const text = read(`.github/workflows/${f}`);
    assert.match(text, /^permissions:\s*\n\s+contents: read\s*$/m, `${f}: top-level permissions are read-only`);
    assert.ok(!/^\s+(contents|packages|id-token|actions|pull-requests|security-events): write/m.test(text) || /# release: needs write/.test(text), `${f}: no write permission`);
    for (const [i, l] of text.split("\n").entries()) {
      if (/\bnpm (install|i)\b/.test(l) && !/npm ci/.test(l)) assert.fail(`${f}:${i + 1} uses npm install: ${l.trim()}`);
      if (/\bnpm ci\b/.test(l) && !/--ignore-scripts/.test(l)) assert.fail(`${f}:${i + 1} runs install scripts: ${l.trim()}`);
    }
    const checkouts = text.split("uses: actions/checkout").slice(1);
    for (const c of checkouts) assert.match(c.split("\n").slice(0, 4).join("\n"), /persist-credentials: false/, `${f}: a checkout keeps credentials`);
  }
});

/** Actions not yet pinned to a commit. The list may only shrink: run deploy/pin-actions.sh and it empties. */
const UNPINNED_ALLOWED = new Set(["actions/checkout", "actions/setup-node", "actions/setup-dotnet", "actions/upload-artifact"]);

test("third-party actions are pinned to a commit, except those still waiting for deploy/pin-actions.sh", () => {
  for (const f of readdirSync(join(root, ".github/workflows")).filter(f => f.endsWith(".yml"))) {
    for (const [i, l] of lines(`.github/workflows/${f}`).entries()) {
      const m = /uses:\s+([\w.-]+\/[\w./-]+)@(\S+)/.exec(l);
      if (!m) continue;
      const pinned = /^[0-9a-f]{40}$/.test(m[2]!);
      assert.ok(pinned || UNPINNED_ALLOWED.has(m[1]!), `${f}:${i + 1} ${m[1]}@${m[2]} must be pinned to a commit`);
    }
  }
});

test("the files that keep dependencies, owners and reporting in order exist", () => {
  for (const f of [".github/dependabot.yml", ".github/CODEOWNERS", "SECURITY.md", "docs/platform/supply-chain.md", "deploy/pin-actions.sh"]) assert.ok(existsSync(join(root, f)), f);
  for (const d of ["server", "console", "contracts"]) assert.ok(existsSync(join(root, d, "package-lock.json")), `${d} has a lock file`);
  const lockedMode = read("agent/Directory.Build.props");
  assert.match(lockedMode, /RestorePackagesWithLockFile>true/);
  assert.match(lockedMode, /RestoreLockedMode Condition="'\$\(CI\)' == 'true'">true/);
});
