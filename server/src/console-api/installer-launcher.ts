// The one-click launcher: what the setup page hands an operator so that installing an agent on a cabinet is
// "double-click, approve", not "download, unzip, move three files, then paste a line".
//
// The console cannot run anything on the cabinet, so this is a generated .cmd the operator saves and runs. It carries
// the facts the console already knows -- this server's host and port, the CA's SHA-256, the package's SHA-256 -- so the
// file it checks and the value the installer trusts come from the console rather than from the operator's typing. It
// never carries a token: the token arrives as its own download or as a prompt, because a file containing one can be
// forwarded by mistake, and a forwarded token enrols a machine nobody meant to enrol.
//
// The launcher does what a careful operator would do by hand, in the order the console's manual steps describe: find
// the downloaded package, prove its SHA-256, unpack it into a temporary folder, put the token and the CA file where
// the installer reads them, run the installer with the arguments the console would have told them to type, and report.
// Every failure prints a What happened / What to do pair and exits non-zero, matching the installer's own funnel.
// ASCII only: Windows PowerShell 5.1 reads a BOM-less file as ANSI. CRLF line endings, because it is batch.

export type LauncherInput = {
  /** The file the operator downloaded from this page (one fixed name on this server). */
  packageName: string;
  /** Lower-case hex SHA-256 of that file, the same value the page shows. */
  packageSha256: string;
  /** Where the agent API answers, and the port it answers on. */
  host: string | null;
  port: number | null;
  /** Upper-case hex SHA-256 of the platform CA the installer is given. */
  caSha256: string;
  /** The development/demo build is unsigned, so the installer has to be told to accept it. */
  unsigned: boolean;
};

export const LAUNCHER_NAME = "Install-CabinetAgent.cmd";

/** A value placed inside a single-quoted PowerShell literal. Anything unexpected falls back to a safe default, so a
 *  hostile configuration cannot close the string and become code on the cabinet. */
function literal(value: string | null | undefined, allowed: RegExp, fallback: string): string {
  const v = (value ?? "").trim();
  return allowed.test(v) ? v : fallback;
}

