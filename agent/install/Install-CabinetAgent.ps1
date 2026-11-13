<#
.SYNOPSIS
  Installs the cabinet agent's two services on this machine (milestone 1: no server connection yet).
.DESCRIPTION
 - CabinetAgentBroker runs as LocalSystem and never opens a network connection.
 - CabinetAgentNetwork runs as its own virtual account (NT SERVICE\CabinetAgentNetwork),
    with no administrator rights and only the privileges it needs.
 - The local configuration is written to C:\ProgramData\Mashura\CabinetAgent, which only
    SYSTEM and Administrators can change. The network service can read it, and can write only
    its own state and log folders.
 - Running this again on an installed cabinet keeps its identity: the cabinet ID, the platform
    server it talks to, the scanner and sync settings and the bootstrap token already on the
    machine are kept unless this run gives them. Give -CabinetId to replace the identity.
 - Read-only mode is kept on a reinstall unless -ReadOnly (on) or -ReadWrite (off) is given.
 - The published programs must be in a folder only SYSTEM and Administrators can change (the console's installer
    unpacks into such a folder); they are copied into a new folder under Program Files, and that copy is what is
    signature-checked and installed.
 - The package's architecture has to suit this machine's Windows: a 64-bit package cannot start on 32-bit Windows, and
    a 32-bit package is refused on 64-bit Windows. -AllowArchitectureMismatch lifts that second refusal for development
    and demo work, so the 32-bit agent can be exercised on a 64-bit cabinet. Everything downstream follows the
    architecture the agent reports (contracts/schemas/common.schema.json #/$defs/architecture), so updates stay on the
    architecture that is installed; the console's generated installer is the one part that reads this machine's Windows
    instead, and it would put the other architecture back.
  Run from an elevated PowerShell, after Publish-CabinetAgent.ps1.
  Every failure stops the install at the point it happened and prints four lines the operator can act on: what happened,
  the log folder on that cabinet, the state folder, and what to do next. The script exits with 1 when it fails.
.EXAMPLE
  .\Install-CabinetAgent.ps1 -EnableLocalHarness
.EXAMPLE
  .\Install-CabinetAgent.ps1 -PlatformServerHost diag.mashura.example -PlatformServerPort 8443 -PlatformCaFile .\platform-ca.pem -PlatformCaSha256 3F... -BootstrapTokenFile .\bootstrap-token.txt
  Connects to the platform server. The token comes from platform-admin token create; it works once and is deleted after use.
  The SHA-256 is the one the console shows for the CA file; the installer refuses the file without it.
.EXAMPLE
  .\Install-CabinetAgent.ps1 -ScannerHardwareId 'USB\VID_1234&PID_5678' -SyncCabinetAddress 10.20.0.15 -AllowedTcpPort 1433 -ReadOnly
.EXAMPLE
  .\Install-CabinetAgent.ps1 -ReadWrite
  Reinstalls over an installed cabinet and turns read-only mode off; everything else is kept.
#>
[CmdletBinding()]
param(
    # Where the published programs are. Not given: <this script's folder>\..\out. It is worked out in the body, not here:
    # Windows PowerShell 5.1 fills in a parameter default before the script's own scope exists, so a default built from
    # $PSScriptRoot is empty when the script is started with -File and the script dies with 'Cannot bind argument to
    # parameter Path' instead of installing anything.
    [string] $SourceDir,
    # Not given: the cabinet keeps the ID it is already enrolled with, and a cabinet that has none gets a new one.
    [guid] $CabinetId,
    [switch] $ReadOnly,
    # Turns read-only mode off on a cabinet that has it (docs/spec/04-agent-spec.md: only reinstalling or a local
    # administrator changes it). Without -ReadOnly or -ReadWrite a reinstall keeps the mode the cabinet already has.
    [switch] $ReadWrite,
    [ValidateSet('sync', 'satellite', 'standalone')] [string] $CabinetRole,
    [string[]] $ScannerHardwareId = @(),
    [string] $SyncCabinetAddress,
    [string] $PlatformServerHost,
    [ValidateRange(1, 65535)] [int] $PlatformServerPort,
    [string] $PlatformCaFile,
    [ValidatePattern('^[A-Za-z0-9_-]{32,128}$')] [string] $BootstrapToken,
    # Preferred over -BootstrapToken: a token on the command line can be kept by process-creation auditing and script-block logging.
    [string] $BootstrapTokenFile,
    [ValidateRange(1, 65535)] [int[]] $AllowedTcpPort = @(),
    [switch] $EnableLocalHarness,
    # The SHA-256 of the platform CA file as the console shows it: the installer refuses a CA file that does not match,
    # and refuses to install a CA file or a platform server without it.
    [ValidatePattern('^[0-9A-Fa-f]{64}$')] [string] $PlatformCaSha256,
    # Development and demo builds are not code-signed. Production builds are, and are refused unless every program is.
    [switch] $AllowUnsigned,
    # Development and demo only: installs a 32-bit agent package on 64-bit Windows, so the 32-bit agent can be exercised
    # on a machine that has a 64-bit Windows to hand. The refusal it lifts exists for one reason: the console's generated
    # installer reads this machine's Windows when it picks an archive, so a mismatched agent is replaced by the other
    # architecture the next time that installer runs. The platform follows the architecture the agent reports
    # (server/migrations/0007_architecture.sql), so updates, releases and rollouts stay on the installed architecture
    # either way. Nothing lifts the opposite case: a 64-bit program cannot run on 32-bit Windows at all.
    [switch] $AllowArchitectureMismatch,
    # Throwaway CI machines only: skips the check that only SYSTEM and administrators can change the source folder.
    [switch] $SkipSourceFolderCheck
)
$ErrorActionPreference = 'Stop'
# The copy of the programs this run checks and installs from (step 0); removed when the run ends, whatever happens.
$incoming = $null

# Where everything lives. These are plain path expressions with no side effects, so they are worked out before anything
# can fail: the failure message at the bottom has to be able to name the log folder even when the install stopped in
# its first few lines.
$broker = 'CabinetAgentBroker'
$network = 'CabinetAgentNetwork'
$networkAccount = "NT SERVICE\$network"
$programDir = Join-Path $env:ProgramFiles 'Mashura\CabinetAgent'
$dataDir = Join-Path $env:ProgramData 'Mashura\CabinetAgent'
$logDir = Join-Path $dataDir 'logs'
$sc = Join-Path $env:SystemRoot 'System32\sc.exe'
$servicesStopped = $false

# Everything from here down runs inside one failure funnel. Each check below throws a sentence that says what happened
# and what to do about it; this funnel is what turns a throw into that sentence and an exit code, instead of a
# PowerShell stack trace nobody on a support call can read.
try {

function Get-PeMachine([string] $Path) {
    # The Machine field of the PE header: 0x014c is 32-bit, 0x8664 is 64-bit, 0xAA64 is ARM64. Reading it is the only
    # way to know what a published program is really built for (the file name says nothing). A file that cannot be read
    # as a program is reported as the damaged archive it is, rather than as a .NET read error.
    $stream = [IO.File]::OpenRead($Path)
    try {
        $reader = New-Object IO.BinaryReader($stream)
        if ($stream.Length -lt 0x40) { throw "it is only $($stream.Length) bytes long" }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadInt32()
        if ($peOffset -lt 0x40 -or ($peOffset + 6) -gt $stream.Length) { throw "its header points at offset $peOffset in a $($stream.Length) byte file" }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) { throw 'it does not start with a Windows program header' }
        return $reader.ReadUInt16()
    } catch {
        throw "The agent program '$Path' could not be read: $($_.Exception.Message). The archive is incomplete or damaged - download it again from the console's Setup page and unpack it fresh."
    } finally { $stream.Dispose() }
}

# Whether the published programs can run on this machine, decided from the PE machine of those programs and from this
# machine's Windows alone, so it can be exercised without installing anything. Returns $null when the package suits the
# machine and a sentence to warn the operator with when a mismatch was asked for on purpose (-AllowArchitectureMismatch);
# throws the line to show the operator when the package cannot be installed here at all.
function Assert-PackageArchitecture([int] $Machine, [bool] $Is64BitOperatingSystem, [bool] $AllowArchitectureMismatch) {
    if ($Machine -eq 0x8664) {
        # A 64-bit program cannot start on 32-bit Windows and no switch can change that: the Windows loader refuses it.
        if (-not $Is64BitOperatingSystem) {
            throw "This is the 64-bit agent package and this cabinet is 32-bit Windows, so the agent's programs cannot start here. A 32-bit agent build has to be published for this cabinet: send this line to support and install the 32-bit package when it is available."
        }
        return $null
    }
    if ($Machine -eq 0x14c) {
        if (-not $Is64BitOperatingSystem) { return $null }
        if (-not $AllowArchitectureMismatch) {
            throw "This is the 32-bit agent package and this cabinet is 64-bit Windows. Install the 64-bit package (CabinetAgent-win-x64.zip) instead, or pass -AllowArchitectureMismatch to run the 32-bit agent on this machine on purpose (development and demo only): the platform follows the architecture the agent reports, but the console's generated installer reads this machine's Windows when it picks an archive, so it would put the 64-bit agent back."
        }
        return "Installing the 32-bit agent package on 64-bit Windows, because -AllowArchitectureMismatch was given. The platform will record this cabinet as windows-x86 and offer it 32-bit releases. Never do this on a production cabinet."
    }
    if ($Machine -eq 0xAA64) {
        throw 'This is the ARM64 agent package and ARM64 cabinets are not supported. Use the 64-bit package on a 64-bit Intel or AMD cabinet: this machine reports ARM64, so send this line to support.'
    }
    throw "The agent programs are built for an architecture this installer does not know (PE machine 0x$('{0:X4}' -f $Machine)). Unpack the archive again and run again; if it keeps happening, send this line to support."
}

if ($ReadOnly -and $ReadWrite) { throw 'Give -ReadOnly or -ReadWrite, not both: -ReadOnly turns read-only mode on, -ReadWrite turns it off.' }
if ($BootstrapTokenFile) {
    if ($BootstrapToken) { throw 'Give -BootstrapToken or -BootstrapTokenFile, not both.' }
    if (-not (Test-Path -LiteralPath $BootstrapTokenFile -PathType Leaf)) {
        throw "The token file '$BootstrapTokenFile' is not on this machine. Use the installer from the console's Setup page, which brings its own token, or give the full path to the token file and run again."
    }
    $BootstrapToken = (Get-Content -LiteralPath $BootstrapTokenFile -Raw).Trim()
    if ($BootstrapToken -notmatch '^[A-Za-z0-9_-]{32,128}$') { throw "The file '$BootstrapTokenFile' does not hold a bootstrap token. Create a new installer on the console's Setup page; a token is 32 to 128 letters, digits, dashes and underscores." }
}
if ($PlatformCaFile -and -not (Test-Path -LiteralPath $PlatformCaFile -PathType Leaf)) {
    throw "The platform CA file '$PlatformCaFile' is not on this machine. Use the installer from the console's Setup page, which brings the CA with it, or give the full path to the CA file and run again."
}

# A 32-bit PowerShell on 64-bit Windows sees C:\Program Files (x86) as Program Files and a redirected System32, so the
# agent would be installed in the wrong place. The console's installer always starts the 64-bit one.
if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
    throw 'This is the 32-bit PowerShell on 64-bit Windows. Open Windows PowerShell (not "Windows PowerShell (x86)") as administrator and run again, or use the installer from the console, which picks the right one.'
}
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this script from an elevated PowerShell: right-click Windows PowerShell (or PowerShell 7) and choose Run as administrator, then run the same command again.' }

