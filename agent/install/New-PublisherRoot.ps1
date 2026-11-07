<#
.SYNOPSIS
  Creates the code-signing publisher this fleet trusts - an offline root and an issuing certificate - and pins it in the
  agent upgrade trust list an agent build compiles in (contracts/trust/upgrade/upgrade-keys.json).
.DESCRIPTION
  docs/spec/07-upgrade-channel.md ("Signing flow") and finding F1. The decision behind this script, taken 7 November 2026:
  our own publisher root, no certificate bought, so we can sign and update our own programs.

  Two conditions govern whether a cabinet accepts our upgrade, and they stay independent:
    * Windows must accept the Authenticode signature, which means the signing certificate chains to a root the machine
      trusts. That root is installed on the cabinet by the first install (Install-CabinetAgent.ps1), not by this script.
    * The agent must recognise the signer, which means the publisher's exact common name and organization and the pinned
      root's SHA-256 are compiled into the agent from the trust list this script updates.

  What it writes, all outside the repository unless -UpgradeKeysFile points into it (and that file holds no key):
    publisher-root.cert.pem   the root certificate (public)      publisher-root.key.pem   the root's private key
    publisher-root.cer        the root certificate (DER)         publisher-issuing.cert.pem / .key.pem   the issuer
    publisher-issuing.pfx     only with -PfxPassword, for signtool on a Windows build machine

  The private keys never belong in the repository, on a share, or in a backup that syncs; keep them offline and treat the
  root's key as the highest authority in the fleet - it can mint a certificate that signs anything every cabinet installs.
  Before writing anything the script proves the material it just made: a signature from the issuing key verifies against
  the issuing certificate, and the issuing certificate chains to the root as the only trusted anchor.
.EXAMPLE
  ./New-PublisherRoot.ps1 -KeyDir /home/marco/cabinet-signing -UpgradeKeysFile ../../contracts/trust/upgrade/upgrade-keys.json
.EXAMPLE
  ./New-PublisherRoot.ps1 -KeyDir /home/marco/cabinet-signing -UpgradeKeysFile ../../contracts/trust/upgrade/upgrade-keys.json -PfxPassword (Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText)
#>
[CmdletBinding()]
param(
    # Where the root, the issuing certificate and their private keys are written. Always outside the repository.
    [Parameter(Mandatory)] [string] $KeyDir,
    [string] $CommonName = 'Mashura Code Signing',
    [string] $Organization = 'Mashura LLC',
    [int] $RootValidityYears = 10,
    [int] $IssuingValidityYears = 3,
    # The trust list to pin the publisher in (contracts/trust/upgrade/upgrade-keys.json). The root certificate is written
    # beside it as agent-code-signing-root.pem, because the list refers to the root by file name and hash.
    [string] $UpgradeKeysFile,
    # Also write publisher-issuing.pfx, so a Windows build machine can sign with signtool. Optional: without it the PEMs
    # here are enough for a Linux signing step, and nothing else in the flow needs a PFX.
    [string] $PfxPassword,
    # Reuse an existing root in -KeyDir instead of creating one. A second root means a second root to install on every
    # cabinet and a second publisher to pin, so this is only for issuing a replacement certificate from the same root.
    [switch] $ReuseExistingRoot,
    # Create a new root even when one is already in -KeyDir. Rotating the root is a fleet-wide change: every cabinet has
    # to be given the new root before an agent signed by it will install.
    [switch] $NewRoot
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Both certificate APIs below are PowerShell 7 / .NET 8 only; Windows PowerShell 5.1 has neither and would fail part-way
# through, after writing a private key. Refuse before anything is written, as New-UpgradeTrust.ps1 does.
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
    throw "Run this script with PowerShell 7 or later. Install it with 'winget install --id Microsoft.PowerShell' and run this again in pwsh."
}
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $PSScriptRoot 'TrustFolder.ps1')

# Resolved the way PowerShell resolves it, so the guard and the writes see the same path. The root's key is the authority
# over every cabinet in the fleet: it does not go in a checkout, where it would be committed by accident.
$keyDirFull = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($KeyDir)
if ($keyDirFull.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The publisher's private keys must never be written inside the repository ($keyDirFull). Pick a directory outside it."
}
New-Item -ItemType Directory -Force -Path $keyDirFull | Out-Null

