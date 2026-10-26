<#
.SYNOPSIS
  Signs one approved-programs list with the Admin list-signing key, on the Admin's own computer.
.DESCRIPTION
  docs/spec/09-open-decisions.md "Signing the approved list". When an Admin saves a list in the console, the server keeps it
  waiting for a signature and offers it as a file (approved-list-<level>-v<version>.json). Run this script on that file: it
  shows what the list approves, asks you to confirm, and writes <file>.signature.json next to it. Upload that file on the same
  console page. Cabinets accept the list only with a signature from a key compiled into their agent, so the server, and
  anything that takes over a cabinet's network service, cannot approve a program on its own.

  The key is one of:
    -KeyFile       The key file from New-ApprovedListTrust.ps1 -NewKey, kept on removable media. A passphrase-protected
                   key asks for its passphrase (or takes -Passphrase).
    -AwsKmsKeyId   AWS KMS asymmetric key (ECC_NIST_P256, SIGN_VERIFY), via the aws CLI: kms sign --message-type DIGEST.
    -AzureKeyId    Azure Key Vault / Managed HSM key (EC P-256), via the az CLI: keyvault key sign --algorithm ES256.
  Only the SHA-256 digest of the list goes to a KMS; the private key never leaves it. The signature is checked here against
  the key's public half before anything is written.

  The list file is read as bytes and signed exactly as it is: do not open and save it in an editor first.
.EXAMPLE
  ./Sign-ApprovedList.ps1 -ListFile E:\approved-list-site-v3.json -KeyFile E:\list-signing-key.pem
.EXAMPLE
  ./Sign-ApprovedList.ps1 -ListFile .\approved-list-fleet-v7.json -AwsKmsKeyId alias/mashura-approved-list
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $ListFile,
    [string] $KeyFile,
    [Security.SecureString] $Passphrase,
    [string] $AwsKmsKeyId,
    [string] $AzureKeyId,
    [string] $OutFile,
    # Skip the typed confirmation (automation and tests). The list is still printed.
    [switch] $Yes
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Windows PowerShell 5.1 has neither ImportFromPem, [Convert]::ToHexString nor -Encoding utf8NoBOM. Say so before anything is
# read or written. Signing happens on an Admin's computer, never on a cabinet, so 5.1 on the cabinets is not affected.
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
    throw "Run this script with PowerShell 7 or later: Windows PowerShell 5.1 cannot sign a list. Install it with 'winget install --id Microsoft.PowerShell', then run this again in pwsh."
}
if (@($AwsKmsKeyId, $AzureKeyId, $KeyFile | Where-Object { $_ }).Count -ne 1) { throw 'Name exactly one key: -KeyFile, -AwsKmsKeyId or -AzureKeyId.' }

# 1. The list, as bytes, checked to be an approved list before anyone is asked to sign it.
$maxBytes = 32 * 1024
$item = Get-Item -LiteralPath $ListFile
if ($item.Length -gt $maxBytes) { throw "$ListFile is larger than an approved list can be ($maxBytes bytes)." }
$bytes = [IO.File]::ReadAllBytes($item.FullName)
try { $list = [Text.UTF8Encoding]::new($false, $true).GetString($bytes) | ConvertFrom-Json } catch { throw "$ListFile is not an approved list (it is not JSON)." }
$fields = @($list.PSObject.Properties.Name)
foreach ($f in 'product', 'level', 'scopeId', 'version', 'issuedAt', 'entries') { if ($fields -notcontains $f) { throw "$ListFile is not an approved list (it has no $f)." } }
if ($list.product -ne 'mashura-approved-list') { throw "$ListFile is not an approved list (its product is '$($list.product)')." }
if ($list.level -notin 'fleet', 'client', 'site', 'cabinet') { throw "$ListFile names an unknown level '$($list.level)'." }

# 2. What it approves, in full, and a typed yes. A signature is the Admin's decision, so the Admin sees what is decided.
$scope = if ($list.level -eq 'fleet') { 'the whole fleet (default)' } else { "$($list.level) $($list.scopeId)" }
Write-Host ''
Write-Host "Approved programs for $scope, version $($list.version), saved $($list.issuedAt)"
$entries = @($list.entries)
if ($entries.Count -gt 32) { throw "$ListFile has $($entries.Count) entries; an approved list holds at most 32." }
# What is shown must be what is signed: a control or text-direction character could hide or reorder part of a line on screen.
$hidden = '[\x00-\x1f\x7f\u200e\u200f\u202a-\u202e\u2066-\u2069]'
foreach ($e in $entries) {
    foreach ($f in 'key', 'kind', 'name', 'path', 'serviceName') {
        if ($e.PSObject.Properties[$f] -and "$($e.$f)" -match $hidden) { throw "$ListFile has an entry whose $f holds a hidden character; it was not signed." }
    }
}
if ($entries.Count -eq 0) { Write-Host '  (none: this list approves nothing at this level)' }
foreach ($e in $entries) {
    $what = if ($e.kind -eq 'service') { "service $($e.serviceName)" } else { 'application' }
    Write-Host ("  {0,-24} {1,-28} {2}" -f $e.name, $what, $e.path)
}
Write-Host ''
if (-not $Yes) {
    $answer = Read-Host 'Type SIGN to approve exactly these programs'
    if ($answer -cne 'SIGN') { throw 'Not signed: the list was not confirmed.' }
}

