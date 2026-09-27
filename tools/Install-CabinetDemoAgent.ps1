# First install on an authorized disposable Windows lab machine only.
# The ZIP has no credentials. The enrollment file arrives through a separate private channel.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$AgentZip,
    [Parameter(Mandatory=$true)][string]$EnrollmentFile,
    [Parameter(Mandatory=$true)][string]$ExpectedSha256,
    [Parameter(Mandatory=$true)][string]$ExpectedSourceCommit
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$serviceName = 'CabinetPlatformAgent'
$install = 'C:\Program Files\Mashura\CabinetAgent'
$endpoint = 'https://srv1522777.tail72f980.ts.net/'
$created = $false
$registered = $false

function Refuse([string]$reason) { throw "Install refused: $reason" }
function Check-Path([string]$path, [bool]$mustExist) {
    $full = [IO.Path]::GetFullPath($path)
    if ($full.StartsWith('\\')) { Refuse 'Network paths are not supported.' }
    $part = $full
    while ($part) {
        if (Test-Path -LiteralPath $part) {
            $item = Get-Item -LiteralPath $part -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse 'Reparse point in path.' }
        }
        $parent = [IO.Path]::GetDirectoryName($part)
        if (!$parent -or $parent -eq $part) { break }
        $part = $parent
    }
    if ($mustExist -and !(Test-Path -LiteralPath $full -PathType Leaf)) { Refuse 'Required input is missing.' }
    return $full
}
function Private-Acl([string]$path) {
    $acl = Get-Acl -LiteralPath $path
    if (!$acl.AreAccessRulesProtected) { Refuse 'Permissions still inherit from a parent.' }
    foreach ($rule in $acl.Access) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
        $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if ($sid -notin @('S-1-5-18','S-1-5-32-544')) { Refuse 'Unexpected principal can access a protected path.' }
    }
}
function Lock-Directory([string]$path) {
    & icacls.exe $path /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { Refuse 'Could not set private directory permissions.' }
    Private-Acl $path
}
function Lock-File([string]$path) {
    & icacls.exe $path /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { Refuse 'Could not set private file permissions.' }
    Private-Acl $path
}
function Unique-Object([System.Text.Json.JsonElement]$node) {
    if ($node.ValueKind -eq [System.Text.Json.JsonValueKind]::Object) {
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($property in $node.EnumerateObject()) {
            if (!$seen.Add($property.Name)) { Refuse 'Duplicate JSON property.' }
            Unique-Object $property.Value
        }
    } elseif ($node.ValueKind -eq [System.Text.Json.JsonValueKind]::Array) {
        foreach ($value in $node.EnumerateArray()) { Unique-Object $value }
    }
}
function Read-Json([byte[]]$bytes) {
    $document = [System.Text.Json.JsonDocument]::Parse([ReadOnlyMemory[byte]]::new($bytes))
    try {
        Unique-Object $document.RootElement
        return ($document.RootElement.GetRawText() | ConvertFrom-Json)
    } finally { $document.Dispose() }
}
function Valid-Name([string]$name) {
    if (!$name -or $name.Length -gt 240 -or $name.EndsWith('/')) { return $false }
    foreach ($part in $name.Split('/')) {
        if (!$part -or $part -in @('.','..') -or $part.EndsWith('.') -or $part.EndsWith(' ') -or
            $part.Split('.')[0] -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$' -or $part -match '[\\:\x00<>|"?*]') { return $false }
    }
    return $true
}

try {
    $principal = [Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
    if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Refuse 'Run from an elevated administrator PowerShell window.' }
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { Refuse 'Windows is required.' }
    if ($PSVersionTable.PSVersion.Major -lt 7) { Refuse 'PowerShell 7 is required for this helper.' }
    if ($ExpectedSha256 -cnotmatch '^[A-Fa-f0-9]{64}$' -or $ExpectedSourceCommit -cnotmatch '^[a-f0-9]{40}$') {
        Refuse 'Trusted package digest and source revision are required.'
    }
    $zipPath = Check-Path $AgentZip $true
    if ((Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash -cne $ExpectedSha256.ToUpperInvariant()) {
        Refuse 'Package digest differs from independently delivered release evidence.'
    }
    $tokenPath = Check-Path $EnrollmentFile $true
    if ($zipPath -eq $tokenPath) { Refuse 'Package and enrollment input must be separate.' }
    $target = Check-Path $install $false
    if (Test-Path -LiteralPath $target) { Refuse 'Install directory already exists; existing identities are never overwritten.' }
    if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { Refuse 'Service already exists.' }
    $existing = & sc.exe query $serviceName 2>&1
    if ($LASTEXITCODE -eq 0) { Refuse 'Service already exists.' }
    if ($LASTEXITCODE -ne 1060) { Refuse 'Could not establish that the service name is unused.' }
    $parent = Check-Path ([IO.Path]::GetDirectoryName($target)) $false
    if (Test-Path -LiteralPath $parent) { Private-Acl $parent }
    # The operator must place the token in a private directory. Never print its value.
    Private-Acl ([IO.Path]::GetDirectoryName($tokenPath))
    Private-Acl $tokenPath
    $tokenBytes = [IO.File]::ReadAllBytes($tokenPath)
    if ($tokenBytes.Length -gt 4096) { Refuse 'Enrollment file is too large.' }
    $token = Read-Json $tokenBytes
    if ($token.ServerBaseUrl -cne $endpoint -or $token.Token -cnotmatch '^[A-Fa-f0-9]{64}$' -or @($token.PSObject.Properties).Count -ne 4) {
        Refuse 'Enrollment file does not match the reviewed endpoint and token shape.'
    }
    $tokenDocument = [System.Text.Json.JsonDocument]::Parse([ReadOnlyMemory[byte]]::new($tokenBytes))
    try {
        $expiresText = $tokenDocument.RootElement.GetProperty('ExpiresUtc').GetString()
        $deviceExpiresText = $tokenDocument.RootElement.GetProperty('DeviceExpiresUtc').GetString()
        if ($expiresText -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?\+00:00$' -or
            $deviceExpiresText -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?\+00:00$') {
            Refuse 'Enrollment expiry metadata is invalid.'
        }
        $expires = [DateTimeOffset]::Parse($expiresText, [Globalization.CultureInfo]::InvariantCulture)
        $deviceExpires = [DateTimeOffset]::Parse($deviceExpiresText, [Globalization.CultureInfo]::InvariantCulture)
    } catch { Refuse 'Enrollment expiry metadata is invalid.' }
    finally { $tokenDocument.Dispose() }
    if ($expires -le [DateTimeOffset]::UtcNow -or $deviceExpires -le $expires -or $deviceExpires -le [DateTimeOffset]::UtcNow) {
        Refuse 'Enrollment is expired or its time bounds are invalid. Issue a fresh token; do not change the journal.'
    }
    $archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        $entries = @($archive.Entries)
        $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $bytesByName = @{}
        [long]$total = 0
        foreach ($entry in $entries) {
            if (!(Valid-Name $entry.FullName) -or !$names.Add($entry.FullName) -or
                $entry.FullName -match '(^|/)appsettings[^/]*\.json$' -and $entry.FullName -cne 'appsettings.json' -or
                (($entry.ExternalAttributes -shr 16) -band 0xF000) -notin @(0, 0x8000) -or
                (($entry.ExternalAttributes -band 0x400) -ne 0) -or $entry.Length -gt 104857600) {
                Refuse 'Unsafe or duplicate ZIP member.'
            }
            $total += $entry.Length
            if ($total -gt 1073741824) { Refuse 'ZIP content exceeds the size limit.' }
            $stream = $entry.Open()
            try {
                $memory = [IO.MemoryStream]::new()
                try {
                    $stream.CopyTo($memory)
                    $data = $memory.ToArray()
                } finally { $memory.Dispose() }
            } finally { $stream.Dispose() }
            if ($data.Length -ne $entry.Length) { Refuse 'ZIP member length mismatch.' }
            $bytesByName[$entry.FullName] = $data
        }
        if (!$names.Contains('kit-manifest.json') -or !$names.Contains('appsettings.json') -or !$names.Contains('CabinetPlatform.Agent.exe')) {
            Refuse 'Required ZIP member missing.'
        }
        $manifest = Read-Json $bytesByName['kit-manifest.json']
        if (@($manifest.PSObject.Properties).Count -ne 6 -or $manifest.schema -ne 1 -or
            $manifest.component -cne 'agent' -or $manifest.endpoint -cne $endpoint -or
            $manifest.signed -ne $false -or $manifest.sourceCommit -cne $ExpectedSourceCommit) {
            Refuse 'Invalid kit manifest.'
        }
        $hashes = @($manifest.sha256.PSObject.Properties)
        if ($hashes.Count -ne ($entries.Count - 1)) { Refuse 'Manifest membership differs from ZIP.' }
        foreach ($property in $hashes) {
            $name = $property.Name
            if ($name -ceq 'kit-manifest.json' -or !$names.Contains($name) -or $name -cnotin $bytesByName.Keys -or
                $property.Value -cnotmatch '^[A-F0-9]{64}$') { Refuse 'Invalid manifest member.' }
            $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytesByName[$name]))
            if ($digest -cne $property.Value) { Refuse 'ZIP hash mismatch.' }
        }
        $config = Read-Json $bytesByName['appsettings.json']
        $settings = $config.Agent
        if ($settings.ServerBaseUrl -cne $endpoint -or $settings.OfficeEnrollmentFile -cne 'office-enrollment.json' -or
            $settings.Actions.ExecutionMode -cne 'DiagnosticOnly' -or
            $settings.StateDirectory -cne 'C:/Program Files/Mashura/CabinetAgent/state' -or
            $settings.LogDirectory -cne 'C:/Program Files/Mashura/CabinetAgent/logs' -or
            $settings.Buffer.Directory -cne 'C:/Program Files/Mashura/CabinetAgent/buffer' -or
            $settings.Actions.DiagnosticBundleDirectory -cne 'C:/Program Files/Mashura/CabinetAgent/bundles') {
            Refuse 'Agent configuration differs from reviewed lab settings.'
        }
        $mashura = Check-Path 'C:\Program Files\Mashura' $false
        if (!(Test-Path -LiteralPath $mashura)) {
            New-Item -ItemType Directory -Path $mashura | Out-Null
            Lock-Directory $mashura
        } else { Private-Acl $mashura }
        New-Item -ItemType Directory -Path $target | Out-Null
        $created = $true
        Lock-Directory $target
        foreach ($entry in $entries) {
            if ($entry.FullName -ceq 'kit-manifest.json') { continue }
            $relative = $entry.FullName.Replace('/', '\')
            $file = [IO.Path]::GetFullPath([IO.Path]::Combine($target, $relative))
            if (!$file.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) { Refuse 'ZIP member escapes install directory.' }
            $directory = [IO.Path]::GetDirectoryName($file)
            if (!(Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
            Check-Path $directory $false | Out-Null
            Lock-Directory $directory
            [IO.File]::WriteAllBytes($file, $bytesByName[$entry.FullName])
            Lock-File $file
        }
        $provision = Join-Path $target 'office-enrollment.json'
        [IO.File]::WriteAllBytes($provision, $tokenBytes)
        Lock-File $provision
        foreach ($name in @('state','logs','buffer','bundles')) {
            $directory = Join-Path $target $name
            if (!(Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory | Out-Null }
            Lock-Directory $directory
        }
        $exe = Join-Path $target 'CabinetPlatform.Agent.exe'
        $quoted = '"' + $exe + '"'
        & sc.exe create $serviceName 'binPath=' $quoted 'DisplayName=' 'Mashura Cabinet Support Agent' 'start=' 'auto' 'obj=' 'LocalSystem' | Out-Null
        if ($LASTEXITCODE -ne 0) { Refuse 'Service registration failed.' }
        $registered = $true
        & sc.exe failure $serviceName 'reset=' '86400' 'actions=' 'restart/60000/restart/120000/restart/300000' | Out-Null
        if ($LASTEXITCODE -ne 0) { Refuse 'Service recovery setup failed; secure files and service remain for inspection.' }
        & sc.exe failureflag $serviceName 1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Refuse 'Service failure flag setup failed; secure files and service remain for inspection.' }
        $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
        if (!$service -or $service.StartName -ne 'LocalSystem' -or $service.PathName -ne $quoted -or $service.StartMode -ne 'Auto') {
            Refuse 'Registered service settings differ from the expected configuration.'
        }
        Start-Service -Name $serviceName
        Write-Output 'Service start requested. Check service, pending enrollment and human approval separately.'
    } finally { $archive.Dispose() }
} catch {
    if ($created -and !$registered -and !(Get-Service -Name $serviceName -ErrorAction SilentlyContinue)) {
        # Only this run's fresh directory can be removed. No service was started; no identity was created.
        Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
    }
    throw
}
