// The fleet install script: one PowerShell script per site installer, for a remote management tool that runs scripts as SYSTEM on many
// cabinets at once. It does what the launcher does (installer-launcher.ts) without a person at the cabinet: no elevation prompt, no
// Downloads folder, nothing to copy beside it. It downloads the agent package for this machine's architecture from the console, refuses
// it unless its SHA-256 is the one built into the script, and installs it with the site installer's token.
//
// What travels inside it: the console address the package is downloaded from, the agent API host and port the cabinet enrolls with,
// the platform CA and its SHA-256, the SHA-256 of each package, and the site installer's token. The token is bounded by count and days,
// and every cabinet that uses it still waits for an Admin's approval. It is sent to the console only in the Authorization header, and
// the download never counts as a use.
//
// Exit codes, for the remote management tool: 0 installed, or already installed (nothing changed); 1 not installed, with the reason and
// the next step on the last two lines of output. Windows PowerShell 5.1 syntax only, ASCII only. Every value is checked against its
// exact shape before it is written into the script, so no value can close a quote.
import { check, HOST, PEM, SHA256, TOKEN } from "./installer-launcher.js";

export const FLEET_SCRIPT_NAME = "Install-CabinetAgent-Fleet.ps1";

export interface FleetScriptInput {
  /** The console's own origin, where the package is downloaded from: https only. */
  consoleOrigin: string;
  /** Where the agent API answers, and the port it answers on. */
  host: string | null;
  port: number | null;
  caPem: string;
  caSha256: string;
  /** The SHA-256 of each architecture's package this server has. */
  packages: { "windows-x64": string | null; "windows-x86": string | null };
  token: string;
  unsigned: boolean;
}