# 3. The signature, over the digest only.
$digest = [Security.Cryptography.SHA256]::HashData($bytes)
function ConvertTo-Der([byte[]] $raw) {
    # IEEE P1363 r||s (Azure) to the DER SEQUENCE the agent verifies.
    if ($raw.Length -ne 64) { throw 'Expected a 64-byte ES256 signature.' }
    # DER integers carry no redundant leading zero bytes.
    function Trim([byte[]] $b) { $i = 0; while ($i -lt $b.Length - 1 -and $b[$i] -eq 0) { $i++ }; return [byte[]]$b[$i..($b.Length - 1)] }
    $w = [Formats.Asn1.AsnWriter]::new([Formats.Asn1.AsnEncodingRules]::DER)
    $seq = $w.PushSequence()
    $w.WriteIntegerUnsigned([byte[]](Trim $raw[0..31])); $w.WriteIntegerUnsigned([byte[]](Trim $raw[32..63]))
    $seq.Dispose()
    return $w.Encode()
}
$tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $tmp | Out-Null
try {
    if ($KeyFile) {
        $pem = Get-Content -Raw -LiteralPath $KeyFile
        $key = [Security.Cryptography.ECDsa]::Create()
        if ($pem -match 'ENCRYPTED PRIVATE KEY') {
            if (-not $Passphrase) { $Passphrase = Read-Host -AsSecureString 'Passphrase for the list-signing key' }
            $key.ImportFromEncryptedPem($pem, [Net.NetworkCredential]::new('', $Passphrase).Password)
        } elseif ($pem -match 'PRIVATE KEY') { $key.ImportFromPem($pem) } else { throw "$KeyFile does not hold a private key." }
        if ($key.KeySize -ne 256) { throw "$KeyFile is not a P-256 key." }
        $der = $key.SignHash($digest, [Security.Cryptography.DSASignatureFormat]::Rfc3279DerSequence)
        $spki = $key.ExportSubjectPublicKeyInfo()
        $key.Dispose()
    } elseif ($AwsKmsKeyId) {
        $aws = (Get-Command aws -CommandType Application).Source
        [IO.File]::WriteAllBytes((Join-Path $tmp 'digest'), $digest)
        $b64 = & $aws @('kms', 'sign', '--key-id', $AwsKmsKeyId, '--message', "fileb://$(Join-Path $tmp 'digest')", '--message-type', 'DIGEST',
            '--signing-algorithm', 'ECDSA_SHA_256', '--query', 'Signature', '--output', 'text')
        if ($LASTEXITCODE -ne 0) { throw 'aws kms sign failed.' }
        $der = [Convert]::FromBase64String($b64.Trim())
        $pub = & $aws @('kms', 'get-public-key', '--key-id', $AwsKmsKeyId, '--query', 'PublicKey', '--output', 'text')
        if ($LASTEXITCODE -ne 0) { throw 'aws kms get-public-key failed.' }
        $spki = [Convert]::FromBase64String($pub.Trim())
    } else {
        $az = (Get-Command az -CommandType Application).Source
        $out = & $az @('keyvault', 'key', 'sign', '--id', $AzureKeyId, '--algorithm', 'ES256', '--digest', [Convert]::ToBase64String($digest), '--output', 'json') | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0) { throw 'az keyvault key sign failed.' }
        $value = if ($out.PSObject.Properties['signature']) { $out.signature } else { $out.result }
        $value = $value.Replace('-', '+').Replace('_', '/'); while ($value.Length % 4) { $value += '=' }
        $der = ConvertTo-Der ([Convert]::FromBase64String($value))
        & $az @('keyvault', 'key', 'download', '--id', $AzureKeyId, '--encoding', 'DER', '--file', (Join-Path $tmp 'public.der')) | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'az keyvault key download failed.' }
        $spki = [IO.File]::ReadAllBytes((Join-Path $tmp 'public.der'))
    }
} finally { Remove-Item -Recurse -Force $tmp }

# 4. Checked here with the public half, exactly as the server and the cabinet will, then written.
$verifier = [Security.Cryptography.ECDsa]::Create(); $verifier.ImportSubjectPublicKeyInfo($spki, [ref]0)
if (-not $verifier.VerifyHash($digest, $der, [Security.Cryptography.DSASignatureFormat]::Rfc3279DerSequence)) { throw 'The signature does not verify against the key''s public half.' }
$signature = [ordered]@{ keyId = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($spki)).ToLowerInvariant(); algorithm = 'ecdsa-p256-sha256'; signature = [Convert]::ToBase64String($der) }
if (-not $OutFile) { $OutFile = [IO.Path]::ChangeExtension($item.FullName, $null).TrimEnd('.') + '.signature.json' }
Set-Content -LiteralPath $OutFile -Value ($signature | ConvertTo-Json -Compress) -NoNewline -Encoding utf8NoBOM
Write-Host "Signed with key $($signature.keyId.Substring(0, 16)). Upload $OutFile on the Approved programs page."
