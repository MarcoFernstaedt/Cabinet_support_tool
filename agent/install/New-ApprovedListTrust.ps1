<#
.SYNOPSIS
  Writes the list-signing trust file (laid out like contracts/trust/approved-list): the public halves of the Admin keys an
  agent build accepts approved lists from. Optionally creates a new key file first.
.DESCRIPTION
  docs/spec/09-open-decisions.md "Signing the approved list". The agent compiles approved-list-keys.json in, so only a signed
  agent upgrade can change which key signs lists; the server has no say.

  To set signing up:
    1. Make the key. Either a key file kept offline (-NewKey E:\list-signing-key.pem, asked for a passphrase, on removable
       media that stays with the Admin), or a KMS key (-AwsKmsKeyId, or -PublicKeyFile with the public key exported from
       Azure Key Vault). The private key never enters the repository: -NewKey refuses a path inside it.
    2. Write the trust file into contracts/trust/approved-list (-OutDir), commit it through review, and release an agent
       built from it. From then on, cabinets on that agent act only on lists signed with the key.
  To change the key, list the current key and the next one (-NextPublicKeyFile) in one release, sign with the next key once
  the fleet runs it, then release again without the old key.
.EXAMPLE
  ./New-ApprovedListTrust.ps1 -NewKey E:\list-signing-key.pem -OutDir ..\..\contracts\trust\approved-list
.EXAMPLE
  ./New-ApprovedListTrust.ps1 -AwsKmsKeyId alias/mashura-approved-list -OutDir ..\..\contracts\trust\approved-list
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $OutDir,
    [string] $NewKey,
    [Security.SecureString] $Passphrase,
    [string] $KeyFile,
    [string] $PublicKeyFile,
    [string] $AwsKmsKeyId,
    [string] $NextPublicKeyFile,
    [int] $FileVersion = 1
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
    throw "Run this script with PowerShell 7 or later: Windows PowerShell 5.1 cannot make or read the key. Install it with 'winget install --id Microsoft.PowerShell', then run this again in pwsh."
}
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

function Read-Spki([string] $Path) {
    $text = Get-Content -Raw -LiteralPath $Path
    $ec = [Security.Cryptography.ECDsa]::Create()
    if ($text -match 'ENCRYPTED PRIVATE KEY') {
        if (-not $Passphrase) { $script:Passphrase = Read-Host -AsSecureString "Passphrase for $Path" }
        $ec.ImportFromEncryptedPem($text, [Net.NetworkCredential]::new('', $script:Passphrase).Password)
    } elseif ($text -match 'PRIVATE KEY|PUBLIC KEY') { $ec.ImportFromPem($text) }
    else { $ec.ImportSubjectPublicKeyInfo([IO.File]::ReadAllBytes($Path), [ref]0) }
    if ($ec.KeySize -ne 256) { throw "$Path is not a P-256 key." }
    return $ec.ExportSubjectPublicKeyInfo()
}

if ($NewKey) {
    # Resolved the way PowerShell resolves it, so the check and the write see the same path.
    $full = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($NewKey)
    if ($full.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase)) { throw "A private key must never be written inside the repository ($full)." }
    if (Test-Path -LiteralPath $full) { throw "$full already exists; a key file is never overwritten." }
    if (-not $Passphrase) {
        $Passphrase = Read-Host -AsSecureString 'Passphrase for the new list-signing key (at least 12 characters)'
        $again = Read-Host -AsSecureString 'The same passphrase again'
        if ([Net.NetworkCredential]::new('', $Passphrase).Password -cne [Net.NetworkCredential]::new('', $again).Password) { throw 'The two passphrases differ; no key was made.' }
    }
    $plain = [Net.NetworkCredential]::new('', $Passphrase).Password
    if ($plain.Length -lt 12) { throw 'The passphrase must be at least 12 characters; no key was made.' }
    $key = [Security.Cryptography.ECDsa]::Create([Security.Cryptography.ECCurve+NamedCurves]::nistP256)
    $pbe = [Security.Cryptography.PbeParameters]::new([Security.Cryptography.PbeEncryptionAlgorithm]::Aes256Cbc, [Security.Cryptography.HashAlgorithmName]::SHA256, 600000)
    Set-Content -LiteralPath $full -Value $key.ExportEncryptedPkcs8PrivateKeyPem($plain, $pbe) -NoNewline -Encoding ascii
    if ($IsWindows) {
        # Only the person who made it (and SYSTEM) may read the key, whatever the folder would otherwise pass down.
        $acl = New-Object Security.AccessControl.FileSecurity
        $acl.SetAccessRuleProtection($true, $false)
        $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')))
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('NT AUTHORITY\SYSTEM', 'FullControl', 'Allow')))
        Set-Acl -LiteralPath $full -AclObject $acl
    } else { chmod 600 $full }
    Write-Host "List-signing key written to $full, protected by its passphrase. Keep it offline, with a second copy somewhere safe."
    $KeyFile = $full
}

$spkis = @()
if ($KeyFile) { $spkis += , @{ Name = 'Admin list-signing key'; Spki = (Read-Spki $KeyFile) } }
if ($PublicKeyFile) { $spkis += , @{ Name = 'Admin list-signing key'; Spki = (Read-Spki $PublicKeyFile) } }
if ($AwsKmsKeyId) {
    $aws = (Get-Command aws -CommandType Application).Source
    $b64 = & $aws @('kms', 'get-public-key', '--key-id', $AwsKmsKeyId, '--query', 'PublicKey', '--output', 'text')
    if ($LASTEXITCODE -ne 0) { throw 'aws kms get-public-key failed.' }
    $spkis += , @{ Name = "Admin list-signing key (AWS KMS $AwsKmsKeyId)"; Spki = [Convert]::FromBase64String($b64.Trim()) }
}
if ($NextPublicKeyFile) { $spkis += , @{ Name = 'Next Admin list-signing key'; Spki = (Read-Spki $NextPublicKeyFile) } }
if ($spkis.Count -eq 0) { throw 'Name the key: -NewKey, -KeyFile, -PublicKeyFile or -AwsKmsKeyId.' }
if ($spkis.Count -gt 2) { throw 'An agent holds at most two list-signing keys: the current one and the next.' }

# The release key never signs a list: refuse a key the agent already trusts for releases.
$releaseKeys = Join-Path $repo 'contracts\trust\upgrade\upgrade-keys.json'
$releaseIds = if (Test-Path -LiteralPath $releaseKeys) { @((Get-Content -Raw -LiteralPath $releaseKeys | ConvertFrom-Json).keys | ForEach-Object { $_.keyId }) } else { @() }
$keys = @()
foreach ($s in $spkis) {
    $id = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([byte[]]$s.Spki)).ToLowerInvariant()
    if ($releaseIds -contains $id) { throw 'That key is the agent release key. Lists need a key of their own.' }
    $keys += [ordered]@{ keyId = $id; name = $s.Name; publicKey = [Convert]::ToBase64String([byte[]]$s.Spki) }
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$doc = [ordered]@{ version = $FileVersion; keys = @($keys) }
Set-Content -Path (Join-Path $OutDir 'approved-list-keys.json') -Value ($doc | ConvertTo-Json -Depth 5) -Encoding utf8NoBOM
Write-Host "List-signing trust written to $OutDir ($($keys.Count) key(s)). Agents built from it act only on lists signed with these keys."
