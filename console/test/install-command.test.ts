// The architecture names the setup and upgrades pages show, and the package each one serves.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_INSTALL_ARCHITECTURE, INSTALL_ARCHITECTURES, architectureInfo } from "../src/lib/install-command.ts";

test("each architecture names its own package", () => {
  assert.deepEqual(INSTALL_ARCHITECTURES.map(a => [a.id, a.packageName]), [
    ["windows-x86", "CabinetAgent-win-x86.zip"],
    ["windows-x64", "CabinetAgent-win-x64.zip"],
  ]);
  assert.equal(architectureInfo("windows-x86").label, "32-bit Windows");
  assert.equal(architectureInfo("windows-x64").label, "64-bit Windows");
});

test("an unknown value falls back to the 64-bit default rather than throwing", () => {
  assert.equal(DEFAULT_INSTALL_ARCHITECTURE, "windows-x64");
  assert.equal(architectureInfo("windows-arm64" as never).id, "windows-x64");
});