# The default source folder, resolved where $PSScriptRoot and $PSCommandPath are certainly set (see the note on the
# parameter): the same command then works whether it is typed in a window, run with -File, or run with -Command, on
# Windows PowerShell 5.1 and on PowerShell 7.
if (-not $SourceDir) {
    $scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
    $SourceDir = Join-Path $scriptRoot '..\out'
}
if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) {
    throw "The published agent is not in '$SourceDir'. Use the installer from the console's Setup page, or unpack the agent archive for this Windows (CabinetAgent-win-x86.zip or CabinetAgent-win-x64.zip) and run the install script from inside the folder it unpacks to, or pass -SourceDir with the folder that holds the Cabinet.Agent.* folders."
}

# 0a. This machine. Two things decide whether the agent can run here at all, and both are checked before anything is
# copied: the Windows build (.NET 10 needs Windows 10 1607 or newer, so Windows 7 and 8.1 cannot run the agent) and the
# architecture (the published programs are built for one architecture, and the wrong one cannot start at all).
$currentVersion = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
$buildNumber = 0
if ($currentVersion -and $currentVersion.CurrentBuildNumber) { $buildNumber = [int]$currentVersion.CurrentBuildNumber }
$windowsName = if ($currentVersion -and $currentVersion.ProductName) { $currentVersion.ProductName } else { [Environment]::OSVersion.VersionString }
if ($buildNumber -lt 14393) {
    throw "This cabinet runs Windows build $buildNumber ($windowsName). The agent is a .NET 10 program and .NET 10 needs Windows 10 version 1607 (build 14393) or newer, so the agent cannot run on Windows 7 or 8.1 at all. This cabinet needs a different build of the agent: send this line to support rather than installing."
}

