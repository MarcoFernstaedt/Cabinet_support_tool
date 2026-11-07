// F1.R1/R3 (docs/spec/07-upgrade-channel.md "A build that ships to cabinets"): the repository's own trust list has to pin a publisher
// whose root is the certificate beside it (agent/install/New-PublisherRoot.ps1 makes the material), and a build for the cabinet release channel
// code-signing publisher the agent can actually load, and fails when it would accept unsigned programs. Runs the agent's own MSBuild check
// (no package restore needed) against the repository's trust list and against throwaway ones. dotnet is found on PATH, under $DOTNET_ROOT or
// in ~/.dotnet; with none, the tests are skipped on a developer machine and fail under CI, so the check is never silently unproven there.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROJECT = join(ROOT, "agent", "src", "Cabinet.Agent.Core", "Cabinet.Agent.Core.csproj");
const DOTNET = ["dotnet", process.env.DOTNET_ROOT && join(process.env.DOTNET_ROOT, "dotnet"), join(homedir(), ".dotnet", "dotnet")]
  .filter(Boolean).find(d => spawnSync(d, ["--version"], { encoding: "utf8" }).status === 0);
const skip = DOTNET || process.env.CI ? false : "dotnet is not installed (PATH, $DOTNET_ROOT, ~/.dotnet)";

test("dotnet is available wherever this suite runs under CI", { skip: !process.env.CI }, () => assert.ok(DOTNET, "the release-channel check cannot be proven without dotnet"));

/** Runs only the check target with these MSBuild properties; returns the error codes it reported (CAB0001, CAB0002) and its output. */
function check(props) {
  const r = spawnSync(DOTNET, ["msbuild", PROJECT, "-t:CheckCabinetReleaseTrust", "-nologo", ...Object.entries(props).map(([k, v]) => `-p:${k}=${v}`)], { encoding: "utf8" });
  const out = `${r.stdout}${r.stderr}`;
  return { ok: r.status === 0, codes: ["CAB0001", "CAB0002"].filter(c => out.includes(c)), out };
}

// A real certificate to pin: one of the package roots already in contracts/trust, and its SHA-256 as the agent computes it (UpgradeTrust).
const PEM = join(ROOT, "contracts", "trust", "microsoft-root-2011.pem");
const PEM_HASH = createHash("sha256").update(new X509Certificate(readFileSync(PEM)).raw).digest("hex");

/** A throwaway trust folder: upgrade-keys.json with these publishers, plus the named files copied in. */
function trust(publishers, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "upgrade-trust-"));
  writeFileSync(join(dir, "upgrade-keys.json"), JSON.stringify({ version: 1, keys: [], publishers }, null, 2));
  for (const [name, from] of Object.entries(files)) copyFileSync(from, join(dir, name));
  return dir;
}
const publisher = (over = {}) => ({ commonName: "Example Agent Publisher", organization: "Example", root: PEM_HASH, rootFile: "agent-root.pem", ...over });
function inFolder(dir, fn) { try { return fn(check({ CabinetReleaseChannel: "production", UpgradeTrustDir: dir })); } finally { rmSync(dir, { recursive: true, force: true }); } }

test("the repository's trust list pins the publisher the fleet trusts, and a cabinet release build of it passes", { skip }, () => {
  // The material is made by agent/install/New-PublisherRoot.ps1 (our own root, no certificate bought) and the list here is
  // what every agent build compiles in. An empty publisher list is what this test used to assert, on the day it was the
  // truth; now the list has to be one that ships, and the cases below still prove an empty or broken one fails.
  const list = JSON.parse(readFileSync(join(ROOT, "contracts", "trust", "upgrade", "upgrade-keys.json"), "utf8"));
  assert.ok(list.publishers.length >= 1, "contracts/trust/upgrade/upgrade-keys.json pins no code-signing publisher: every cabinet would refuse every upgrade");
  for (const p of list.publishers) {
    assert.ok(p.commonName && p.organization, "a pinned publisher needs the exact common name and organization its certificate carries");
    // The agent hashes the DER of the certificate named beside the list (UpgradeTrust), and the build check compares the two.
    const hash = createHash("sha256").update(new X509Certificate(readFileSync(join(ROOT, "contracts", "trust", "upgrade", p.rootFile))).raw).digest("hex");
    assert.equal(hash, p.root, `${p.rootFile} is not the root the list pins as ${p.root}`);
  }
  const r = check({ CabinetReleaseChannel: "production" });
  assert.equal(r.ok, true, r.out);
  assert.deepEqual(r.codes, []);
});

test("a cabinet release build with no code-signing publisher pinned fails to build", { skip }, () => {
  inFolder(trust([]), r => {
    assert.equal(r.ok, false, r.out);
    assert.deepEqual(r.codes, ["CAB0002"]);
    assert.match(r.out, /no code-signing publisher is pinned/);
  });
});

test("a cabinet release build that allows unsigned development upgrades fails to build", { skip }, () => {
  const r = check({ CabinetReleaseChannel: "production", AllowUnsignedDevelopmentUpgrades: "true" });
  assert.equal(r.ok, false, r.out);
  assert.ok(r.codes.includes("CAB0001"), r.out);
});

test("a publisher the agent could not load fails the build: no name or organization, its root missing, unnamed, not a certificate, or not the pinned hash", { skip }, () => {
  inFolder(trust([publisher()]), r => { assert.deepEqual(r.codes, ["CAB0002"], "the root file is not beside the list"); assert.match(r.out, /is not in/); });
  inFolder(trust([publisher({ rootFile: "" })]), r => { assert.deepEqual(r.codes, ["CAB0002"], "no root file named"); assert.match(r.out, /names no root file/); });
  const notPem = join(tmpdir(), `not-a-cert-${process.pid}.pem`);
  writeFileSync(notPem, "hello");
  try { inFolder(trust([publisher()], { "agent-root.pem": notPem }), r => { assert.deepEqual(r.codes, ["CAB0002"]); assert.match(r.out, /not a PEM certificate/); }); }
  finally { rmSync(notPem, { force: true }); }
  inFolder(trust([publisher({ root: "0".repeat(64) })], { "agent-root.pem": PEM }), r => { assert.deepEqual(r.codes, ["CAB0002"]); assert.match(r.out, /not the pinned root/); });
  inFolder(trust([publisher({ organization: "" })], { "agent-root.pem": PEM }), r => { assert.deepEqual(r.codes, ["CAB0002"]); assert.match(r.out, /no common name or no organization/); });
  inFolder(trust([publisher({ commonName: "" })], { "agent-root.pem": PEM }), r => assert.deepEqual(r.codes, ["CAB0002"]));
  // One good publisher does not cover a broken second one.
  inFolder(trust([publisher(), publisher({ commonName: "Second", rootFile: "missing.pem" })], { "agent-root.pem": PEM }), r => assert.deepEqual(r.codes, ["CAB0002"]));
});

test("with a publisher the agent can load, the cabinet release build passes; development and test builds are never stopped by it", { skip }, () => {
  inFolder(trust([publisher()], { "agent-root.pem": PEM }), r => { assert.equal(r.ok, true, r.out); assert.deepEqual(r.codes, []); });
  // No channel (every development, test and CI build): the check does not run, whatever the trust list holds.
  const dev = check({});
  assert.equal(dev.ok, true, dev.out);
  assert.equal(check({ AllowUnsignedDevelopmentUpgrades: "true" }).ok, true);
});
