// The install line and "What PowerShell version am I on?" (src/lib/install-command.ts).
// A cabinet is set up by hand on the machine, so the console has to hand over the exact line for the engine the
// operator actually has: Windows ships Windows PowerShell 5.1 and PowerShell 7 is only sometimes installed. These
// tests hold the two lines to being one installer with one set of arguments, and hold the help to answering a real
// version string instead of guessing.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_INSTALL_ENGINE, INSTALL_ENGINES, VERSION_HELP, engineFromVersionText, engineInfo, installCommand } from "../src/lib/install-command.ts";

const full = { host: "cab.example.com", port: 8443, caSha256: "a".repeat(64), unsigned: true };

test("the pasted line starts the engine the operator picked and finishes the same installer", () => {
  const windows = installCommand({ ...full, engine: "windows" });
  const pwsh = installCommand({ ...full, engine: "pwsh" });
  assert.match(windows, /^cd \$HOME\\Downloads\\CabinetAgent\npowershell\.exe -NoProfile -ExecutionPolicy Bypass -File \.\\install\\Install-CabinetAgent\.ps1 /);
  assert.match(pwsh, /^cd \$HOME\\Downloads\\CabinetAgent\npwsh\.exe /);
  assert.equal(pwsh.replace("pwsh.exe", "powershell.exe"), windows, "only the program that starts it may differ between the two engines");
});

test("every value the installer needs is on both lines", () => {
  for (const engine of INSTALL_ENGINES) {
    const line = installCommand({ ...full, engine: engine.id });
    assert.match(line, /-PlatformServerHost cab\.example\.com/);
    assert.match(line, /-PlatformServerPort 8443/);
    assert.match(line, /-PlatformCaFile \.\\platform-ca\.pem/);
    assert.match(line, /-PlatformCaSha256 a{64}/);
    assert.match(line, /-BootstrapTokenFile \.\\token\.txt/);
  }
});

test("a server that has not reported its address yet still gets a line to read", () => {
  const line = installCommand({ host: null, port: null, caSha256: "", engine: "windows" });
  assert.match(line, /-PlatformServerHost <server>/);
  assert.match(line, /-PlatformServerPort 8443/);
  assert.match(line, /-PlatformCaSha256 <the SHA-256 the console shows>/);
  assert.doesNotMatch(line, /undefined|null/);
});

test("the unsigned flag is on the line only for an unsigned package", () => {
  assert.match(installCommand({ ...full, engine: "windows" }), /-AllowUnsigned$/m);
  assert.doesNotMatch(installCommand({ ...full, unsigned: false, engine: "windows" }), /-AllowUnsigned/);
});

test("the engine offered first is the one every Windows machine has", () => {
  assert.equal(DEFAULT_INSTALL_ENGINE, "windows");
  assert.equal(INSTALL_ENGINES[0]?.id, DEFAULT_INSTALL_ENGINE);
  assert.equal(engineInfo(DEFAULT_INSTALL_ENGINE).exe, "powershell.exe");
  assert.equal(engineInfo("pwsh").exe, "pwsh.exe");
});

test("the help says how to look the version up and how to read the answer", () => {
  assert.ok(VERSION_HELP.steps.some(s => s.includes("$PSVersionTable.PSVersion")), "the help has to name the line that prints the version");
  assert.ok(VERSION_HELP.read.some(r => r.when.startsWith("5.1")), "5.1 has to be explained as Windows PowerShell");
  assert.ok(VERSION_HELP.read.some(r => r.when.startsWith("7")), "7 has to be explained as PowerShell 7");
  assert.equal(engineFromVersionText(VERSION_HELP.read[0]!.when), "windows");
  assert.equal(engineFromVersionText(VERSION_HELP.read[1]!.when), "pwsh");
});

test("the version an operator reads out is turned into the right engine", () => {
  assert.equal(engineFromVersionText("5.1.26100.9711"), "windows");
  assert.equal(engineFromVersionText("PSVersion 5.1.26100.9711"), "windows");
  assert.equal(engineFromVersionText("Major  Minor  Build  Revision\n-----  -----  -----  --------\n5      1      26100  9711"), "windows");
  assert.equal(engineFromVersionText("7.4.6"), "pwsh");
  assert.equal(engineFromVersionText("  7.5.0-preview.3  "), "pwsh");
  assert.equal(engineFromVersionText("6.2.7"), "pwsh", "PowerShell 6 is started the same way (pwsh)");
});

test("anything that is not a PowerShell version is not guessed at", () => {
  for (const text of ["", "   ", "no idea", "Windows 11", "10.0.26200.5074", "$PSVersionTable.PSVersion"]) {
    assert.equal(engineFromVersionText(text), null, `${JSON.stringify(text)} must not be read as an engine`);
  }
});