const ORIGIN = /^https:\/\/[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$/;

const shaLine = (sha: string | null) => sha === null ? "$null" : `'${check(sha, SHA256, "a package SHA-256").toLowerCase()}'`;

export function fleetInstallScript(o: FleetScriptInput): string {
  const origin = check(o.consoleOrigin, ORIGIN, "the console address (it must be https)");
  const host = check(o.host, HOST, "the agent API host");
  const port = Number.isInteger(o.port) && (o.port ?? 0) > 0 && (o.port ?? 0) < 65536 ? o.port! : 8443;
  const caPem = check(o.caPem, PEM, "the platform CA").replace(/\r\n/g, "\n").trim();
  const caSha = check(o.caSha256, SHA256, "the platform CA SHA-256").toUpperCase();
  const token = check(o.token, TOKEN, "the install token");
  if (!o.packages["windows-x64"] && !o.packages["windows-x86"]) throw new Error("the installer cannot be made: this server has no agent package");

  return `# Installs the cabinet agent on this machine. Made for one site; run it as SYSTEM from a remote management tool.
# Exit 0: installed, or already installed. Exit 1: not installed; the last two lines say why and what to do next.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Stop-Install([string] $What, [string] $How) {
    Write-Output ('Not installed: ' + $What)
    Write-Output ('Next step: ' + $How)
    exit 1
}

$consoleOrigin = '${origin}'
$serverHost = '${host}'
$serverPort = ${port}
$caSha = '${caSha}'
$token = '${token}'
$packages = @{
    'windows-x64' = ${shaLine(o.packages["windows-x64"])}
    'windows-x86' = ${shaLine(o.packages["windows-x86"])}
}
$caPem = @'
${caPem}
'@

try {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Stop-Install 'the script is not running with administrator rights.' 'Run it as SYSTEM from the remote management tool.'
    }
    if (Get-Service -Name 'CabinetAgentNetwork' -ErrorAction SilentlyContinue) {
        Write-Output 'Already installed: the cabinet agent is on this machine. Nothing was changed.'
        exit 0
    }

    # This machine's Windows, asked of Windows itself: a 32-bit PowerShell on 64-bit Windows would otherwise say x86.
    $architecture = if ([Environment]::Is64BitOperatingSystem) { 'windows-x64' } else { 'windows-x86' }
    $expected = $packages[$architecture]
    if (-not $expected) { Stop-Install ('the server has no ' + $architecture + ' agent package.') 'Ask the platform administrator to publish it, then run the script again.' }

    # A new folder with a random name, owned by Administrators and changeable only by SYSTEM and Administrators, made in one step
    # with its permissions so that nobody else can write into it at any moment.
    $sec = New-Object Security.AccessControl.DirectorySecurity
    $sec.SetAccessRuleProtection($true, $false)
    $sec.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    foreach ($sid in 'S-1-5-18', 'S-1-5-32-544') {
        $sec.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    }
    $stage = Join-Path (Join-Path $env:SystemRoot 'Temp') ('CabinetSetup-' + [guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $stage) { Stop-Install 'a private setup folder could not be made.' 'Run the script again.' }
    [void][IO.Directory]::CreateDirectory($stage, $sec)
    $made = Get-Item -LiteralPath $stage -Force
    if (($made.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ((Get-Acl -LiteralPath $stage).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544')) {
        Stop-Install 'a private setup folder could not be made.' 'Run the script again.'
    }

    $code = 1
    try {
        # Download over TLS 1.2 or later, from the console, with the token in the header and never in the address.
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $zip = Join-Path $stage 'agent.zip'
        try {
            Invoke-WebRequest -UseBasicParsing -Uri ($consoleOrigin + '/api/install/package?architecture=' + $architecture) -Headers @{ Authorization = ('Bearer ' + $token) } -OutFile $zip -TimeoutSec 900
        } catch {
            $status = 0
            if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
            if ($status -eq 401) { Stop-Install 'the site installer this script was made from has expired, been used up or been stopped.' 'Create a new fleet install script for the site in the console.' }
            Stop-Install ('the agent package could not be downloaded from ' + $consoleOrigin + ': ' + $_.Exception.Message) ('Check that this cabinet can reach ' + $consoleOrigin + ' over HTTPS, then run the script again.')
        }
        if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
            Stop-Install 'the downloaded package is not the one this script was made for.' 'Create a new fleet install script for the site in the console (the agent was updated since this one was made).'
        }

        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $unpacked = Join-Path $stage 'agent'
        [IO.Compression.ZipFile]::ExtractToDirectory($zip, $unpacked)
        $admins = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
        foreach ($item in @(Get-Item -LiteralPath $unpacked) + @(Get-ChildItem -LiteralPath $unpacked -Recurse -Force)) {
            $acl = Get-Acl -LiteralPath $item.FullName
            $acl.SetOwner($admins)
            Set-Acl -LiteralPath $item.FullName -AclObject $acl
        }
        $installer = Join-Path $unpacked 'CabinetAgent\\install\\Install-CabinetAgent.ps1'
        if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { Stop-Install 'the package does not contain the installer.' 'Send this output to support.' }

        $caFile = Join-Path $stage 'platform-ca.pem'
        $tokenFile = Join-Path $stage 'token.txt'
        [IO.File]::WriteAllText($caFile, $caPem + "\`n", (New-Object Text.ASCIIEncoding))
        [IO.File]::WriteAllText($tokenFile, $token, (New-Object Text.ASCIIEncoding))

        $powershell = Join-Path $PSHOME 'powershell.exe'
        $installerArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer,
            '-PlatformServerHost', $serverHost, '-PlatformServerPort', [string]$serverPort,
            '-PlatformCaFile', $caFile, '-PlatformCaSha256', $caSha, '-BootstrapTokenFile', $tokenFile)${o.unsigned ? "\n        $installerArgs += '-AllowUnsigned'" : ""}
        & $powershell @installerArgs
        $code = $LASTEXITCODE
    } finally {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($code -ne 0) { Stop-Install ('the agent installer stopped with exit code ' + $code + '; its output is above.') 'Send this output to support.' }
    Write-Output 'Installed. The cabinet now waits for approval in the console, under Pending cabinets.'
    exit 0
} catch {
    Stop-Install $_.Exception.Message 'Send this output to support.'
}
`;
}