$paths = [ordered]@{
    RootCertPem = Join-Path $keyDirFull 'publisher-root.cert.pem'
    RootCertDer = Join-Path $keyDirFull 'publisher-root.cer'
    RootKeyPem  = Join-Path $keyDirFull 'publisher-root.key.pem'
    IssCertPem  = Join-Path $keyDirFull 'publisher-issuing.cert.pem'
    IssKeyPem   = Join-Path $keyDirFull 'publisher-issuing.key.pem'
}

function Write-KeyAcl([string] $Path) {
    if ($IsWindows -or $env:OS -eq 'Windows_NT') {
        # Only the person who made it (and SYSTEM) may read the key, whatever the folder would otherwise pass down.
        $acl = New-Object Security.AccessControl.FileSecurity
        $acl.SetAccessRuleProtection($true, $false)
        $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')))
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('NT AUTHORITY\SYSTEM', 'FullControl', 'Allow')))
        Set-Acl -LiteralPath $Path -AclObject $acl
    } else { chmod 600 $Path }
}

function New-CaCertificate([string] $Subject, $Key, [DateTime] $NotBefore, [DateTime] $NotAfter) {
    # The ECDsa overload: the RSA padding overload leaves the request with no signing key, and CreateSelfSigned then refuses.
    $req = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
        $Subject, $Key, [Security.Cryptography.HashAlgorithmName]::SHA256)
    # A root: it may certify other certificates and sign revocation lists, and it is not an end-entity certificate.
    $req.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true))
    $req.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
        [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign, $true))
    $req.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($req.PublicKey, $false))
    return $req.CreateSelfSigned($NotBefore, $NotAfter)
}

function New-IssuingCertificate([string] $Subject, $Key, $RootCert, [DateTime] $NotBefore, [DateTime] $NotAfter) {
    $req = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
        $Subject, $Key, [Security.Cryptography.HashAlgorithmName]::SHA256)
    # An issuing certificate signs our programs and nothing else: not a CA, and code signing is its only purpose.
    $req.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
    $req.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
        [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature, $true))
    $oids = [Security.Cryptography.OidCollection]::new()
    $oids.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3', 'Code Signing')) | Out-Null
    $req.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids, $true))
    $req.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($req.PublicKey, $false))
    $serial = [Security.Cryptography.RandomNumberGenerator]::GetBytes(16)
    $serial[0] = $serial[0] -band 0x7f   # keep the serial a positive integer
    return $req.Create($RootCert, $NotBefore, $NotAfter, $serial)
}

$now = [DateTime]::UtcNow
$now = [DateTime]::new($now.Year, $now.Month, $now.Day, $now.Hour, $now.Minute, 0, [DateTimeKind]::Utc)
$reuse = $ReuseExistingRoot -or ((Test-Path $paths.RootKeyPem) -and -not $NewRoot)
if ($NewRoot -and (Test-Path $paths.RootKeyPem)) {
    Write-Warning "A root already exists in $keyDirFull and -NewRoot was given: the new root has to be installed on every cabinet before an agent signed by it will install."
}

