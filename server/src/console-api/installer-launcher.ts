// The installer the setup page hands an Admin for one cabinet: a .cmd they copy next to the agent packages (Downloads or a
// USB stick) and double-click. Everything else it needs travels inside it -- this server's host and port, the platform CA
// and its SHA-256, the SHA-256 of both agent packages, and a one-time install token -- so there is nothing to type, no
// PowerShell version or Windows architecture to choose, and one file per cabinet.
//
// It holds a token, like the token.txt it replaces: the token works once, expires, and a cabinet that uses it still waits
// for an Admin's approval. The file deletes itself after a successful install.
//
// What it does, in order, so that what is installed is exactly what this server published:
//   1. The batch part asks Windows for administrator rights (fltmc.exe by full path answers whether it has them) and
//      starts Windows PowerShell 5.1 by full path: every Windows 10 and 11 machine has it, 32-bit or 64-bit. On 64-bit
//      Windows it is always the 64-bit PowerShell (Sysnative from a 32-bit prompt), or C:\Program Files would be the
//      32-bit one.
//   2. A short bootstrap (plain text on the command line, not encoded: antivirus rules treat encoded commands as
//      obfuscation) creates a new, randomly named folder that only SYSTEM and Administrators can change, writes the
//      PowerShell part of this file into it, and runs it from there.
//   3. That part picks the package for this machine's Windows (32-bit or 64-bit), copies it into the protected folder,
//      checks the SHA-256 of the copy, unpacks only the copy, writes the CA and the token beside it, and runs the
//      installer it contains by its exact path. The protected folder is removed whatever happens.
// The batch part never interpolates a path into a command: the launcher's own path reaches PowerShell as an environment
// variable. ASCII only and CRLF line endings, and every line cmd.exe reads stays far below its 8,191-character limit.

export type LauncherPackage = { name: string; sha256: string } | null;

export type LauncherInput = {
  /** The package for each architecture this server has, by the file name the operator downloads. */
  packages: { "windows-x64": LauncherPackage; "windows-x86": LauncherPackage };
  /** Where the agent API answers, and the port it answers on. */
  host: string | null;
  port: number | null;
  /** The platform CA certificate (PEM) and its upper-case hex SHA-256. */
  caPem: string;
  caSha256: string;
  /** The one-time install token this file is made for. */
  token: string;
  /** Decided by the server: a development build is unsigned and the installer has to be told to accept it. */
  unsigned: boolean;
};

export const LAUNCHER_NAME = "Install-CabinetAgent.cmd";
/** Everything after this line is PowerShell; cmd.exe never reads it because the batch part ends with exit first. */
export const PAYLOAD_MARKER = "#CABINET-SETUP-PAYLOAD#";

export const HOST = /^[A-Za-z0-9.-]{1,253}$/;
export const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
export const SHA256 = /^[0-9a-f]{64}$/i;
const PACKAGE_NAME = /^[A-Za-z0-9._-]{1,80}\.zip$/;
export const PEM = /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]{100,8000}-----END CERTIFICATE-----\s*$/;

/** Refuses to build a file from a value that could close a quote: every value is checked against its exact shape. */
export function check(value: string | null | undefined, shape: RegExp, what: string): string {
  const v = (value ?? "").trim();
  if (!shape.test(v)) throw new Error(`the installer cannot be made: ${what} is not valid`);
  return v;
}

function packageLine(p: LauncherPackage): string {
  if (!p) return "$null";
  return `@{ Name = '${check(p.name, PACKAGE_NAME, "a package name")}'; Sha256 = '${check(p.sha256, SHA256, "a package SHA-256").toLowerCase()}' }`;
}

