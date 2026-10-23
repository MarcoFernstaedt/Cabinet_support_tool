// The launcher is generated text that lands on a cabinet and runs elevated there, so what it promises has to hold in
// the file itself: pure ASCII (PowerShell 5.1 reads a BOM-less .ps1 as ANSI), CRLF (it is batch), the values the
// console shows and the values it checks are the same, no token in a file that can be forwarded, and no configuration
// value able to close a quote and become code.
import test from "node:test";
import assert from "node:assert/strict";
import { LAUNCHER_NAME, launcherPayload, launcherScript } from "../src/console-api/installer-launcher.js";

const base = {
  packageName: "CabinetAgent-win-x64.zip",
  packageSha256: "a".repeat(64),
  host: "168.231.67.178",
  port: 8443,
  caSha256: "B".repeat(64),
  unsigned: true,
};

test("the launcher is ASCII and batch-shaped", () => {
  const text = launcherScript(base);
  const wide = [...text].filter(c => c.charCodeAt(0) > 127);
  assert.deepEqual(wide, [], "a non-ASCII character corrupts the script on Windows PowerShell");
  assert.equal(text.includes("\r\n"), true, "batch needs CRLF");
  assert.equal(/\r\n/.test(text.split("\n").filter(l => l.endsWith("\r") === false).join("") || "\r\n"), true);
  assert.equal(text.startsWith("@echo off\r\n"), true);
  assert.equal(text.trimEnd().endsWith("exit /b %cabinet_setup_exit%"), true);
  assert.equal(LAUNCHER_NAME, "Install-CabinetAgent.cmd");
});

test("it elevates before installing and carries the PowerShell encoded", () => {
  const text = launcherScript(base);
  assert.match(text, /net session >nul 2>&1/);
  assert.match(text, /Start-Process -FilePath '%~f0' -Verb RunAs/);
  assert.match(text, /-EncodedCommand [A-Za-z0-9+/=]+/);
});

test("-EncodedCommand carries exactly the payload, as UTF-16LE", () => {
  const text = launcherScript(base);
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(text)![1]!;
  const decoded = Buffer.from(encoded, "base64").toString("utf16le");
  assert.equal(decoded, launcherPayload(base));
  assert.deepEqual([...decoded].filter(c => c.charCodeAt(0) > 127), []);
});

test("the values the console shows are the values the launcher checks", () => {
  const payload = launcherPayload(base);
  assert.match(payload, /\$packageName = 'CabinetAgent-win-x64\.zip'/);
  assert.match(payload, new RegExp(`\\$packageSha = '${"a".repeat(64)}'`));
  assert.match(payload, new RegExp(`\\$caSha = '${"B".repeat(64)}'`));
  assert.match(payload, /\$serverHost = '168\.231\.67\.178'/);
  assert.match(payload, /\$serverPort = '8443'/);
  assert.match(payload, /Get-FileHash -LiteralPath \$zip -Algorithm SHA256/);
  assert.match(payload, /-PlatformCaSha256/);
  assert.match(payload, /-BootstrapTokenFile/);
});

test("an unsigned build is accepted and a signed one is not", () => {
  assert.match(launcherPayload(base), /-AllowUnsigned/);
  assert.equal(launcherPayload({ ...base, unsigned: false }).includes("-AllowUnsigned"), false);
});

test("no token ever travels in the file", () => {
  const text = launcherScript(base) + launcherPayload(base);
  assert.equal(/-BootstrapToken\s+\S/.test(text), false, "a token argument would be a token in a forwarded file");
  assert.match(text, /Read-Host 'Paste the install token/);
  assert.match(text, /Create install token/);
});

test("every failure says what happened and what to do", () => {
  const payload = launcherPayload(base);
  const failures = payload.match(/Write-Failure/g)?.length ?? 0;
  assert.ok(failures >= 6, `expected a failure funnel at every step, found ${failures}`);
  assert.match(payload, /What happened:/);
  assert.match(payload, /What to do:/);
  assert.match(payload, /exit 1/);
});

test("hostile configuration cannot close a quote and become code", () => {
  const hostile = launcherPayload({
    ...base,
    host: "x'; Remove-Item -LiteralPath C:\\ -Recurse -Force; '",
    packageName: "a.zip'; whoami; '",
    caSha256: "not a hash",
    port: 99999,
  });
  assert.equal(hostile.includes("Remove-Item"), false);
  assert.equal(hostile.includes("whoami"), false);
  assert.match(hostile, /\$serverHost = ''/, "an unusable host falls back rather than travelling");
  assert.match(hostile, /\$caSha = ''/);
  assert.match(hostile, /\$serverPort = '8443'/);
  assert.match(hostile, /\$packageName = 'CabinetAgent-win-x64\.zip'/);
  assert.deepEqual([...launcherScript({ ...base, host: "x'; whoami; '" })].filter(c => c.charCodeAt(0) > 127), []);
});