$brokerProgram = Join-Path $SourceDir 'Cabinet.Agent.Broker\Cabinet.Agent.Broker.exe'
if (-not (Test-Path -LiteralPath $brokerProgram -PathType Leaf)) {
    throw "The agent programs are not in '$SourceDir' (Cabinet.Agent.Broker\Cabinet.Agent.Broker.exe is missing). Unpack the whole archive, not just the install folder, and run again."
}
$packageMachine = Get-PeMachine $brokerProgram
$architectureNote = Assert-PackageArchitecture -Machine $packageMachine -Is64BitOperatingSystem ([Environment]::Is64BitOperatingSystem) -AllowArchitectureMismatch $AllowArchitectureMismatch.IsPresent
if ($architectureNote) { Write-Warning $architectureNote }

# 0. What is about to be installed as LocalSystem must be what was published.
# - Nothing in the source folder may be a link (it could point anywhere), and only SYSTEM, Administrators and
#   TrustedInstaller may be able to change it or own it. That includes the account running this script: an
#   administrator's own Downloads folder is writable by that same account WITHOUT elevation, so any program the
#   operator runs unelevated could swap a file between this check and the copy. The console's installer and its
#   manual steps unpack into a new folder that only SYSTEM and Administrators can change; use that, or C:\Program Files.
$sourceFull = (Resolve-Path -LiteralPath $SourceDir).Path
$sourceItems = @(Get-Item -LiteralPath $sourceFull -Force) + @(Get-ChildItem -LiteralPath $sourceFull -Recurse -Force)
foreach ($item in $sourceItems) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$($item.FullName) is a link, not a file or folder. Unpack the agent archive again with the console's installer and run again." }
}
$trustedSids = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')   # SYSTEM, Administrators, TrustedInstaller
# The rights that let someone change a file or folder: write or append data (create files and folders), delete, delete
# children, change permissions, take ownership, and the generic write and all rights an inheritable entry can carry.
$changeRights = [int64]0x500D0046
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Get-Sid($Reference) { try { $Reference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { '' } }
if (-not $SkipSourceFolderCheck) { foreach ($item in $sourceItems) {
    $acl = Get-Acl -LiteralPath $item.FullName
    $owner = Get-Sid $acl.GetOwner([Security.Principal.SecurityIdentifier])
    if ($trustedSids -notcontains $owner) {
        $who = if ($owner -eq $currentSid) { 'your own account (without administrator rights)' } else { $owner }
        throw "$($item.FullName) is owned by $who, so it can be changed without administrator rights. Install with the console's installer (it unpacks into a folder only administrators can change), or unpack into a folder under C:\Program Files, then run again."
    }
    foreach ($rule in $acl.Access) {
        if ($rule.AccessControlType -ne 'Allow') { continue }
        if ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }   # applies to children, each checked itself
        $sid = Get-Sid $rule.IdentityReference
        if ($trustedSids -contains $sid) { continue }
        if (([int64]$rule.FileSystemRights -band $changeRights) -ne 0) {
            $who = if ($sid -eq $currentSid) { 'your own account (without administrator rights)' } elseif ($sid) { $sid } else { $rule.IdentityReference.Value }
            throw "$($item.FullName) can be changed by $who. Only SYSTEM and administrators may be able to change what is installed. Install with the console's installer (it unpacks into a folder only administrators can change), or unpack into a folder under C:\Program Files, then run again."
        }
    }
} }

