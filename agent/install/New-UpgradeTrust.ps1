<#
.SYNOPSIS
  Writes an upgrade trust folder (laid out like contracts/trust/upgrade): the release keys an agent build will accept and the
  code-signing publisher every agent binary must carry. Optionally creates a throwaway development release key first.
.DESCRIPTION
  docs/spec/07-upgrade-channel.md. For production, give the public key of the release key in the KMS (-AwsKmsKeyId, or
  -PublicKeyFile with the key exported from Azure Key Vault) and the production code-signing certificate's root, and commit the
  result to contracts/trust/upgrade through review. The private key never leaves the KMS and never appears here.

  For a test build only (Windows CI, a developer's lab): -NewDevKey creates a P-256 private key in a file outside the repository,
  and the folder is passed to the build with -p:UpgradeTrustDir=<folder>. Agents built that way accept releases signed with that
  throwaway key and nothing else; production builds never see it.
.EXAMPLE
  ./New-UpgradeTrust.ps1 -NewDevKey $env:RUNNER_TEMP\release-key.pem -PublisherRootFile ci-root.cer -PublisherCommonName 'Mashura CI Code Signing' -PublisherOrganization 'Mashura CI' -OutDir $env:RUNNER_TEMP\upgrade-trust
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $OutDir,
    [string] $NewDevKey,
    [string] $DevKeyFile,
    [string] $PublicKeyFile,
    [string] $AwsKmsKeyId,
    [string] $NextPublicKeyFile,
    [string] $PublisherRootFile,
    [string] $PublisherCommonName,
    [string] $PublisherOrganization,
    [int] $FileVersion = 1
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

function Assert-OutsideRepo([string] $Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if ($full.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase)) { throw "A private key must never be written inside the repository ($full)." }
}

function Read-Spki([string] $Path) {
    $text = Get-Content -Raw $Path
    $ec = [Security.Cryptography.ECDsa]::Create()
    if ($text -match 'PRIVATE KEY') { $ec.ImportFromPem($text) } elseif ($text -match 'PUBLIC KEY') { $ec.ImportFromPem($text) } else { $ec.ImportSubjectPublicKeyInfo([IO.File]::ReadAllBytes($Path), [ref]0) }
    if ($ec.KeySize -ne 256) { throw "$Path is not a P-256 key." }
    return $ec.ExportSubjectPublicKeyInfo()
}

if ($NewDevKey) {
    Assert-OutsideRepo $NewDevKey
    $key = [Security.Cryptography.ECDsa]::Create([Security.Cryptography.ECCurve+NamedCurves]::nistP256)
    Set-Content -Path $NewDevKey -Value $key.ExportPkcs8PrivateKeyPem() -NoNewline -Encoding ascii
    Write-Host "Development release key written to $NewDevKey. It is for test builds only."
    $DevKeyFile = $NewDevKey
}

$keys = @()
$spkis = @()
if ($DevKeyFile) { $spkis += , @{ Name = 'Development release key (test builds only)'; Spki = (Read-Spki $DevKeyFile) } }
if ($PublicKeyFile) { $spkis += , @{ Name = 'Release key'; Spki = (Read-Spki $PublicKeyFile) } }
if ($AwsKmsKeyId) {
    $aws = (Get-Command aws -CommandType Application).Source
    $b64 = & $aws @('kms', 'get-public-key', '--key-id', $AwsKmsKeyId, '--query', 'PublicKey', '--output', 'text')
    if ($LASTEXITCODE -ne 0) { throw 'aws kms get-public-key failed.' }
    $spkis += , @{ Name = "Release key (AWS KMS $AwsKmsKeyId)"; Spki = [Convert]::FromBase64String($b64.Trim()) }
}
if ($NextPublicKeyFile) { $spkis += , @{ Name = 'Next release key'; Spki = (Read-Spki $NextPublicKeyFile) } }
if ($spkis.Count -gt 2) { throw 'An agent holds at most two release keys: the current one and the next.' }
foreach ($s in $spkis) {
    $id = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([byte[]]$s.Spki)).ToLowerInvariant()
    $keys += [ordered]@{ keyId = $id; name = $s.Name; publicKey = [Convert]::ToBase64String([byte[]]$s.Spki) }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$publishers = @()
if ($PublisherRootFile) {
    if (-not $PublisherCommonName -or -not $PublisherOrganization) { throw 'Give the publisher''s exact common name and organization.' }
    $root = [Security.Cryptography.X509Certificates.X509Certificate2]::new($PublisherRootFile)
    $sha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($root.RawData)).ToLowerInvariant()
    $pem = "-----BEGIN CERTIFICATE-----`n" + ([Convert]::ToBase64String($root.RawData, 'InsertLineBreaks') -replace "`r", '') + "`n-----END CERTIFICATE-----`n"
    Set-Content -Path (Join-Path $OutDir 'agent-code-signing-root.pem') -Value $pem -NoNewline -Encoding ascii
    $publishers += [ordered]@{ commonName = $PublisherCommonName; organization = $PublisherOrganization; root = $sha; rootFile = 'agent-code-signing-root.pem' }
}
$doc = [ordered]@{ version = $FileVersion; keys = @($keys); publishers = @($publishers) }
Set-Content -Path (Join-Path $OutDir 'upgrade-keys.json') -Value ($doc | ConvertTo-Json -Depth 5) -Encoding utf8NoBOM
Write-Host "Upgrade trust written to $OutDir ($($keys.Count) key(s), $($publishers.Count) publisher(s))."
