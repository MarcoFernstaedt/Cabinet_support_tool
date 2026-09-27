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
$packageStream = $null

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
function Check-Acl([string]$path, [bool]$secret) {
    $acl = Get-Acl -LiteralPath $path
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $operator = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($owner -notin @('S-1-5-18','S-1-5-32-544',$operator,
        'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')) { Refuse "Untrusted owner: $path" }
    $mutation = [Security.AccessControl.FileSystemRights]::WriteData -bor
        [Security.AccessControl.FileSystemRights]::AppendData -bor
        [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    # TrustedInstaller may maintain executable ancestors, not enrollment secrets.
    $trustedAncestor = @('S-1-5-18','S-1-5-32-544',
        'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
        $sid = $rule.IdentityReference.Value
        if ($sid -notin @('S-1-5-18','S-1-5-32-544') -and
            ($secret -or ($sid -notin $trustedAncestor -and (($rule.FileSystemRights -band $mutation) -ne 0)))) {
            Refuse "Untrusted access on $path for $sid"
        }
    }
}
function Lock-Directory([string]$path) {
    & icacls.exe $path /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { Refuse 'Could not set private directory permissions.' }
    Check-Acl $path $true
}
function Lock-File([string]$path) {
    & icacls.exe $path /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { Refuse 'Could not set private file permissions.' }
    Check-Acl $path $true
}
function Json-Value([string[]]$tokens, [ref]$position, [int]$depth) {
    if ($depth -gt 64 -or $position.Value -ge $tokens.Length) { Refuse 'Invalid JSON depth or value.' }
    $value = $tokens[$position.Value]
    $position.Value++
    if ($value -ceq '{') {
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        if ($position.Value -lt $tokens.Length -and $tokens[$position.Value] -ceq '}') { $position.Value++; return }
        while ($true) {
            if ($position.Value -ge $tokens.Length -or !$tokens[$position.Value].StartsWith('"')) { Refuse 'Invalid JSON object key.' }
            $key = ConvertFrom-Json -InputObject $tokens[$position.Value]
            if (!$seen.Add($key)) { Refuse 'Duplicate JSON property.' }
            $position.Value++
            if ($position.Value -ge $tokens.Length -or $tokens[$position.Value] -cne ':') { Refuse 'Invalid JSON object separator.' }
            $position.Value++
            Json-Value $tokens $position ($depth + 1)
            if ($position.Value -ge $tokens.Length) { Refuse 'Unclosed JSON object.' }
            $next = $tokens[$position.Value]; $position.Value++
            if ($next -ceq '}') { return }
            if ($next -cne ',') { Refuse 'Invalid JSON object delimiter.' }
        }
    }
    if ($value -ceq '[') {
        if ($position.Value -lt $tokens.Length -and $tokens[$position.Value] -ceq ']') { $position.Value++; return }
        while ($true) {
            Json-Value $tokens $position ($depth + 1)
            if ($position.Value -ge $tokens.Length) { Refuse 'Unclosed JSON array.' }
            $next = $tokens[$position.Value]; $position.Value++
            if ($next -ceq ']') { return }
            if ($next -cne ',') { Refuse 'Invalid JSON array delimiter.' }
        }
    }
    if ($value -cin @('}',']',':',',')) { Refuse 'Invalid JSON value.' }
}
function Read-Json([byte[]]$bytes) {
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
    $pattern = '\G[ \t\r\n]*(?:"(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})|[^"\\\x00-\x1f])*"|[{}\[\]:,]|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)'
    $scanner = New-Object System.Text.RegularExpressions.Regex $pattern
    $tokens = New-Object 'System.Collections.Generic.List[string]'
    $offset = 0
    while ($offset -lt $text.Length) {
        $match = $scanner.Match($text, $offset)
        if (!$match.Success -or $match.Index -ne $offset) { break }
        $tokens.Add(($match.Value -creplace '^[ \t\r\n]+', ''))
        $offset += $match.Length
    }
    if ($text.Substring($offset) -cnotmatch '^[ \t\r\n]*$' -or $tokens.Count -eq 0) { Refuse 'Invalid JSON syntax.' }
    $position = 0
    Json-Value $tokens.ToArray() ([ref]$position) 0
    if ($position -ne $tokens.Count) { Refuse 'Trailing JSON content.' }
    $script:jsonTokens = $tokens.ToArray()
    return ConvertFrom-Json -InputObject $text
}
function Json-TopString([string[]]$tokens, [string]$field) {
    $depth = 0
    for ($i = 0; $i -lt $tokens.Length - 2; $i++) {
        if ($tokens[$i] -ceq '{' -or $tokens[$i] -ceq '[') { $depth++ }
        if ($tokens[$i] -ceq '}' -or $tokens[$i] -ceq ']') { $depth-- }
        if ($depth -eq 1 -and $tokens[$i] -ceq ('"' + $field + '"') -and $tokens[$i + 1] -ceq ':') {
            $value = $tokens[$i + 2]
            if ($value.Length -lt 2 -or !$value.StartsWith('"') -or !$value.EndsWith('"')) { Refuse 'Expiry must be a JSON string.' }
            return $value.Substring(1, $value.Length - 2)
        }
    }
    Refuse 'Expiry field is missing.'
}
function Valid-Name([string]$name) {
    if (!$name -or $name.Length -gt 240 -or $name.EndsWith('/') -or $name -cne $name.Trim()) { return $false }
    foreach ($part in $name.Split('/')) {
        if (!$part -or $part -in @('.','..') -or $part.EndsWith('.') -or $part.EndsWith(' ') -or
            $part.Split('.')[0] -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$' -or $part -match '[\\:\x00-\x1f<>|"?*]') { return $false }
    }
    return $true
}
function Forbidden-Member([string]$name) {
    if ($name -ceq 'kit-manifest.json' -or $name -ceq 'appsettings.json') { return $false }
    $parts = $name.ToLowerInvariant().Split('/')
    $leaf = $parts[$parts.Length - 1]
    for ($i = 0; $i -lt $parts.Length - 1; $i++) {
        if ($parts[$i] -in @('state','logs','buffer','bundles','secrets','credentials')) { return $true }
    }
    if ($name.Contains('/')) { return $true }
    if ($name -cnotin @('kit-manifest.json','appsettings.json','CabinetPlatform.Contracts.xml',
        'CabinetPlatform.Agent.deps.json','CabinetPlatform.Agent.runtimeconfig.json') -and
        $name -notmatch '(?i)\.(dll|exe)$') { return $true }
    return ($leaf.StartsWith('appsettings') -or $leaf.Contains('enrollment') -or
        $leaf.StartsWith('grants') -or $leaf -eq 'kit-manifest.json' -or $leaf.StartsWith('.env') -or
        $leaf -match '(\.device|\.db|\.sqlite|\.sqlite3|\.db-wal|\.db-shm|\.log|\.pfx|\.pem|\.key|\.bak|\.journal|\.token)$')
}

function Sc-Exit([string]$arguments) {
    $process = Start-Process -FilePath "$env:SystemRoot\System32\sc.exe" -ArgumentList $arguments -Wait -PassThru -NoNewWindow
    return $process.ExitCode
}

try {
    $principal = [Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
    if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Refuse 'Run from an elevated administrator PowerShell window.' }
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { Refuse 'Windows is required.' }
    if ($PSVersionTable.PSVersion.Major -lt 5 -or
        ($PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -lt 1)) {
        Refuse 'Windows PowerShell 5.1 or later is required.'
    }
    if ($ExpectedSha256 -cnotmatch '^[A-Fa-f0-9]{64}$' -or $ExpectedSourceCommit -cnotmatch '^[a-f0-9]{40}$') {
        Refuse 'Trusted package digest and source revision are required.'
    }
    $zipPath = Check-Path $AgentZip $true
    $packageStream = [IO.FileStream]::new($zipPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($sha.ComputeHash($packageStream)).Replace('-', '') }
    finally { $sha.Dispose() }
    if ($digest -cne $ExpectedSha256.ToUpperInvariant()) {
        Refuse 'Package digest differs from independently delivered release evidence.'
    }
    $packageStream.Position = 0
    $tokenPath = Check-Path $EnrollmentFile $true
    if ($zipPath -eq $tokenPath) { Refuse 'Package and enrollment input must be separate.' }
    $target = Check-Path $install $false
    if (Test-Path -LiteralPath $target) { Refuse 'Install directory already exists; existing identities are never overwritten.' }
    if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { Refuse 'Service already exists.' }
    $queryExit = Sc-Exit 'query CabinetPlatformAgent'
    if ($queryExit -eq 0) { Refuse 'Service already exists.' }
    if ($queryExit -ne 1060) { Refuse 'Could not establish that the service name is unused.' }
    $parent = Check-Path ([IO.Path]::GetDirectoryName($target)) $false
    $ancestor = $parent
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) { Check-Acl $ancestor $false }
        if ($ancestor -ieq 'C:\Program Files') { break }
        $next = [IO.Path]::GetDirectoryName($ancestor)
        if (!$next -or $next -eq $ancestor) { break }
        $ancestor = $next
    }
    # The token and its parent must be confidential. Inherited trusted ACEs are allowed.
    Check-Acl ([IO.Path]::GetDirectoryName($tokenPath)) $true
    Check-Acl $tokenPath $true
    $tokenBytes = [IO.File]::ReadAllBytes($tokenPath)
    if ($tokenBytes.Length -gt 4096) { Refuse 'Enrollment file is too large.' }
    $token = Read-Json $tokenBytes
    if ($token -isnot [pscustomobject] -or @($token.PSObject.Properties).Count -ne 4 -or
        $token.ServerBaseUrl -isnot [string] -or $token.Token -isnot [string] -or
        $token.ServerBaseUrl -cne $endpoint -or $token.Token -cnotmatch '^[A-Fa-f0-9]{64}$') {
        Refuse 'Enrollment file does not match the reviewed endpoint and token shape.'
    }
    try {
        $expiresText = Json-TopString $script:jsonTokens 'ExpiresUtc'
        $deviceExpiresText = Json-TopString $script:jsonTokens 'DeviceExpiresUtc'
        if ($expiresText -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?\+00:00$' -or
            $deviceExpiresText -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?\+00:00$') {
            Refuse 'Enrollment expiry metadata is invalid.'
        }
        $expires = [DateTimeOffset]::Parse($expiresText, [Globalization.CultureInfo]::InvariantCulture)
        $deviceExpires = [DateTimeOffset]::Parse($deviceExpiresText, [Globalization.CultureInfo]::InvariantCulture)
    } catch { Refuse 'Enrollment expiry metadata is invalid.' }
    if ($expires -le [DateTimeOffset]::UtcNow -or $deviceExpires -le $expires -or $deviceExpires -le [DateTimeOffset]::UtcNow) {
        Refuse 'Enrollment is expired or its time bounds are invalid. Issue a fresh token; do not change the journal.'
    }
    Add-Type -AssemblyName System.IO.Compression
    $archive = [IO.Compression.ZipArchive]::new($packageStream, [IO.Compression.ZipArchiveMode]::Read, $true)
    try {
        $entries = @($archive.Entries)
        $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $bytesByName = @{}
        [long]$total = 0
        foreach ($entry in $entries) {
            if (!(Valid-Name $entry.FullName) -or !$names.Add($entry.FullName) -or
                (Forbidden-Member $entry.FullName) -or
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
        foreach ($entry in $entries) {
            $parts = $entry.FullName.Split('/')
            for ($i = 1; $i -lt $parts.Length; $i++) {
                if ($names.Contains([string]::Join('/', $parts[0..($i - 1)]))) { Refuse 'File and directory names collide.' }
            }
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
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $digest = [BitConverter]::ToString($sha.ComputeHash($bytesByName[$name])).Replace('-', '') }
            finally { $sha.Dispose() }
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
        } else { Check-Acl $mashura $false }
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
        $createArguments = 'create CabinetPlatformAgent binPath= "\"C:\Program Files\Mashura\CabinetAgent\CabinetPlatform.Agent.exe\"" DisplayName= "Mashura Cabinet Support Agent" start= auto obj= LocalSystem'
        if ((Sc-Exit $createArguments) -ne 0) { Refuse 'Service registration failed.' }
        $registered = $true
        if ((Sc-Exit 'failure CabinetPlatformAgent reset= 86400 actions= restart/60000/restart/120000/restart/300000') -ne 0) {
            Refuse 'Service recovery setup failed; secure files and service remain for inspection.'
        }
        if ((Sc-Exit 'failureflag CabinetPlatformAgent 1') -ne 0) {
            Refuse 'Service failure flag setup failed; secure files and service remain for inspection.'
        }
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
} finally {
    if ($null -ne $packageStream) { $packageStream.Dispose() }
}