# - The programs are copied into a new folder under C:\Program Files (only administrators can change it) and every check
#   from here on reads that copy, which is also what is installed: a file swapped in the source after this point is not
#   the file that runs.
$incoming = Join-Path $env:ProgramFiles ('Mashura\CabinetAgent.incoming-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $incoming | Out-Null
foreach ($project in 'Cabinet.Agent.Broker', 'Cabinet.Agent.Network', 'Cabinet.Agent.Harness', 'Cabinet.Agent.Updater') {
    $from = Join-Path $sourceFull $project
    if (-not (Test-Path -LiteralPath $from -PathType Container)) { throw "The agent archive is incomplete: '$from' is missing. Unpack the whole archive again (the folder that holds Cabinet.Agent.Broker, Cabinet.Agent.Network, Cabinet.Agent.Harness and Cabinet.Agent.Updater) and run again." }
    Copy-Item -LiteralPath $from -Destination (Join-Path $incoming $project) -Recurse
}
# - Every program must carry a valid Authenticode signature, unless this is a development or demo build.
# -File is required: on Windows PowerShell 5.1, -Include also returns matching *directories*,
# and Get-AuthenticodeSignature cannot take a directory.
$unsigned = Get-ChildItem -LiteralPath $incoming -Recurse -File -Include '*.exe', '*.dll' | Where-Object { (Get-AuthenticodeSignature -LiteralPath $_.FullName).Status -ne 'Valid' }
if ($unsigned) {
    if (-not $AllowUnsigned) { throw "$(@($unsigned).Count) programs are not code-signed (first: $(@($unsigned)[0].Name)). Production builds are signed; for a development or demo build, run again with -AllowUnsigned." }
    Write-Warning "Installing an unsigned development or demo build ($(@($unsigned).Count) programs). Never do this on a production cabinet."
}
# - The platform CA must be the one the console showed. A CA file pinned without its fingerprint is a trust anchor the
#    installer cannot vouch for, so it is refused rather than warned about: nothing may quietly become the cabinet's
#    trust anchor unchecked.
if ($PlatformCaFile -or $PlatformServerHost) {
    if (-not $PlatformCaSha256) {
        throw 'Give -PlatformCaSha256 (the CA file''s SHA-256 exactly as the console shows it). Without it the platform CA cannot be checked against the console, and an unchecked CA file would become the cabinet''s trust anchor. Get it from the console and run again.'
    }
}
if ($PlatformCaFile) {
    $caHash = (Get-FileHash -LiteralPath $PlatformCaFile -Algorithm SHA256).Hash
    if ($caHash -ne $PlatformCaSha256.ToUpperInvariant()) { throw "platform-ca.pem does not match the console (its SHA-256 is $caHash). Download it again from the console." }
}

function Invoke-Sc([string[]] $Arguments) {
    # sc.exe reports why it refused on standard error, so the reason is captured and quoted back: 'failed with 5' on its
    # own tells a support call nothing. $ErrorActionPreference is relaxed around the call because Windows PowerShell 5.1
    # turns a native command's standard-error output into a terminating error while it is 'Stop'.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = & $sc @Arguments 2>&1 | Out-String
    $ErrorActionPreference = $previous
    if ($LASTEXITCODE -ne 0) {
        throw "The Windows service command 'sc.exe $($Arguments -join ' ')' failed with exit code ${LASTEXITCODE}: $(($output -replace '\s+', ' ').Trim()) Run this from an elevated PowerShell; if it keeps failing, send this line to support."
    }
}

# 1. Program files (inherit the Program Files ACL: only administrators can change them), from the checked copy.
foreach ($service in @{ Name = $broker; Project = 'Cabinet.Agent.Broker' }, @{ Name = $network; Project = 'Cabinet.Agent.Network' }, @{ Name = 'harness'; Project = 'Cabinet.Agent.Harness' }, @{ Name = 'updater'; Project = 'Cabinet.Agent.Updater' }) {
    $from = Join-Path $incoming $service.Project
    if (-not (Test-Path $from)) { throw "The agent archive is incomplete: '$from' is missing. Unpack the whole archive again (the folder that holds Cabinet.Agent.Broker, Cabinet.Agent.Network, Cabinet.Agent.Harness and Cabinet.Agent.Updater) and run again." }
    $to = Join-Path $programDir $service.Project
    if (Get-Service -Name $service.Name -ErrorAction SilentlyContinue) {
        $servicesStopped = $true
        Stop-Service -Name $service.Name -Force -ErrorAction SilentlyContinue
        if ((Get-Service -Name $service.Name).Status -ne 'Stopped') {
            throw "The $($service.Name) service will not stop, so its program files cannot be replaced. Open services.msc, stop '$($service.Name)' by hand (or restart the cabinet), then run this script again."
        }
    }
    New-Item -ItemType Directory -Force -Path $to | Out-Null
    try {
        Copy-Item -Path (Join-Path $from '*') -Destination $to -Recurse -Force
    } catch {
        throw "The agent's files could not be copied into '$to': $($_.Exception.Message) Something is holding a file open - stop the $($service.Name) service (and any agent window left open) and run again."
    }
}

# The uninstaller stays on the cabinet, because the folder the agent was installed from is gone. It sits one level above
# the programs, which an upgrade replaces as a whole; C:\Program Files keeps it changeable by administrators only.
$installDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
$uninstaller = Join-Path $installDir 'Uninstall-CabinetAgent.ps1'
if (Test-Path -LiteralPath $uninstaller -PathType Leaf) { Copy-Item -LiteralPath $uninstaller -Destination (Join-Path (Split-Path $programDir -Parent) 'Uninstall-CabinetAgent.ps1') -Force }
# The read-only acceptance check stays beside it, so a cabinet can be checked after install from a remote management tool.
$acceptance = Join-Path $installDir 'Test-CabinetAgent.ps1'
if (Test-Path -LiteralPath $acceptance -PathType Leaf) { Copy-Item -LiteralPath $acceptance -Destination (Join-Path (Split-Path $programDir -Parent) 'Test-CabinetAgent.ps1') -Force }

# 2. Services. The network service depends on the broker and runs as its virtual account.
$brokerExe = Join-Path $programDir 'Cabinet.Agent.Broker\Cabinet.Agent.Broker.exe'
$networkExe = Join-Path $programDir 'Cabinet.Agent.Network\Cabinet.Agent.Network.exe'
if (-not (Get-Service -Name $broker -ErrorAction SilentlyContinue)) {
    New-Service -Name $broker -BinaryPathName "`"$brokerExe`"" -DisplayName 'Mashura Cabinet Agent Broker' -StartupType Automatic `
        -Description 'Performs the cabinet agent''s privileged reads. Accepts requests only from the agent network service over a local pipe.' | Out-Null
}
if (-not (Get-Service -Name $network -ErrorAction SilentlyContinue)) {
    New-Service -Name $network -BinaryPathName "`"$networkExe`"" -DisplayName 'Mashura Cabinet Agent' -StartupType Automatic -DependsOn $broker `
        -Description 'Cabinet diagnostics agent. Runs without administrator rights.' | Out-Null
}
Invoke-Sc @('config', $network, 'obj=', $networkAccount)
Invoke-Sc @('sidtype', $network, 'unrestricted')
# Only the privilege every process needs; everything else is removed from the network service's token.
Invoke-Sc @('privs', $network, 'SeChangeNotifyPrivilege')
foreach ($name in $broker, $network) { Invoke-Sc @('failure', $name, 'reset=', '86400', 'actions=', 'restart/60000/restart/60000/restart/300000') }

# The cabinet's private key: generated here, on the cabinet, in the machine key store, non-exportable.
# Only the network service (and SYSTEM and administrators) may use it; the service cannot create machine keys itself.
# An installed machine key is kept: this only creates one when there is none, and re-states who may use it.
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'   # the harness writes its reason to standard error; 5.1 must not turn that into a throw
$provisionOutput = & (Join-Path $programDir 'Cabinet.Agent.Harness\cabinet-harness.exe') provision-key 2>&1 | Out-String
$ErrorActionPreference = $previousPreference
if ($LASTEXITCODE -ne 0) {
    $reason = ($provisionOutput -replace '\s+', ' ').Trim()
    if (-not $reason) { $reason = 'the harness printed no reason' }
    throw "Creating the cabinet's private key failed: $reason (exit code $LASTEXITCODE). The key is made in this machine's key store and the agent cannot enrol without it. Run this script again from an elevated PowerShell; if it keeps failing, send this line to support together with the files in '$dataDir\logs'."
}

# 3. Data folder: SYSTEM and Administrators own it; the network service gets only what it needs.
function New-Rule([string] $Account, [string] $Rights, [bool] $Inherit = $true) {
    $flags = if ($Inherit) { 'ContainerInherit,ObjectInherit' } else { 'None' }
    New-Object Security.AccessControl.FileSystemAccessRule($Account, $Rights, $flags, 'None', 'Allow')
}
function Set-FolderAcl([string] $Path, [object[]] $Rules) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    $acl.AddAccessRule((New-Rule 'NT AUTHORITY\SYSTEM' 'FullControl'))
    $acl.AddAccessRule((New-Rule 'BUILTIN\Administrators' 'FullControl'))
    foreach ($rule in $Rules) { $acl.AddAccessRule($rule) }
    Set-Acl -Path $Path -AclObject $acl
}
# ProgramData lets any user create folders, so a folder made before the install could be owned by someone else, who could
# then swap its contents. Refuse a Mashura folder that is a link or not owned by SYSTEM or Administrators, then lock it down.
$mashuraDir = Split-Path $dataDir -Parent
foreach ($dir in @($mashuraDir, $dataDir)) {
    $item = Get-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue
    if ($item) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$dir is a link, not a folder. Remove it and install again." }
        $owner = (Get-Acl -LiteralPath $dir).GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($owner -notin @('S-1-5-18', 'S-1-5-32-544')) { throw "$dir is owned by $owner, not SYSTEM or Administrators. Remove it and install again." }
    }
}
Set-FolderAcl $mashuraDir @()
Set-FolderAcl $dataDir @((New-Rule $networkAccount 'ReadAndExecute' $false))
Set-FolderAcl (Join-Path $dataDir 'state') @((New-Rule $networkAccount 'Modify'))
Set-FolderAcl (Join-Path $dataDir 'logs') @((New-Rule $networkAccount 'Modify'))
Set-FolderAcl (Join-Path $dataDir 'harness') @((New-Rule $networkAccount 'ReadAndExecute' $false))
Set-FolderAcl (Join-Path $dataDir 'harness\inbox') @((New-Rule $networkAccount 'Modify'))
Set-FolderAcl (Join-Path $dataDir 'harness\outbox') @((New-Rule $networkAccount 'Modify'))

