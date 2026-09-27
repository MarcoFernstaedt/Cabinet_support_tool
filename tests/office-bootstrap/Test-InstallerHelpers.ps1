# Inert helper checks on Windows PowerShell 5.1. No installer entry point is run.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$AgentZip)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
    throw 'Run this fixture under Windows PowerShell 5.1.'
}
$helper = (Resolve-Path (Join-Path $PSScriptRoot '..\..\tools\Install-CabinetDemoAgent.ps1')).Path
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($helper, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw "Helper parse error: $($errors[0])" }
$required = @('Refuse','Check-Acl','Json-Value','Read-Json','Json-TopString','Valid-Name')
$definitions = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] })
foreach ($name in $required) {
    $matches = @($definitions | Where-Object { $_.Name -ceq $name })
    if ($matches.Count -ne 1) { throw "Missing or duplicate helper definition: $name" }
    # The only executable source imported is this one AST function definition.
    . ([scriptblock]::Create($matches[0].Extent.Text))
}
function Assert-Refused([scriptblock]$action, [string]$label) {
    try { & $action | Out-Null } catch { return }
    throw "Expected refusal: $label"
}
function Assert-Accepted([scriptblock]$action, [string]$label) {
    try { & $action | Out-Null } catch { throw "Expected acceptance: $label : $($_.Exception.Message)" }
}
function Bytes([string]$text) { return ,([Text.Encoding]::UTF8.GetBytes($text)) }
$endpoint = 'https://srv1522777.tail72f980.ts.net/'
$expiry = '2030-01-01T00:00:00+00:00'
$device = '2030-01-02T00:00:00+00:00'
$valid = '{"ServerBaseUrl":"' + $endpoint + '","Token":"' + ('A' * 64) + '","ExpiresUtc":"' + $expiry + '","DeviceExpiresUtc":"' + $device + '"}'
$manifest = '{"schema":1,"component":"agent","endpoint":"' + $endpoint + '","sourceCommit":"' + ('a' * 40) + '","signed":false,"sha256":{"agent.exe":"' + ('A' * 64) + '"}}'
$config = '{"Agent":{"ServerBaseUrl":"' + $endpoint + '","Actions":{"ExecutionMode":"DiagnosticOnly"},"Buffer":{"Directory":"state"}}}'
foreach ($text in @($valid, $manifest, $config, '{}', '[]', '{"a":[]}', '[{},[],null,true,false,123]')) {
    Assert-Accepted { Read-Json (Bytes $text) } 'valid JSON'
}
Add-Type -AssemblyName System.IO.Compression
$zipPath = (Resolve-Path -LiteralPath $AgentZip).Path
$zipStream = [IO.FileStream]::new($zipPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
    $archive = [IO.Compression.ZipArchive]::new($zipStream, [IO.Compression.ZipArchiveMode]::Read, $true)
    try {
        foreach ($name in @('kit-manifest.json', 'appsettings.json')) {
            $entry = $archive.GetEntry($name)
            if (!$entry -or $entry.Length -gt 1048576) { throw "Missing or oversized JSON fixture: $name" }
            $inputStream = $entry.Open()
            try {
                $memory = [IO.MemoryStream]::new()
                try { $inputStream.CopyTo($memory); $bytes = $memory.ToArray() }
                finally { $memory.Dispose() }
            } finally { $inputStream.Dispose() }
            Assert-Accepted { Read-Json $bytes } "delivered $name"
        }
    } finally { $archive.Dispose() }
} finally { $zipStream.Dispose() }
Assert-Accepted {
    $value = Read-Json (Bytes $valid)
    if ($value.Token -cne ('A' * 64)) { throw 'Token parsing changed.' }
    if ((Json-TopString $script:jsonTokens 'ExpiresUtc') -cne $expiry) { throw 'Expiry parsing changed.' }
    if ((Json-TopString $script:jsonTokens 'DeviceExpiresUtc') -cne $device) { throw 'Device expiry changed.' }
} 'synthetic token fields'
$invalid = @(
    '{"a":1,"a":2}', '{"a":1,"A":2}', '{"a":1,"\u0061":2}',
    '{"outer":{"a":1,"A":2}}', '{"outer":[{"a":1,"\u0061":2}]}',
    '{"a":1,}', '[1,]', '{"a":1 "b":2}', '{"a" 1}', '{"a":}',
    '{"a":1::2}', '{"a":"unfinished}', '{"a":"\q"}', '{"a":"\uXYZ1"}',
    '{"a":1} garbage', '{}{}', '{"a":1', '[1', ('{' + [char]0xA0 + '}'),
    '{"a":١}', ([char]0xA0 + '{"a":1}')
)
foreach ($text in $invalid) { Assert-Refused { Read-Json (Bytes $text) } "invalid JSON: $text" }
Assert-Refused { Read-Json ([byte[]](0x7B,0x22,0x80,0x22,0x7D)) } 'invalid UTF-8'
$deep = ('[' * 66) + '0' + (']' * 66)
Assert-Refused { Read-Json (Bytes $deep) } 'depth limit'
foreach ($value in @('null','3')) {
    $text = '{"ExpiresUtc":' + $value + '}'
    Assert-Refused { Read-Json (Bytes $text) | Out-Null; Json-TopString $script:jsonTokens 'ExpiresUtc' } 'non-string expiry'
}
Assert-Accepted {
    Read-Json (Bytes '{"ExpiresUtc":"2030-01-01T00:00:00+00:00"}') | Out-Null
    if ((Json-TopString $script:jsonTokens 'ExpiresUtc') -cne $expiry) { throw 'Valid date string changed.' }
} 'literal expiry date string'
Assert-Refused {
    Read-Json (Bytes '{"\u0045xpiresUtc":"2030-01-01T00:00:00+00:00"}') | Out-Null
    Json-TopString $script:jsonTokens 'ExpiresUtc'
} 'escaped expiry field'
foreach ($name in @(' leading.dll', "`ttab.dll", 'trailing.dll ')) {
    if (Valid-Name $name) { throw "Unsafe name accepted: $name" }
}
if (!(Valid-Name 'valid.dll')) { throw 'Valid name refused.' }