if ($reuse) {
    if (-not (Test-Path $paths.RootKeyPem) -or -not (Test-Path $paths.RootCertPem)) {
        throw "No root to reuse in $keyDirFull ($($paths.RootKeyPem) and $($paths.RootCertPem) are both needed). Drop -ReuseExistingRoot to create one."
    }
    $rootKey = [Security.Cryptography.ECDsa]::Create()
    $rootKey.ImportFromPem((Get-Content -Raw $paths.RootKeyPem))
    $rootCert = Read-PemCertificate $paths.RootCertPem
    if ($rootKey.KeySize -ne 256) { throw "$($paths.RootKeyPem) is not a P-256 key." }
    # The PEM on disk is the certificate alone, and signing the new issuing certificate needs the key with it.
    # CopyWithPrivateKey refuses to attach a key that is not the certificate's own, which is the check that matters when
    # the two files have been apart for a while.
    # The extension method by name: PowerShell's binder picks the ECDiffieHellman overload of CopyWithPrivateKey first.
    $rootCert = [Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::CopyWithPrivateKey($rootCert, $rootKey)
    Write-Host "Reusing the root in $keyDirFull (expires $($rootCert.NotAfter.ToString('yyyy-MM-dd'))); issuing a new certificate from it."
} else {
    $rootKey = [Security.Cryptography.ECDsa]::Create([Security.Cryptography.ECCurve+NamedCurves]::nistP256)
    $rootCert = New-CaCertificate "CN=$CommonName Root, O=$Organization" $rootKey $now $now.AddYears($RootValidityYears)
    Write-Host "Created a publisher root: CN=$CommonName Root, O=$Organization, valid to $($rootCert.NotAfter.ToString('yyyy-MM-dd'))."
}

$issKey = [Security.Cryptography.ECDsa]::Create([Security.Cryptography.ECCurve+NamedCurves]::nistP256)
$issCert = New-IssuingCertificate "CN=$CommonName, O=$Organization" $issKey $rootCert $now $now.AddYears($IssuingValidityYears)
Write-Host "Created an issuing certificate: CN=$CommonName, O=$Organization, valid to $($issCert.NotAfter.ToString('yyyy-MM-dd'))."

# Prove the material before writing a single file. A certificate that does not chain to the pinned root, or a key that
# does not match its certificate, is the one failure that would only be discovered by a cabinet refusing an upgrade.
$blob = [Text.Encoding]::UTF8.GetBytes("publisher proof $([Guid]::NewGuid())")
$sig = $issKey.SignData($blob, [Security.Cryptography.HashAlgorithmName]::SHA256)
$issPublic = [Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPublicKey($issCert)
if (-not $issPublic.VerifyData($blob, $sig, [Security.Cryptography.HashAlgorithmName]::SHA256)) {
    throw 'The issuing certificate does not verify a signature made with its key. Nothing was written.'
}
$chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
$chain.ChainPolicy.TrustMode = [Security.Cryptography.X509Certificates.X509ChainTrustMode]::CustomRootTrust
$chain.ChainPolicy.CustomTrustStore.Add($rootCert)
$chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
if (-not $chain.Build($issCert)) {
    $why = ($chain.ChainStatus | ForEach-Object { $_.StatusInformation.Trim() }) -join '; '
    throw "The issuing certificate does not chain to the root ($why). Nothing was written."
}

# .NET's PEM reader wants every line terminated, including the last one, so the trailing newline is part of the file.
$rootCertPem = $rootCert.ExportCertificatePem().TrimEnd() + "`n"
$issCertPem = $issCert.ExportCertificatePem().TrimEnd() + "`n"
Set-Content -LiteralPath $paths.RootCertPem -Value $rootCertPem -NoNewline -Encoding ascii
Set-Content -LiteralPath $paths.RootCertDer -Value $rootCert.RawData -AsByteStream
Set-Content -LiteralPath $paths.IssCertPem -Value $issCertPem -NoNewline -Encoding ascii
if (-not $reuse) {
    Set-Content -LiteralPath $paths.RootKeyPem -Value $rootKey.ExportPkcs8PrivateKeyPem() -NoNewline -Encoding ascii
    Write-KeyAcl $paths.RootKeyPem
}
Set-Content -LiteralPath $paths.IssKeyPem -Value $issKey.ExportPkcs8PrivateKeyPem() -NoNewline -Encoding ascii
Write-KeyAcl $paths.IssKeyPem
if ($PfxPassword) {
    $pfxPath = Join-Path $keyDirFull 'publisher-issuing.pfx'
    $secure = ConvertTo-SecureString -String $PfxPassword -AsPlainText -Force
    [IO.File]::WriteAllBytes($pfxPath, $issCert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $PfxPassword))
    Write-KeyAcl $pfxPath
    Write-Host "Wrote $pfxPath for signtool on a Windows build machine (password given on the command line)."
}

$rootSha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($rootCert.RawData)).ToLowerInvariant()
Write-Host "Publisher root SHA-256 (DER): $rootSha"
Write-Host "Root certificate: $($paths.RootCertDer) (this is the file every cabinet's trust store is given)"
Write-Host "Issuing certificate and key: $($paths.IssCertPem), $($paths.IssKeyPem) (these sign the agent binaries)"

if (-not $UpgradeKeysFile) {
    Write-Host 'No -UpgradeKeysFile given: the publisher is not pinned in an upgrade trust list yet.'
    return
}
$trustFull = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($UpgradeKeysFile)
if (-not (Test-Path $trustFull)) { throw "The upgrade trust list $trustFull does not exist." }
$rootFileName = 'agent-code-signing-root.pem'
Set-Content -LiteralPath (Join-Path (Split-Path -Parent $trustFull) $rootFileName) -Value $rootCertPem -NoNewline -Encoding ascii
$doc = Set-Publisher -UpgradeKeysFile $trustFull -CommonName $CommonName -Organization $Organization -RootSha256 $rootSha -RootFile $rootFileName
Write-Host "Pinned publisher $CommonName / $Organization in $trustFull (publisher root $rootSha)."
Write-Host "Publishers in that list now: $(@($doc.publishers).Count). Release keys are untouched: $(@($doc.keys).Count)."
