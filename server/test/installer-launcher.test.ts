// The installer is generated text that runs elevated on a cabinet, so what it promises has to hold in the file itself:
// ASCII and CRLF, every line cmd.exe reads far below its 8,191-character limit, every program started by its full path,
// no path ever spliced into a command, the values it checks are the values the server serves, and no value able to
// close a quote and become code. The PowerShell parts are parsed by a real PowerShell when one is installed.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { LAUNCHER_NAME, PAYLOAD_MARKER, bootstrapScript, launcherPayload, launcherScript, type LauncherInput } from "../src/console-api/installer-launcher.js";
import { tempDir } from "./helpers.js";

const PEM = "-----BEGIN CERTIFICATE-----\n" + "MIIB".padEnd(64, "A") + "\n" + "B".repeat(64) + "\n" + "C".repeat(40) + "=\n-----END CERTIFICATE-----\n";
const base: LauncherInput = {
  packages: { "windows-x64": { name: "CabinetAgent-win-x64.zip", sha256: "a".repeat(64) }, "windows-x86": { name: "CabinetAgent-win-x86.zip", sha256: "b".repeat(64) } },
  host: "cabinets.example.com",
  port: 8443,
  caPem: PEM,
  caSha256: "C".repeat(64),
  token: "T".repeat(43),
  unsigned: false,
};

const batchPart = (text: string) => text.slice(0, text.indexOf(PAYLOAD_MARKER));

test("the file is ASCII, CRLF, and every line cmd.exe reads is short", () => {
  const text = launcherScript(base);
  assert.deepEqual([...text].filter(c => c.charCodeAt(0) > 127), [], "a non-ASCII character corrupts the script on Windows PowerShell 5.1");
  assert.equal(text.replace(/\r\n/g, "").includes("\n"), false, "every line ends in CRLF");
  assert.equal(text.startsWith("@echo off\r\n"), true);
  const longest = Math.max(...batchPart(text).split("\r\n").map(l => l.length));
  assert.ok(longest < 8191, `cmd.exe refuses lines over 8,191 characters; the longest is ${longest}`);
  assert.equal(LAUNCHER_NAME, "Install-CabinetAgent.cmd");
});

test("the batch part ends before the PowerShell part, so cmd.exe never reads it", () => {
  const batch = batchPart(launcherScript(base)).trimEnd().split("\r\n");
  assert.equal(batch.at(-1), "exit /b %CABINET_EXIT%");
  assert.ok(batch.includes(":elevated") && batch.includes(":failed"));
});