/** The PowerShell that runs elevated from the protected folder. Windows PowerShell 5.1 syntax only. */
export function launcherPayload(o: LauncherInput): string {
  const host = check(o.host, HOST, "the agent API host");
  const port = Number.isInteger(o.port) && (o.port ?? 0) > 0 && (o.port ?? 0) < 65536 ? o.port! : 8443;
  const caPem = check(o.caPem, PEM, "the platform CA").replace(/\r\n/g, "\n").trim();
  const caSha = check(o.caSha256, SHA256, "the platform CA SHA-256").toUpperCase();
  const token = check(o.token, TOKEN, "the install token");
  if (!o.packages["windows-x64"] && !o.packages["windows-x86"]) throw new Error("the installer cannot be made: this server has no agent package");

  return `param([Parameter(Mandatory = $true)] [string] $LauncherPath, [Parameter(Mandatory = $true)] [string] $Stage)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Stop-Setup([string] $What, [string] $How) {
    Write-Host ''
    Write-Host 'The agent was not installed.' -ForegroundColor Red
    Write-Host ('  What happened: ' + $What)
    Write-Host ('  What to do:    ' + $How)
    exit 1
}

$packages = @{
    'windows-x64' = ${packageLine(o.packages["windows-x64"])}
    'windows-x86' = ${packageLine(o.packages["windows-x86"])}
}
$serverHost = '${host}'
$serverPort = ${port}
$caSha = '${caSha}'
$token = '${token}'
$caPem = @'
${caPem}
'@

try {
    # 1. This machine's Windows, asked of Windows itself: a 32-bit PowerShell on 64-bit Windows would otherwise say x86.
    $architecture = if ([Environment]::Is64BitOperatingSystem) { 'windows-x64' } else { 'windows-x86' }
    $label = if ($architecture -eq 'windows-x64') { '64-bit' } else { '32-bit' }
    $pkg = $packages[$architecture]
    $windowsName = 'Windows'
    try { $windowsName = (Get-CimInstance Win32_OperatingSystem).Caption } catch { }
    Write-Host ('This computer: ' + $windowsName + ', ' + $label)
    if (-not $pkg) { Stop-Setup ('the server has no ' + $label + ' agent package.') 'Ask the platform administrator to publish it, then download a new installer.' }

    # 2. Find the package next to this installer or in Downloads. A browser may have renamed a second copy
    #    ("name (1).zip"), so every candidate is tried and the one whose SHA-256 matches is used.
    $folders = @((Split-Path -Parent $LauncherPath))
    if ($env:USERPROFILE) { $folders += (Join-Path $env:USERPROFILE 'Downloads') }
    $base = [IO.Path]::GetFileNameWithoutExtension($pkg.Name)
    $candidates = @()
    foreach ($folder in ($folders | Select-Object -Unique)) {
        if (Test-Path -LiteralPath $folder -PathType Container) {
            $candidates += @(Get-ChildItem -LiteralPath $folder -File -Filter ($base + '*.zip') -ErrorAction SilentlyContinue)
        }
    }
    if ($candidates.Count -eq 0) { Stop-Setup ($pkg.Name + ' is not next to this installer or in Downloads.') ('Download ' + $pkg.Name + ' from the console and put it in the same folder as this installer.') }

    # 3. Copy into the protected folder first, then check the copy: the file that is checked is the file that is unpacked.
    $zip = Join-Path $Stage 'agent.zip'
    $matched = $null
    foreach ($candidate in $candidates) {
        Copy-Item -LiteralPath $candidate.FullName -Destination $zip -Force
        if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -eq $pkg.Sha256) { $matched = $candidate.FullName; break }
    }
    if (-not $matched) { Stop-Setup ($pkg.Name + ' does not match this server (an older or incomplete download).') ('Download ' + $pkg.Name + ' again from the console, then run this installer again.') }
    Write-Host ('Package:       ' + $matched + ' (verified)')

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $unpacked = Join-Path $Stage 'agent'
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $unpacked)
    # Files made by an elevated administrator are normally owned by Administrators, but a machine policy can make the
    # person the owner instead, and the installer refuses anything a non-administrator owns.
    $admins = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
    foreach ($item in @(Get-Item -LiteralPath $unpacked) + @(Get-ChildItem -LiteralPath $unpacked -Recurse -Force)) {
        $acl = Get-Acl -LiteralPath $item.FullName
        $acl.SetOwner($admins)
        Set-Acl -LiteralPath $item.FullName -AclObject $acl
    }
    $installer = Join-Path $unpacked 'CabinetAgent\\install\\Install-CabinetAgent.ps1'
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { Stop-Setup 'the package does not contain the installer.' ('Download ' + $pkg.Name + ' again from the console.') }

    # 4. The CA and the token go beside it, inside the protected folder.
    $caFile = Join-Path $Stage 'platform-ca.pem'
    $tokenFile = Join-Path $Stage 'token.txt'
    [IO.File]::WriteAllText($caFile, $caPem + "\`n", (New-Object Text.ASCIIEncoding))
    [IO.File]::WriteAllText($tokenFile, $token, (New-Object Text.ASCIIEncoding))

    # 5. Install, with the same Windows PowerShell this runs in.
    Write-Host ''
    $powershell = Join-Path $PSHOME 'powershell.exe'
    $installerArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer,
        '-PlatformServerHost', $serverHost, '-PlatformServerPort', [string]$serverPort,
        '-PlatformCaFile', $caFile, '-PlatformCaSha256', $caSha, '-BootstrapTokenFile', $tokenFile)${o.unsigned ? "\n    $installerArgs += '-AllowUnsigned'" : ""}
    & $powershell @installerArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host ''
    Write-Host 'Installed. Approve this cabinet in the console under Pending cabinets.' -ForegroundColor Green
    exit 0
} catch {
    Stop-Setup $_.Exception.Message 'Send this message to support.'
}
`;
}

/**
 * The bootstrap the batch part runs elevated. It is short (cmd.exe's line limit), takes nothing from the command line,
 * and reads the launcher's path from the environment, so no path is ever spliced into code.
 */
