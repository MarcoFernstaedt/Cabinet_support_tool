// The install line, "What PowerShell version am I on?", and "Which Windows am I on?" (src/lib/install-command.ts).
// A cabinet is set up by hand on the machine, so the console has to hand over the exact line for the engine the
// operator actually has: Windows ships Windows PowerShell 5.1 and PowerShell 7 is only sometimes installed. It also
// has to hand over the package the machine can run, because Windows cannot run a 64-bit program on 32-bit Windows.
// These tests hold the lines to being one installer with one set of arguments and one package per architecture, and
// hold both pieces of help to answering a real answer from the screen instead of guessing.
import test from "node:test";
import assert from "node:assert/strict";
import { ARCHITECTURE_HELP, DEFAULT_INSTALL_ARCHITECTURE, DEFAULT_INSTALL_ENGINE, INSTALL_ARCHITECTURES, INSTALL_ENGINES, VERSION_HELP, architectureFromText, architectureInfo, engineFromVersionText, engineInfo, installCommand } from "../src/lib/install-command.ts";

const full = { host: "cab.example.com", port: 8443, caSha256: "a".repeat(64), unsigned: true };

test("the pasted block unpacks the package itself, puts the token and CA beside it, and runs the installer", () => {
  const windows = installCommand({ ...full, engine: "windows" });
  const pwsh = installCommand({ ...full, engine: "pwsh" });
  assert.equal(windows.split("\n").length, 3, "one step per line, so a paste that loses a line fails where it lost it");
  assert.match(windows, /^\$p="\$HOME\\Downloads\\CabinetAgent-win-x64\.zip"; \$s="\$env:TEMP\\CabinetAgent-install";/);
  assert.match(windows, /\[IO\.Compression\.ZipFile\]::ExtractToDirectory\(\$p,\$s\)/);
  assert.match(windows, /Copy-Item -Force "\$HOME\\Downloads\\token\.txt","\$HOME\\Downloads\\platform-ca\.pem" \$s/);
  assert.match(windows, /\ncd \$s\n/);
  assert.match(windows, /\npowershell\.exe -NoProfile -ExecutionPolicy Bypass -File \.\\install\\Install-CabinetAgent\.ps1 /);
  assert.equal(pwsh.replace("pwsh.exe", "powershell.exe"), windows, "only the program that starts it may differ between the two engines");
  // Nothing in the block may depend on the operator having unzipped anything or made a folder first.
  assert.doesNotMatch(windows, /Move-Item|Expand-Archive [^)]*DestinationPath \$HOME\\Downloads\\CabinetAgent\b/);
});

test("the block names the package the console is serving", () => {
  const named = installCommand({ ...full, engine: "windows", packageName: "CabinetAgent-win-x86.zip" });
  assert.match(named, /CabinetAgent-win-x86\.zip/);
  assert.doesNotMatch(named, /win-x64/, "a 32-bit cabinet must not be handed the 64-bit package name");
  assert.match(installCommand({ ...full, engine: "windows" }), /CabinetAgent-win-x64\.zip/);
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

test("the architecture decides which package the line names, and 64-bit is what it picks without being told", () => {
  assert.equal(DEFAULT_INSTALL_ARCHITECTURE, "windows-x64", "almost every machine is 64-bit, so it is the one offered first");
  assert.equal(INSTALL_ARCHITECTURES[0]?.id, DEFAULT_INSTALL_ARCHITECTURE);
  assert.equal(architectureInfo("windows-x86").packageName, "CabinetAgent-win-x86.zip");
  for (const architecture of INSTALL_ARCHITECTURES) {
    const other = INSTALL_ARCHITECTURES.find(a => a.id !== architecture.id)!;
    for (const engine of INSTALL_ENGINES) {
      const line = installCommand({ ...full, engine: engine.id, architecture: architecture.id });
      assert.match(line, new RegExp(architectureInfo(architecture.id).packageName.replace(".", "\\.")), `${engine.id} on ${architecture.id} has to name its own package`);
      assert.doesNotMatch(line, new RegExp(other.packageName.replace(".", "\\.")), `${engine.id} on ${architecture.id} must never name the other architecture's package`);
    }
  }
  assert.match(installCommand({ ...full, engine: "windows" }), /CabinetAgent-win-x64\.zip/, "a line built without an architecture is the 64-bit one");
  // The console passes the name the server is really serving, and that name still wins: the page must not disagree
  // with the file the operator downloaded.
  assert.match(installCommand({ ...full, engine: "windows", architecture: "windows-x86", packageName: "Custom.zip" }), /Custom\.zip/);
});

test("the architecture help says how to ask the machine, and how to read its answer", () => {
  assert.ok(ARCHITECTURE_HELP.steps.some(s => s.includes("Win32_OperatingSystem")), "the help has to name the line that asks Windows itself");
  assert.ok(ARCHITECTURE_HELP.steps.some(s => s.includes("OSArchitecture")));
  assert.ok(ARCHITECTURE_HELP.read.some(r => r.when === "64-bit"), "64-bit has to be explained as the 64-bit choice");
  assert.ok(ARCHITECTURE_HELP.read.some(r => r.when === "32-bit"), "32-bit has to be explained as the 32-bit choice");
  assert.equal(architectureFromText(ARCHITECTURE_HELP.read[0]!.when), "windows-x64");
  assert.equal(architectureFromText(ARCHITECTURE_HELP.read[1]!.when), "windows-x86");
  assert.ok(ARCHITECTURE_HELP.notes.some(n => n.includes("$env:PROCESSOR_ARCHITECTURE")), "the answer that misleads (a 32-bit shell on a 64-bit machine) has to be named");
});

test("the answer an operator reads out is turned into the right architecture, and a shell's x86 is not guessed at", () => {
  assert.equal(architectureFromText("64-bit"), "windows-x64");
  assert.equal(architectureFromText(" 64-Bit "), "windows-x64");
  assert.equal(architectureFromText("64-bit operating system"), "windows-x64");
  assert.equal(architectureFromText("32-bit"), "windows-x86");
  assert.equal(architectureFromText("32-bit operating system, x64-based processor"), "windows-x86");
  for (const text of ["", "   ", "x86", "AMD64", "no idea", "Windows 11", "10.0.26200.5074"]) {
    assert.equal(architectureFromText(text), null, `${JSON.stringify(text)} must not be read as an architecture`);
  }
});