# 4. Local configuration. The agent validates it against agent-config.schema.json and refuses to start if it does not match.
# Installing again on an enrolled cabinet must not strand it: the cabinet ID it is enrolled with, the server it talks to
# and the settings nobody named this time are all kept, and only a parameter given now replaces one. -CabinetId replaces
# the identity outright.
$configPath = Join-Path $dataDir 'agent-config.json'
$installed = $null
$configItem = Get-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue
if ($configItem) {
    if ($configItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$configPath is a link, not a file. Remove it and install again." }
    # A configuration the agent accepted, so every field below is in it (agent-config.schema.json). A file that cannot
    # be read is named here rather than left to fail later on the first missing field.
    try {
        $installed = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    } catch {
        throw "The agent configuration already on this cabinet ('$configPath') cannot be read: $($_.Exception.Message) Repair that file, or delete it and run this script again with a fresh token from the console's Setup page -  deleting it also discards this cabinet's identity, so the platform then sees this cabinet as a new one."
    }
}
# A parameter that was not given is $null, not [guid]::Empty, so both have to be treated as 'no ID given'.
if (-not $CabinetId -or $CabinetId -eq [guid]::Empty) {
    $CabinetId = if ($installed -and $installed.cabinetId) { [guid]$installed.cabinetId } else { [guid]::NewGuid() }
}
# An empty array written as an if/else expression collapses to nothing in Windows PowerShell 5.1, and ConvertTo-Json then
# writes it as an object ('{}'), which agent-config.schema.json refuses as 'type' for both of these: build them first.
$hardwareIds = @($ScannerHardwareId | Where-Object { $_ })
if ($hardwareIds.Count -eq 0 -and $installed) { $hardwareIds = @($installed.scanner.hardwareIds | Where-Object { $_ }) }
$tcpPorts = @($AllowedTcpPort | Where-Object { $_ })
if ($tcpPorts.Count -eq 0 -and $installed) { $tcpPorts = @($installed.allowedTcpPorts | Where-Object { $_ }) }
$config = [ordered]@{
    cabinetId       = $CabinetId.ToString()
    readOnlyMode    = if ($ReadOnly) { $true } elseif ($ReadWrite) { $false } elseif ($installed) { [bool]$installed.readOnlyMode } else { $false }
    cabinetRole     = if ($CabinetRole) { $CabinetRole } elseif ($installed) { $installed.cabinetRole } else { $null }
    scanner         = [ordered]@{ hardwareIds = @($hardwareIds) }
    syncCabinet     = [ordered]@{ address = if ($SyncCabinetAddress) { $SyncCabinetAddress } elseif ($installed) { $installed.syncCabinet.address } else { $null } }
    platformServer  = [ordered]@{
        host = if ($PlatformServerHost) { $PlatformServerHost } elseif ($installed) { $installed.platformServer.host } else { $null }
        port = if ($PlatformServerPort) { $PlatformServerPort } elseif ($installed) { $installed.platformServer.port } else { $null }
    }
    allowedTcpPorts = @($tcpPorts)
    localHarness    = if ($EnableLocalHarness) { $true } elseif ($installed) { [bool]$installed.localHarness } else { $false }
}
$json = ConvertTo-Json -InputObject $config -Depth 4
[IO.File]::WriteAllText($configPath, $json, (New-Object Text.UTF8Encoding($false)))
$fileAcl = New-Object Security.AccessControl.FileSecurity
$fileAcl.SetAccessRuleProtection($true, $false)
$fileAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('NT AUTHORITY\SYSTEM', 'FullControl', 'Allow')))
$fileAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('BUILTIN\Administrators', 'FullControl', 'Allow')))
$fileAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($networkAccount, 'Read', 'Allow')))
Set-Acl -Path $configPath -AclObject $fileAcl