test("every program is started by its full path, and no path is spliced into a command", () => {
  const batch = batchPart(launcherScript(base));
  for (const line of batch.split("\r\n")) {
    if (/^(rem |echo|set |if |:|exit|pause|setlocal|@echo|\(goto\)|$)/.test(line)) continue;
    assert.match(line, /^"%(SystemRoot|CABINET_PS)%/, `a program started by bare name can be hijacked from the current folder: ${line}`);
  }
  assert.match(batch, /"%SystemRoot%\\System32\\fltmc\.exe" >nul 2>&1/);
  assert.match(batch, /set "CABINET_PS=%SystemRoot%\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe"/);
  assert.match(batch, /Sysnative\\WindowsPowerShell/, "64-bit PowerShell on 64-bit Windows, even from a 32-bit prompt");
  assert.match(batch, /Start-Process -FilePath \(Join-Path \$env:SystemRoot 'System32\\cmd\.exe'\) -Verb RunAs -ArgumentList \('\/d \/s \/c \\"\\"' \+ \$env:CABINET_LAUNCHER \+ '\\" --elevated\\"'\)/,
    "cmd.exe is elevated by full path and given the launcher's path from a variable, quoted for cmd /s /c, so '(1).cmd' runs as itself");
  assert.match(batch, /if \/i "%~1"=="--elevated" goto noadmin/, "it asks for administrator rights once, never in a loop");
  assert.equal(/'%~f0'|"%~f0"[^\r]*-Command/.test(batch), false);
  assert.equal(/\bnet session\b|^powershell(\.exe)? /m.test(batch), false);
  const bootstrap = bootstrapScript();
  assert.match(bootstrap, /Join-Path \$PSHOME 'powershell\.exe'/);
});

test("the bootstrap travels as plain text (antivirus treats encoded commands as obfuscation) and makes a private folder in one step", () => {
  const text = launcherScript(base);
  assert.equal(text.includes("-EncodedCommand"), false);
  const line = batchPart(text).split("\r\n").find(l => l.includes("-Command \"$ErrorActionPreference"))!;
  assert.equal(line, `"%CABINET_PS%" -NoProfile -ExecutionPolicy Bypass -Command "${bootstrapScript().split("\n").map(l => l.trim()).join("; ")}"`);
  assert.equal(/["%^&|<>!]/.test(line.slice(line.indexOf('-Command "') + 10, -1)), false, "nothing in it ends cmd's quote or means something to cmd.exe");
  const b = bootstrapScript();
  assert.match(b, /\[IO\.Directory\]::CreateDirectory\(\$stage, \$sec\)/, "the folder is created with its permissions, not locked down afterwards");
  assert.match(b, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(b, /'S-1-5-18', 'S-1-5-32-544'/);
  assert.match(b, /NewGuid\(\)/, "a random name nobody can create first");
  assert.match(b, /ReparsePoint/);
  assert.match(b, /Remove-Item -LiteralPath \$stage -Recurse -Force/, "the folder, with the token in it, is removed whatever happens");
});

test("the copy is checked, not the download, and the right package is chosen for this machine's Windows", () => {
  const p = launcherPayload(base);
  assert.match(p, /'windows-x64' = @\{ Name = 'CabinetAgent-win-x64\.zip'; Sha256 = 'a{64}' \}/);
  assert.match(p, /'windows-x86' = @\{ Name = 'CabinetAgent-win-x86\.zip'; Sha256 = 'b{64}' \}/);
  assert.match(p, /Is64BitOperatingSystem/);
  const copy = p.indexOf("Copy-Item -LiteralPath $candidate.FullName -Destination $zip");
  const hash = p.indexOf("Get-FileHash -LiteralPath $zip");
  const unpack = p.indexOf("ExtractToDirectory($zip, $unpacked)");
  assert.ok(copy > 0 && copy < hash && hash < unpack, "copy into the private folder, hash that copy, unpack that copy");
  assert.match(p, /Join-Path \$unpacked 'CabinetAgent\\install\\Install-CabinetAgent\.ps1'/, "the installer is run by its exact path");
  assert.match(p, /-PlatformCaSha256', \$caSha/);
  assert.match(p, /\$serverHost = 'cabinets\.example\.com'/);
  assert.match(p, /\$serverPort = 8443/);
});

test("a server with only one architecture says so for the other, rather than installing the wrong one", () => {
  const p = launcherPayload({ ...base, packages: { "windows-x64": null, "windows-x86": base.packages["windows-x86"] } });
  assert.match(p, /'windows-x64' = \$null/);
  assert.match(p, /the server has no ' \+ \$label \+ ' agent package/);
  assert.throws(() => launcherPayload({ ...base, packages: { "windows-x64": null, "windows-x86": null } }), /no agent package/);
});

test("the server decides whether an unsigned build is accepted", () => {
  assert.equal(launcherPayload(base).includes("-AllowUnsigned"), false);
  assert.match(launcherPayload({ ...base, unsigned: true }), /\$installerArgs \+= '-AllowUnsigned'/);
});

test("the file deletes itself after a successful install, and says it holds a token", () => {
  const batch = batchPart(launcherScript(base));
  assert.match(batch, /\(goto\) 2>nul & del "%~f0"/);
  assert.match(batch, /one-time install token/);
  assert.ok(batch.indexOf('del "%~f0"') < batch.indexOf(":failed"), "only the success path deletes it");
});

test("hostile values are refused, never written into the file", () => {
  const hostile: Partial<LauncherInput>[] = [
    { host: "x'; Remove-Item C:\\ -Recurse; '" },
    { host: "" },
    { token: "short" },
    { token: "A".repeat(40) + "'; whoami; '" },
    { caSha256: "not a hash" },
    { caPem: "-----BEGIN CERTIFICATE-----\n'@\nwhoami\n-----END CERTIFICATE-----" },
    { packages: { "windows-x64": { name: "a.zip'; whoami; '", sha256: "a".repeat(64) }, "windows-x86": null } },
    { packages: { "windows-x64": { name: "CabinetAgent-win-x64.zip", sha256: "z".repeat(64) }, "windows-x86": null } },
  ];
  for (const h of hostile) assert.throws(() => launcherScript({ ...base, ...h }), /cannot be made/, JSON.stringify(h));
  assert.match(launcherPayload({ ...base, port: 99999 }), /\$serverPort = 8443/);
});

test("both PowerShell parts parse", { skip: !hasPwsh() && "no PowerShell on this machine" }, () => {
  const dir = tempDir();
  const files = { "payload.ps1": launcherPayload({ ...base, unsigned: true }), "bootstrap.ps1": bootstrapScript() };
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, name);
    writeFileSync(path, text);
    const out = execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
      "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:PARSE_FILE, [ref]$null, [ref]$e); $e.Count; $e | ForEach-Object { $_.Message }"],
      { encoding: "utf8", env: { ...process.env, PARSE_FILE: path } });
    assert.equal(out.trim().split("\n")[0], "0", `${name} has parse errors: ${out}`);
  }
});

function hasPwsh(): boolean {
  try { execFileSync("pwsh", ["-NoProfile", "-Command", "1"], { stdio: "ignore" }); return true; } catch { return false; }
}
