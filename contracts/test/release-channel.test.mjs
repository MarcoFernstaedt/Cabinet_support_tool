// F1.R3 (docs/spec/07-upgrade-channel.md "A build that ships to cabinets"): a build for the cabinet release channel fails when it could not
// check a release's code-signing publisher, or would accept unsigned programs. Runs the agent's own MSBuild check (no package restore
// needed) against the repository's trust list and against a throwaway one with a publisher pinned. Skipped where dotnet is not installed.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROJECT = join(ROOT, "agent", "src", "Cabinet.Agent.Core", "Cabinet.Agent.Core.csproj");
const dotnet = spawnSync("dotnet", ["--version"], { encoding: "utf8" });
const skip = dotnet.status === 0 ? false : "dotnet is not installed";

/** Runs only the check target, with these MSBuild properties; returns the error codes it reported (CAB0001, CAB0002). */
function check(props) {
  const r = spawnSync("dotnet", ["msbuild", PROJECT, "-t:CheckCabinetReleaseTrust", "-nologo", ...Object.entries(props).map(([k, v]) => `-p:${k}=${v}`)], { encoding: "utf8" });
  const out = `${r.stdout}${r.stderr}`;
  return { ok: r.status === 0, codes: ["CAB0001", "CAB0002"].filter(c => out.includes(c)), out };
}

test("a cabinet release build with no code-signing publisher pinned fails to build (the repository today)", { skip }, () => {
  // The repository's list, as shipped: one release key, no publisher.
  assert.equal(JSON.parse(readFileSync(join(ROOT, "contracts", "trust", "upgrade", "upgrade-keys.json"), "utf8")).publishers.length, 0);
  const r = check({ CabinetReleaseChannel: "production" });
  assert.equal(r.ok, false, r.out);
  assert.deepEqual(r.codes, ["CAB0002"]);
});

test("a cabinet release build that allows unsigned development upgrades fails to build, publisher or not", { skip }, () => {
  const r = check({ CabinetReleaseChannel: "production", AllowUnsignedDevelopmentUpgrades: "true" });
  assert.equal(r.ok, false, r.out);
  assert.ok(r.codes.includes("CAB0001"), r.out);
});

test("with a publisher pinned, the cabinet release build passes the check; development and test builds are never stopped by it", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "upgrade-trust-"));
  try {
    writeFileSync(join(dir, "upgrade-keys.json"), JSON.stringify({ version: 1, keys: [],
      publishers: [{ commonName: "Example Agent Publisher", organization: "Example", root: "Example Root", rootFile: "example-root.pem" }] }));
    const pinned = check({ CabinetReleaseChannel: "production", UpgradeTrustDir: dir });
    assert.equal(pinned.ok, true, pinned.out);
    assert.deepEqual(pinned.codes, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // No channel (every development, test and CI build): the check does not run, whatever the trust list holds.
  const dev = check({});
  assert.equal(dev.ok, true, dev.out);
  assert.deepEqual(dev.codes, []);
  const devUnsigned = check({ AllowUnsignedDevelopmentUpgrades: "true" });
  assert.equal(devUnsigned.ok, true, devUnsigned.out);
});
