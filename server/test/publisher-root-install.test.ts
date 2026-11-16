// Execute both shipped PowerShell trust steps with in-memory stores: no machine trust is changed by this test.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fleetInstallScript } from "../src/console-api/fleet-install-script.js";

const pin = "3049e830ab210ae07a12f5fc287b0e503532e2245de6daf5546fb53916bffc3b";
const installer = readFileSync(new URL("../../../agent/install/Install-CabinetAgent.ps1", import.meta.url), "utf8");
const fleet = fleetInstallScript({ consoleOrigin: "https://console.example", host: "agent.example", port: 8443,
  caPem: readFileSync(new URL("../../../contracts/trust/upgrade/agent-code-signing-root.pem", import.meta.url), "utf8"),
  caSha256: pin, packages: { "windows-x64": pin, "windows-x86": pin }, token: "A".repeat(64), unsigned: false });
const available = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;
const stores = `
$ErrorActionPreference = 'Stop'
class MemoryStore {
    static [hashtable] $Stores = @{}
    static [int] $Adds = 0
    static [int] $Opens = 0
    [Security.Cryptography.X509Certificates.X509Certificate2Collection] $Certificates = [Security.Cryptography.X509Certificates.X509Certificate2Collection]::new()
    [void] Open([object] $flags) { [MemoryStore]::Opens++ }
    [void] Close() {}
    [void] Add([Security.Cryptography.X509Certificates.X509Certificate2] $cert) { $this.Certificates.Add([Security.Cryptography.X509Certificates.X509Certificate2]::new($cert.RawData)); [MemoryStore]::Adds++ }
}
function New-Object([string] $TypeName, [object[]] $ArgumentList) {
    if ($TypeName -eq 'Security.Cryptography.X509Certificates.X509Store') {
        if ($ArgumentList[1] -ne 'LocalMachine') { throw 'Wrong store location' }
        $name = $ArgumentList[0]
        if (-not [MemoryStore]::Stores.ContainsKey($name)) { [MemoryStore]::Stores[$name] = [MemoryStore]::new() }
        return [MemoryStore]::Stores[$name]
    }
    Microsoft.PowerShell.Utility\\New-Object -TypeName $TypeName -ArgumentList $ArgumentList
}
`;
for (const [name, source] of [["local installer", installer], ["fleet script", fleet]] as const) {
  test(`${name}: the offline root is pinned before importing and reruns add no certificates`, { skip: !available && "PowerShell 7 is required" }, () => {
    const match = source.match(/# Offline publisher root,[\s\S]*?finally \{ \$publisherRoot.Dispose\(\) \}/);
    assert.ok(match, "the shipped trust installation step is present");
    const block = match[0];
    // First refuse the genuine certificate against an incorrect pin, before opening either store.
    const refused = block.replace(pin, "0".repeat(64));
    const script = stores + `
$refused = $false
try { & { ${refused} } } catch { $refused = $true }
if (-not $refused -or [MemoryStore]::Opens -ne 0) { throw 'Unpinned root reached a store' }
& { ${block} }
& { ${block} }
if ([MemoryStore]::Adds -ne 2) { throw 'Rerun added certificates' }
if ([MemoryStore]::Stores.Count -ne 2) { throw 'Expected two machine stores' }
foreach ($name in 'Root', 'TrustedPublisher') {
    if ([MemoryStore]::Stores[$name].Certificates.Count -ne 1) { throw 'Missing root' }
    $cert = [MemoryStore]::Stores[$name].Certificates[0]
    if ($cert.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant() -ne '${pin}') { throw 'Wrong root' }
}
`;
    const run = spawnSync("pwsh", ["-NoProfile", "-Command", script], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });
}