export function bootstrapScript(): string {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "$self = $env:CABINET_LAUNCHER",
    "$text = [IO.File]::ReadAllText($self)",
    // The marker is written in two halves so that this line, which sits above the payload in the same file, never matches.
    `$at = $text.IndexOf('${PAYLOAD_MARKER.slice(0, 8)}' + '${PAYLOAD_MARKER.slice(8)}')`,
    "if ($at -lt 0) { Write-Host 'This installer file is incomplete. Download it again from the console.' -ForegroundColor Red; exit 1 }",
    "$payload = $text.Substring($at + " + PAYLOAD_MARKER.length + ").TrimStart()",
    // A new folder with a random name, owned by Administrators and changeable only by SYSTEM and Administrators, made
    // in one step with its permissions so there is no moment in which anyone else could write into it.
    "$sec = New-Object Security.AccessControl.DirectorySecurity",
    "$sec.SetAccessRuleProtection($true, $false)",
    "$sec.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))",
    "foreach ($sid in 'S-1-5-18', 'S-1-5-32-544') { $sec.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))) }",
    "$stage = Join-Path (Join-Path $env:SystemRoot 'Temp') ('CabinetSetup-' + [guid]::NewGuid().ToString('N'))",
    "if (Test-Path -LiteralPath $stage) { Write-Host 'Could not make a private setup folder. Run the installer again.' -ForegroundColor Red; exit 1 }",
    "[void][IO.Directory]::CreateDirectory($stage, $sec)",
    "$made = Get-Item -LiteralPath $stage -Force",
    "if (($made.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ((Get-Acl -LiteralPath $stage).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544')) { Write-Host 'Could not make a private setup folder. Run the installer again.' -ForegroundColor Red; exit 1 }",
    "$code = 1",
    "try {",
    "  $script = Join-Path $stage 'setup.ps1'",
    "  [IO.File]::WriteAllText($script, $payload, (New-Object Text.ASCIIEncoding))",
    "  & (Join-Path $PSHOME 'powershell.exe') -NoProfile -ExecutionPolicy Bypass -File $script -LauncherPath $self -Stage $stage",
    "  $code = $LASTEXITCODE",
    "} finally {",
    "  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue",
    "}",
    "exit $code",
  ];
  // It travels inside one double-quoted cmd.exe argument. Inside the quotes cmd.exe treats & | < > ^ as plain text; only a
  // double quote (which would end them) and % or ! (variable expansion) mean something to it, so those may not appear.
  for (const l of lines) if (/["%!]/.test(l)) throw new Error(`the bootstrap cannot carry ${JSON.stringify(l)}`);
  return lines.join("\n");
}

/** The whole file the operator saves: the batch part, then the PowerShell payload after the marker. */
export function launcherScript(o: LauncherInput): string {
  const payload = launcherPayload(o);
  const bootstrap = bootstrapScript().split("\n").map(l => l.trim()).join("; ");
  const batch = [
    "@echo off",
    "rem Mashura cabinet agent installer. Double-click it on the cabinet; it installs the agent and then deletes itself.",
    "rem It holds a one-time install token for one cabinet: do not share it.",
    "setlocal enableextensions",
    'set "CABINET_LAUNCHER=%~f0"',
    // 64-bit PowerShell on 64-bit Windows even from a 32-bit prompt (Sysnative), the only one on 32-bit Windows.
    'set "CABINET_PS=%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
    'if exist "%SystemRoot%\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe" set "CABINET_PS=%SystemRoot%\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe"',
    '"%SystemRoot%\\System32\\fltmc.exe" >nul 2>&1',
    "if not errorlevel 1 goto elevated",
    // Already asked once: Windows did not give the rights, so stop rather than ask again forever.
    'if /i "%~1"=="--elevated" goto noadmin',
    "echo Asking Windows for administrator rights...",
    // cmd.exe is elevated by its full path and given the launcher's path from the environment, quoted the way cmd /s /c
    // expects, so a path with spaces, parentheses or ampersands ("Install-CabinetAgent (1).cmd") runs as itself.
    String.raw`"%CABINET_PS%" -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') -Verb RunAs -ArgumentList ('/d /s /c \"\"' + $env:CABINET_LAUNCHER + '\" --elevated\"')"`,
    "exit /b 0",
    ":noadmin",
    "echo This installer needs administrator rights, and Windows did not give them. Sign in as an administrator and run it again.",
    "pause >nul",
    "exit /b 1",
    ":elevated",
    "echo Mashura cabinet agent setup",
    "echo.",
    `"%CABINET_PS%" -NoProfile -ExecutionPolicy Bypass -Command "${bootstrap}"`,
    'set "CABINET_EXIT=%ERRORLEVEL%"',
    "echo.",
    'if not "%CABINET_EXIT%"=="0" goto failed',
    "echo Press any key to close. This installer file deletes itself now: it held a one-time token.",
    "pause >nul",
    '(goto) 2>nul & del "%~f0"',
    ":failed",
    "echo Setup did not finish. Keep this window's text for support. This file still holds the install token; delete it if you will not retry.",
    "echo Press any key to close.",
    "pause >nul",
    "exit /b %CABINET_EXIT%",
    "",
    PAYLOAD_MARKER,
  ].join("\r\n");
  return batch + "\r\n" + payload.replace(/\r?\n/g, "\r\n");
}