# 5. Platform server trust and the one-time bootstrap token.
if ($PlatformCaFile) {
    $caPath = Join-Path $dataDir 'platform-ca.pem'
    Copy-Item -Path $PlatformCaFile -Destination $caPath -Force
    Set-Acl -Path $caPath -AclObject $fileAcl   # administrators change it; the network service only reads it
}
if ($BootstrapToken) {
    # The state folder admits only SYSTEM, administrators and the network service, which deletes the token once the server accepts it.
    [IO.File]::WriteAllText((Join-Path $dataDir 'state\bootstrap-token'), $BootstrapToken, (New-Object Text.UTF8Encoding($false)))
    # The copy the administrator downloaded is no longer needed and must not be left where other people can read it.
    if ($BootstrapTokenFile) { Remove-Item -LiteralPath $BootstrapTokenFile -Force }
}
elseif (Test-Path -LiteralPath (Join-Path $dataDir 'state\bootstrap-token')) {
    # Enrolling again is what -BootstrapToken is for; this run gives none, so the one already waiting is left to be used.
    Write-Host 'A bootstrap token is already waiting in the state folder; it is kept.'
}

# 6. Start. A service that will not start is the failure an operator sees most often, and the reason is usually the
# agent's own log line about the configuration or the token, so the message points straight at it.
foreach ($name in $broker, $network) {
    try {
        Start-Service -Name $name
    } catch {
        throw "The $name service did not start: $($_.Exception.Message) The agent writes its own reason to '$logDir' -  read the newest file there (Get-ChildItem '$logDir' | Sort-Object LastWriteTime | Select-Object -Last 1 | Get-Content -Tail 40). If the service starts and stops again immediately, the usual causes are a configuration it refuses and a token that has already been used; both are named in that log."
    }
    if ((Get-Service -Name $name).Status -ne 'Running') {
        throw "The $name service did not reach the Running state (it is $((Get-Service -Name $name).Status)). Read the newest file in '$logDir' for the agent's own reason, and check the service's own record with 'sc.exe query $name'."
    }
}
Get-Service -Name $broker, $network | Format-Table -AutoSize Name, Status, StartType
Write-Host "Cabinet ID: $CabinetId"
# Both engines install the same agent; this line is what the console's help and a support call read back.
Write-Host "PowerShell used: $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition))"
Write-Host "Configuration: $configPath"
if ($installed) { Write-Host 'Kept the cabinet ID and every setting not given in this run from the existing configuration.' }
Write-Host "Logs: $logDir"
Write-Host "To remove the agent: $(Join-Path (Split-Path $programDir -Parent) 'Uninstall-CabinetAgent.ps1') -RemoveData"
if ($EnableLocalHarness) { Write-Host "Local harness inbox: $(Join-Path $dataDir 'harness\inbox')" }
}
catch {
    # One place, one format: what went wrong, where its evidence is, and what to do next. Nothing here is a stack trace.
    Write-Host ''
    Write-Host 'The cabinet agent was NOT installed.' -ForegroundColor Red
    Write-Host "  What happened : $($_.Exception.Message)"
    if ($_.InvocationInfo -and $_.InvocationInfo.ScriptLineNumber) { Write-Host "  Script line   : $($_.InvocationInfo.ScriptLineNumber)" }
    Write-Host "  Logs          : $logDir"
    Write-Host "  State         : $(Join-Path $dataDir 'state')"
    Write-Host "  Configuration : $dataDir\agent-config.json"
    if ($servicesStopped) {
        Write-Host '  Note          : the agent services were stopped during this run and the install did not finish. Start them again with'
        Write-Host "                  Start-Service $broker, $network"
        Write-Host '                  or reinstall the agent: a cabinet that is already enrolled keeps its identity.'
    }
    Write-Host '  Next step     : send the "What happened" line and the newest log file to support - the log names the cause in plain words.'
    Write-Host ''
    if ($incoming -and (Test-Path -LiteralPath $incoming)) { Remove-Item -LiteralPath $incoming -Recurse -Force -ErrorAction SilentlyContinue }
    exit 1
}
finally {
    # The checked copy has been installed (or the run failed): it is not left behind under Program Files.
    if ($incoming -and (Test-Path -LiteralPath $incoming)) { Remove-Item -LiteralPath $incoming -Recurse -Force -ErrorAction SilentlyContinue }
}
