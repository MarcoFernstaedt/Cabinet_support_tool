<#
.SYNOPSIS
  Packages a published, Authenticode-signed agent build as a signed release (docs/spec/07-upgrade-channel.md "Package format" and
  "Signing flow"): agent-<version>.zip, manifest.json (version, SHA-256 of the zip, minimum version, release time) and
  signature.json, a detached ECDSA P-256 signature over the manifest's exact bytes.
.DESCRIPTION
  Run this once per Windows architecture, with the publish directory that architecture was published into and -Architecture
  naming it (docs/platform/second-architecture.md). One version therefore has one release per architecture: Windows cannot
  run a 64-bit program on 32-bit Windows, so a cabinet can only ever be offered the release built for it, and the platform
  records which architecture a release is when the package is uploaded. The file names are the same for every architecture
  because each release is stored and served on its own; the architecture is not on the signed manifest, whose schema is closed
  and validated by the agent, and an extra field would make an older agent refuse its own next update.

  Only the manifest's SHA-256 digest is sent to be signed; the private key never leaves the KMS.
    -AwsKmsKeyId   AWS KMS asymmetric key (ECC_NIST_P256, SIGN_VERIFY), via the aws CLI: kms sign --message-type DIGEST.
    -AzureKeyId    Azure Key Vault / Managed HSM key (EC P-256), via the az CLI: keyvault key sign --algorithm ES256.
    -DevKeyFile    A throwaway key from New-UpgradeTrust.ps1 -NewDevKey, for test builds only. Production agents do not hold it.
  The signature is verified locally against the key's public half before anything is written. Run this in the build pipeline,
  whose identity alone may request signatures; the KMS logs every request.
.EXAMPLE
  ./New-AgentRelease.ps1 -PublishDir ..\out\win-x64 -Architecture win-x64 -Version 0.2.0 -MinimumVersion 0.1.0 -OutDir ..\release\win-x64 -AwsKmsKeyId alias/mashura-agent-release
.EXAMPLE
  ./New-AgentRelease.ps1 -PublishDir ..\out\win-x86 -Architecture win-x86 -Version 0.2.0 -MinimumVersion 0.1.0 -OutDir ..\release\win-x86 -AwsKmsKeyId alias/mashura-agent-release
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $PublishDir,
    [Parameter(Mandatory)] [ValidateSet('win-x64', 'win-x86')] [string] $Architecture,
    [Parameter(Mandatory)] [string] $Version,
    [Parameter(Mandatory)] [string] $MinimumVersion,
    [Parameter(Mandatory)] [string] $OutDir,
    [string] $Notes,
    [string] $AwsKmsKeyId,
    [string] $AzureKeyId,
    [string] $DevKeyFile,
    # The upgrade trust list the agent in this build compiled in. Checked before packaging, so a release is never shipped
    # to cabinets that the agent carrying it would refuse: an empty publisher list, or a pinned root that is not the root
    # in the folder, fails the build instead of the fleet.
    [string] $UpgradeTrustDir,
    # Test builds only, with -DevKeyFile: package binaries that are not signed and skip the publisher check, to prove the
    # agent refuses them.
    [switch] $AllowUnsignedForTest
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Windows PowerShell 5.1 has neither $IsWindows nor the certificate and hashing APIs below (ImportFromPem,
# [Convert]::ToHexString, -Encoding utf8NoBOM): a release must never be built with its signature check skipped
# because the wrong PowerShell was used, so say so before anything is written.
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
    throw 'Run this script with PowerShell 7 or later: Windows PowerShell 5.1 cannot carry out the checks and signing this script does.'
}
$versionPattern = '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(-[0-9A-Za-z.-]{1,32})?$'
if ($Version -notmatch $versionPattern -or $MinimumVersion -notmatch $versionPattern) { throw 'Versions are major.minor.patch.' }
if (@($AwsKmsKeyId, $AzureKeyId, $DevKeyFile | Where-Object { $_ }).Count -ne 1) { throw 'Name exactly one signer: -AwsKmsKeyId, -AzureKeyId or -DevKeyFile.' }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $PSScriptRoot 'TrustFolder.ps1')
if (-not $UpgradeTrustDir) { $UpgradeTrustDir = Join-Path $repo 'contracts\trust\upgrade' }
if (-not (Test-Path $UpgradeTrustDir)) { throw "The upgrade trust list directory $UpgradeTrustDir does not exist. Point -UpgradeTrustDir at the trust the agent was built with." }

# 1. Every program the updater puts in place, each Authenticode-signed (the agent checks this again and refuses otherwise).
$required = 'Cabinet.Agent.Broker\Cabinet.Agent.Broker.exe', 'Cabinet.Agent.Network\Cabinet.Agent.Network.exe', 'Cabinet.Agent.Updater\Cabinet.Agent.Updater.exe'
foreach ($r in $required) { if (-not (Test-Path (Join-Path $PublishDir $r))) { throw "The build has no $r." } }
$binaries = Get-ChildItem $PublishDir -Recurse -File | Where-Object { $_.Extension -in '.exe', '.dll', '.sys' }

# 1b. This really is a build of the architecture it is being released as. The Machine field of the PE header is read here
# rather than trusted: a package published for the other architecture cannot start at all on the cabinet it would be
# offered to, and the mistake would otherwise not be found until a cabinet refused it (or someone forced it through).
function Get-PeMachine([string] $path) {
    $fs = [IO.File]::OpenRead($path)
    try {
        $fs.Position = 0x3c
        $headerOffset = [IO.BinaryReader]::new($fs).ReadInt32()
        if ($headerOffset -le 0 -or $headerOffset -gt $fs.Length - 6) { return 0 }
        $fs.Position = $headerOffset + 4
        return [IO.BinaryReader]::new($fs).ReadUInt16()
    } finally { $fs.Dispose() }
}
$expectedMachine = if ($Architecture -eq 'win-x64') { 0x8664 } else { 0x14c }
foreach ($exe in Get-ChildItem $PublishDir -Recurse -File -Filter '*.exe') {
    $machine = Get-PeMachine $exe.FullName
    if ($machine -ne $expectedMachine) {
        throw "$($exe.Name) is not a $Architecture program (PE machine 0x$('{0:X4}' -f $machine)). Publish it for $Architecture and release that build."
    }
}
if ($AllowUnsignedForTest -and -not $DevKeyFile) { throw '-AllowUnsignedForTest is only for test releases signed with -DevKeyFile.' }
if (-not $AllowUnsignedForTest) {
    # A release that was packaged with this check skipped is one the agent refuses after it has been shipped, and the
    # cabinet it was shipped to has no way back. Failing the build is the only safe place for that decision (F1).
    if (-not ($IsWindows -or $env:OS -eq 'Windows_NT')) {
        throw 'Authenticode signatures cannot be checked on this host, so this release would be packaged unverified. Package releases on Windows, or pass -AllowUnsignedForTest with -DevKeyFile for a test release that a production agent refuses.'
    }
    foreach ($b in $binaries) {
        $sig = Get-AuthenticodeSignature $b.FullName
        if ($sig.Status -ne 'Valid') { throw "$($b.FullName) is not validly Authenticode-signed ($($sig.Status)); sign every binary before packaging." }
    }
    $pinned = Assert-PublisherPinned $UpgradeTrustDir
    Write-Host "$($binaries.Count) binaries are validly signed, and $pinned publisher(s) are pinned in $UpgradeTrustDir."
} else {
    Write-Warning 'This is a test release: the binaries are not signed and no publisher is checked, so a production agent refuses it.'
}

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
