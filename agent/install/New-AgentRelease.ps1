<#
.SYNOPSIS
  Packages a published, Authenticode-signed agent build as a signed release (docs/spec/07-upgrade-channel.md "Package format" and
  "Signing flow"): agent-<version>.zip, manifest.json (version, SHA-256 of the zip, minimum version, release time) and
  signature.json, a detached ECDSA P-256 signature over the manifest's exact bytes.
.DESCRIPTION
  Only the manifest's SHA-256 digest is sent to be signed; the private key never leaves the KMS.
    -AwsKmsKeyId   AWS KMS asymmetric key (ECC_NIST_P256, SIGN_VERIFY), via the aws CLI: kms sign --message-type DIGEST.
    -AzureKeyId    Azure Key Vault / Managed HSM key (EC P-256), via the az CLI: keyvault key sign --algorithm ES256.
    -DevKeyFile    A throwaway key from New-UpgradeTrust.ps1 -NewDevKey, for test builds only. Production agents do not hold it.
  The signature is verified locally against the key's public half before anything is written. Run this in the build pipeline,
  whose identity alone may request signatures; the KMS logs every request.
.EXAMPLE
  ./New-AgentRelease.ps1 -PublishDir ..\out -Version 0.2.0 -MinimumVersion 0.1.0 -OutDir ..\release -AwsKmsKeyId alias/mashura-agent-release
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $PublishDir,
    [Parameter(Mandatory)] [string] $Version,
    [Parameter(Mandatory)] [string] $MinimumVersion,
    [Parameter(Mandatory)] [string] $OutDir,
    [string] $Notes,
    [string] $AwsKmsKeyId,
    [string] $AzureKeyId,
    [string] $DevKeyFile,
    # Test builds only, with -DevKeyFile: package binaries that are not signed, to prove the agent refuses them.
    [switch] $AllowUnsignedForTest
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$versionPattern = '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(-[0-9A-Za-z.-]{1,32})?$'
if ($Version -notmatch $versionPattern -or $MinimumVersion -notmatch $versionPattern) { throw 'Versions are major.minor.patch.' }
if (@($AwsKmsKeyId, $AzureKeyId, $DevKeyFile | Where-Object { $_ }).Count -ne 1) { throw 'Name exactly one signer: -AwsKmsKeyId, -AzureKeyId or -DevKeyFile.' }

# 1. Every program the updater puts in place, each Authenticode-signed (the agent checks this again and refuses otherwise).
$required = 'Cabinet.Agent.Broker\Cabinet.Agent.Broker.exe', 'Cabinet.Agent.Network\Cabinet.Agent.Network.exe', 'Cabinet.Agent.Updater\Cabinet.Agent.Updater.exe'
foreach ($r in $required) { if (-not (Test-Path (Join-Path $PublishDir $r))) { throw "The build has no $r." } }
$binaries = Get-ChildItem $PublishDir -Recurse -File | Where-Object { $_.Extension -in '.exe', '.dll', '.sys' }
if ($AllowUnsignedForTest -and -not $DevKeyFile) { throw '-AllowUnsignedForTest is only for test releases signed with -DevKeyFile.' }
if ($IsWindows -and -not $AllowUnsignedForTest) {
    foreach ($b in $binaries) {
        $sig = Get-AuthenticodeSignature $b.FullName
        if ($sig.Status -ne 'Valid') { throw "$($b.FullName) is not validly Authenticode-signed ($($sig.Status)); sign every binary before packaging." }
    }
} else { Write-Warning 'Authenticode cannot be checked on this system; the agent checks every binary before it installs.' }

# 2. The zip, with forward-slash names, one folder per program.
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$zip = Join-Path $OutDir "agent-$Version.zip"
Remove-Item $zip -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory((Resolve-Path $PublishDir).Path, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
$zipBytes = [IO.File]::ReadAllBytes($zip)

# 3. The manifest, exactly the bytes that are signed and shipped.
$manifest = [ordered]@{ product = 'mashura-cabinet-agent'; version = $Version; minimumVersion = $MinimumVersion
    sha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($zipBytes)).ToLowerInvariant(); sizeBytes = $zipBytes.Length
    releasedAt = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'") }
if ($Notes) { $manifest.notes = $Notes }
$manifestBytes = [Text.UTF8Encoding]::new($false).GetBytes(($manifest | ConvertTo-Json -Compress))
$digest = [Security.Cryptography.SHA256]::HashData($manifestBytes)

# 4. The signature, from the KMS (or the throwaway key), over the digest only.
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
    if ($DevKeyFile) {
        Write-Warning 'Signing with a development key: only test builds of the agent accept this release.'
        $key = [Security.Cryptography.ECDsa]::Create(); $key.ImportFromPem((Get-Content -Raw $DevKeyFile))
        $der = $key.SignHash($digest, [Security.Cryptography.DSASignatureFormat]::Rfc3279DerSequence)
        $spki = $key.ExportSubjectPublicKeyInfo()
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

# 5. Check it here, with the public half, exactly as the agent will.
$verifier = [Security.Cryptography.ECDsa]::Create(); $verifier.ImportSubjectPublicKeyInfo($spki, [ref]0)
if (-not $verifier.VerifyHash($digest, $der, [Security.Cryptography.DSASignatureFormat]::Rfc3279DerSequence)) { throw 'The signature does not verify against the key''s public half.' }
$signature = [ordered]@{ keyId = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($spki)).ToLowerInvariant(); algorithm = 'ecdsa-p256-sha256'; signature = [Convert]::ToBase64String($der) }
[IO.File]::WriteAllBytes((Join-Path $OutDir 'manifest.json'), $manifestBytes)
Set-Content -Path (Join-Path $OutDir 'signature.json') -Value ($signature | ConvertTo-Json -Compress) -NoNewline -Encoding utf8NoBOM
Write-Host "Release $Version signed with key $($signature.keyId.Substring(0, 16)): $zip ($($zipBytes.Length) bytes), manifest.json, signature.json"