$mutation = [Security.AccessControl.FileSystemRights]::WriteData -bor
    [Security.AccessControl.FileSystemRights]::AppendData -bor
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
    [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership
foreach ($read in @([Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.FileSystemRights]::ReadAndExecute)) {
    if (($read -band $mutation) -ne 0) { throw 'Read-only rights intersect mutation mask.' }
}
foreach ($write in @([Security.AccessControl.FileSystemRights]::WriteData,
    [Security.AccessControl.FileSystemRights]::AppendData,
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes,
    [Security.AccessControl.FileSystemRights]::WriteAttributes,
    [Security.AccessControl.FileSystemRights]::Delete,
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,
    [Security.AccessControl.FileSystemRights]::ChangePermissions,
    [Security.AccessControl.FileSystemRights]::TakeOwnership)) {
    if (($write -band $mutation) -eq 0) { throw "Mutation right missing: $write" }
}
$folder = Join-Path $env:TEMP ([Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($folder) | Out-Null
try {
    $secret = Join-Path $folder 'synthetic-secret.json'
    [IO.File]::WriteAllBytes($secret, (Bytes '{}'))
    $users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
    $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $admins = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $installer = [Security.Principal.SecurityIdentifier]::new('S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
    function Set-SyntheticAcl([string]$path, [Security.Principal.SecurityIdentifier]$sid,
        [Security.AccessControl.FileSystemRights]$grant) {
        $acl = Get-Acl -LiteralPath $path
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleAll($rule) | Out-Null }
        foreach ($pair in @(@($system, [Security.AccessControl.FileSystemRights]::FullControl),
                            @($admins, [Security.AccessControl.FileSystemRights]::FullControl), @($sid, $grant))) {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new($pair[0], $pair[1],
                [Security.AccessControl.AccessControlType]::Allow)
            $acl.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $path -AclObject $acl
    }
    $unmapped = [Security.Principal.SecurityIdentifier]::new('S-1-5-21-111111111-222222222-333333333-1001')
    Set-SyntheticAcl $folder $unmapped ([Security.AccessControl.FileSystemRights]::ReadAndExecute)
    Assert-Accepted { Check-Acl $folder $false } 'unmapped SID with read-only ancestor access'
    Assert-Refused { Check-Acl $folder $true } 'unmapped SID with secret read access'
    Set-SyntheticAcl $folder $unmapped ([Security.AccessControl.FileSystemRights]::WriteData)
    Assert-Refused { Check-Acl $folder $false } 'unmapped SID with ancestor write access'
    Set-SyntheticAcl $folder $users ([Security.AccessControl.FileSystemRights]::ReadAndExecute)
    Assert-Accepted { Check-Acl $folder $false } 'shared parent read and execute'
    Assert-Refused { Check-Acl $folder $true } 'secret parent with Users read'
    Set-SyntheticAcl $folder $users ([Security.AccessControl.FileSystemRights]::WriteData)
    Assert-Refused { Check-Acl $folder $false } 'user-writable parent'
    Set-SyntheticAcl $folder $installer ([Security.AccessControl.FileSystemRights]::FullControl)
    Assert-Accepted { Check-Acl $folder $false } 'TrustedInstaller ancestor mutation'
    Assert-Refused { Check-Acl $folder $true } 'TrustedInstaller secret access'
    Set-SyntheticAcl $secret $users ([Security.AccessControl.FileSystemRights]::Read)
    Assert-Refused { Check-Acl $secret $true } 'secret file with Users read'
    Set-SyntheticAcl $secret $system ([Security.AccessControl.FileSystemRights]::FullControl)
    Assert-Accepted { Check-Acl $secret $true } 'SYSTEM and Administrators secret'
    # Inspect standard ancestors without changing their ACLs. Actual acceptance is a separate host-specific gate.
    $programFiles = $env:ProgramFiles
    if (!(Test-Path -LiteralPath $programFiles -PathType Container)) { throw 'Program Files missing.' }
    Check-Acl $programFiles $false
    Write-Output 'PASS: isolated JSON, rights intersections and synthetic ACL checks; Program Files inspected read-only.'
} finally {
    Remove-Item -LiteralPath $folder -Recurse -Force
}