export function launcherPayload(o: LauncherInput): string {
  const packageName = literal(o.packageName, /^[A-Za-z0-9 ._-]{1,80}$/, "CabinetAgent-win-x64.zip");
  const packageSha = literal(o.packageSha256, /^[0-9a-f]{64}$/i, "");
  const host = literal(o.host, /^[A-Za-z0-9.:-]{1,120}$/, "");
  const port = Number.isInteger(o.port) && (o.port ?? 0) > 0 && (o.port ?? 0) < 65536 ? String(o.port) : "8443";
  const caSha = literal(o.caSha256, /^[0-9a-f]{64}$/i, "");
  const extra = o.unsigned ? "\n$installerArgs += @('-AllowUnsigned')" : "";

  return `$ErrorActionPreference = 'Stop'

function Write-Failure {
  param([string]$What, [string]$How)
  Write-Host ''
  Write-Host 'What happened:' -ForegroundColor Red
  Write-Host ('  ' + $What)
  Write-Host 'What to do:' -ForegroundColor Yellow
  Write-Host ('  ' + $How)
  Write-Host ''
  exit 1
}

Write-Host ''
Write-Host 'Cabinet agent setup' -ForegroundColor Cyan
Write-Host 'This unpacks the agent package the console gave you and installs it on this machine.'
Write-Host ''

$packageName = '${packageName}'
$packageSha = '${packageSha}'
$caSha = '${caSha}'
$serverHost = '${host}'
$serverPort = '${port}'
$searchDirs = @()
if ($env:CABINET_LAUNCHER_DIR) { $searchDirs += $env:CABINET_LAUNCHER_DIR.TrimEnd('\\') }
if ($env:USERPROFILE) { $searchDirs += (Join-Path $env:USERPROFILE 'Downloads') }
$searchDirs = $searchDirs | Where-Object { $_ } | Select-Object -Unique

function Find-Input {
  param([string]$Name)
  foreach ($d in $searchDirs) {
    $p = Join-Path $d $Name
    if (Test-Path -LiteralPath $p -PathType Leaf) { return $p }
  }
  return $null
}

$zip = Find-Input $packageName
if (-not $zip) {
  Write-Failure ('the agent package ' + $packageName + ' is neither beside this launcher nor in ' + (Join-Path $env:USERPROFILE 'Downloads')) ('on the console setup page choose Download ' + $packageName + ', keep it in Downloads beside this launcher, and run this again.')
}
Write-Host ('Package:  ' + $zip)

$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
if ($hash -ne $packageSha) {
  Write-Failure ('the package does not match the SHA-256 the console shows; what is here hashes to ' + $hash) 'download the agent package again from the console setup page. A half-finished download or an older copy looks exactly like this.'
}
Write-Host 'Package matches the console.' -ForegroundColor Green

$stage = Join-Path $env:TEMP ('cabinet-setup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
try { [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $stage) }
catch { Write-Failure ('the agent package could not be unpacked: ' + $_.Exception.Message) 'download the agent package again from the console setup page.' }
Write-Host ('Unpacked: ' + $stage)

$installer = Get-ChildItem -LiteralPath $stage -Recurse -Filter 'Install-CabinetAgent.ps1' | Select-Object -First 1
if (-not $installer) {
  Write-Failure 'the package does not contain the installer (Install-CabinetAgent.ps1)' 'the download is not the agent package; download it again from the console setup page.'
}
$root = $stage
$candidate = Split-Path (Split-Path $installer.FullName -Parent) -Parent
if (Test-Path -LiteralPath (Join-Path $candidate 'out')) { $root = $candidate }

$ca = Find-Input 'platform-ca.pem'
if (-not $ca) { Write-Failure 'platform-ca.pem is neither beside this launcher nor in Downloads' 'on the console setup page choose Download platform-ca.pem, keep it beside this launcher, and run this again.' }
Copy-Item -LiteralPath $ca -Destination (Join-Path $root 'platform-ca.pem') -Force

$tokenFile = Find-Input 'token.txt'
if ($tokenFile) {
  $token = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
} else {
  Write-Host ''
  Write-Host 'No token.txt beside this launcher or in Downloads.' -ForegroundColor Yellow
  $token = (Read-Host 'Paste the install token from the console and press Enter').Trim()
}
if (-not $token) { Write-Failure 'no install token was provided' 'on the console setup page choose Create install token, copy the token it shows, and run this launcher again.' }
Set-Content -LiteralPath (Join-Path $root 'token.txt') -Value $token -Encoding ASCII

$installerArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer.FullName,
  '-PlatformServerHost', $serverHost,
  '-PlatformServerPort', $serverPort,
  '-PlatformCaFile', (Join-Path $root 'platform-ca.pem'),
  '-PlatformCaSha256', $caSha,
  '-BootstrapTokenFile', (Join-Path $root 'token.txt'))${extra}

Write-Host ''
Write-Host 'Installing. This takes a minute or two, and it prints what it is doing.' -ForegroundColor Cyan
Write-Host ''
& 'powershell.exe' @installerArgs
$code = $LASTEXITCODE
if ($code -ne 0) {
  Write-Failure ('the installer stopped, exit code ' + $code + ' - the lines above it say what happened and what to do') 'send those lines to support. The platform can push a corrected agent to a cabinet later, so a first install that fails is fixable without another visit.'
}

Write-Host ''
Write-Host 'Installed.' -ForegroundColor Green
Write-Host 'The cabinet is now asking to enrol. Approve it on the console under Pending cabinets.'
`;
}

/** The whole file the operator saves. Batch needs CRLF, and the PowerShell travels as base64 of UTF-16LE, which is
 *  what `-EncodedCommand` expects: that also keeps the file pure ASCII whatever the payload contains. */
export function launcherScript(o: LauncherInput): string {
  const payload = launcherPayload(o);
  const encoded = Buffer.from(payload, "utf16le").toString("base64");
  return [
    "@echo off",
    "rem Cabinet agent setup -- generated by the Mashura support console.",
    "rem Save it beside the agent package it names (Downloads is fine) and double-click it.",
    "setlocal enableextensions",
    'set "CABINET_LAUNCHER_DIR=%~dp0"',
    "net session >nul 2>&1",
    "if not errorlevel 1 goto elevated",
    "echo Asking Windows for administrator rights...",
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"`,
    "exit /b 0",
    ":elevated",
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
    'set "cabinet_setup_exit=%ERRORLEVEL%"',
    "echo.",
    'if not "%cabinet_setup_exit%"=="0" echo Setup did not finish. The lines above say what to do.',
    "echo Press any key to close this window.",
    "pause >nul",
    "exit /b %cabinet_setup_exit%",
    "",
  ].join("\r\n");
}
