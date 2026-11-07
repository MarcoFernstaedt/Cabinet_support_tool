<#
.SYNOPSIS
  Helpers for the agent upgrade trust list an agent build compiles in (contracts/trust/upgrade/upgrade-keys.json): read it,
  pin a publisher in it, and refuse to build a release with no publisher pinned (finding F1).
.DESCRIPTION
  Dot-source this file; it defines functions and nothing else. The schema is contracts/schemas/agent/upgrade-keys.schema.json
  and every field here exists because the agent reads it: commonName and organization must match the signing certificate's
  subject exactly, and root is the SHA-256 of the DER of the certificate in rootFile.
#>

function Read-UpgradeKeys([string] $UpgradeKeysFile) {
    if (-not (Test-Path $UpgradeKeysFile)) { throw "The upgrade trust list $UpgradeKeysFile does not exist." }
    $doc = Get-Content -Raw $UpgradeKeysFile | ConvertFrom-Json
    foreach ($field in 'version', 'keys', 'publishers') {
        if (-not ($doc.PSObject.Properties.Name -contains $field)) { throw "$UpgradeKeysFile has no '$field'." }
    }
    return $doc
}

# ConvertFrom-Json gives $null for an empty array and a bare object for a one-element array; both would silently pass a
# count check. Everything that reads keys or publishers goes through these two.
# Both return with the comma operator: PowerShell unwraps a bare array on return, so an empty list would arrive as $null
# and every $list.Count would fail on it.
function Get-KeyList($Doc) { if ($null -eq $Doc.keys -or @($Doc.keys).Count -eq 0) { return , @() } ; return , @($Doc.keys) }
function Get-PublisherList($Doc) { if ($null -eq $Doc.publishers -or @($Doc.publishers).Count -eq 0) { return , @() } ; return , @($Doc.publishers) }

# Reads a PEM certificate from a file without .NET's PEM file reader, which refuses some of the PEMs this repository
# writes (it takes the file for a key file and reports the contents as malformed). The base64 between the markers is the
# DER, and that is what gets hashed and compared anyway.
function Read-PemCertificate([string] $Path) {
    if (-not (Test-Path $Path)) { throw "The certificate $Path does not exist." }
    $text = Get-Content -Raw $Path
    $match = [regex]::Match($text, '(?s)-----BEGIN CERTIFICATE-----(.+?)-----END CERTIFICATE-----')
    if (-not $match.Success) { throw "$Path is not a PEM certificate." }
    $der = [Convert]::FromBase64String(($match.Groups[1].Value -replace '\s', ''))
    # The byte[] constructor is deprecated in .NET 9 in favour of X509CertificateLoader; this repository runs pwsh 7.
    return [Security.Cryptography.X509Certificates.X509Certificate2]::new($der)
}

function Get-CertificateRootSha256([string] $RootFile) {
    $cert = Read-PemCertificate $RootFile
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($cert.RawData)).ToLowerInvariant()
}

# Puts a publisher in the list, replacing any entry with the same common name (that is what rotating a certificate under
# the same name looks like). Returns the document as written.
function Set-Publisher([string] $UpgradeKeysFile, [string] $CommonName, [string] $Organization, [string] $RootSha256, [string] $RootFile) {
    if (-not $CommonName -or -not $Organization) { throw 'A publisher needs an exact common name and organization.' }
    # -cnotmatch, not -notmatch: PowerShell's -match ignores case, so an upper-case name or hash would pass a check whose
    # whole point is that the file names and hashes in it are lower-case.
    if ($RootFile -cnotmatch '^[a-z0-9-]{1,64}\.pem$') { throw "The root's file name must be lower-case like agent-code-signing-root.pem, not '$RootFile'." }
    if ($RootSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'The pinned root hash must be 64 lower-case hex characters of the root certificate.' }
    $doc = Read-UpgradeKeys $UpgradeKeysFile
    $existing = Get-PublisherList $doc            # assigned first: piping the helper's result would test the array, not its entries
    $publishers = @($existing | Where-Object { $_.commonName -ne $CommonName })
    if ($publishers.Count -ge 2) {
        throw "An agent holds at most two publishers: the one it uses and the next one. $UpgradeKeysFile already has $(@($publishers).Count), so retire one before pinning another."
    }
    $publishers += [ordered]@{ commonName = $CommonName; organization = $Organization; root = $RootSha256; rootFile = $RootFile }
    # Assigned to variables first, then wrapped: @(Get-KeyList $doc) would nest the list inside another list, and the
    # contract schema rejects that, so the release keys would be lost the day someone validated the file closely.
    $existingKeys = Get-KeyList $doc
    $out = [ordered]@{ version = [int]$doc.version; keys = @($existingKeys); publishers = @($publishers) }
    Set-Content -LiteralPath $UpgradeKeysFile -Value (($out | ConvertTo-Json -Depth 5) + "`n") -Encoding utf8NoBOM -NoNewline
    return ($out | ConvertTo-Json -Depth 5 | ConvertFrom-Json)
}

# The gate: a release built for cabinets has to name the publisher whose signature every binary carries, and the root it
# refers to has to be the root actually in the folder, or the agent refuses the release after it has been shipped.
function Assert-PublisherPinned([string] $UpgradeTrustDir) {
    $path = Join-Path $UpgradeTrustDir 'upgrade-keys.json'
    $doc = Read-UpgradeKeys $path
    $publishers = Get-PublisherList $doc
    if ($publishers.Count -eq 0) {
        throw "The upgrade trust list $path pins no code-signing publisher, so the agent would refuse every release built with it (F1). Pin one with agent/install/New-PublisherRoot.ps1, or build a test release with -AllowUnsignedForTest."
    }
    foreach ($p in $publishers) {
        foreach ($field in 'commonName', 'organization', 'root', 'rootFile') {
            if (-not ($p.PSObject.Properties.Name -contains $field) -or -not $p.$field) { throw "The publisher in $path has no '$field'." }
        }
        $actual = Get-CertificateRootSha256 (Join-Path $UpgradeTrustDir $p.rootFile)
        if ($actual -ne $p.root) {
            throw "The pinned root for $($p.commonName) does not match its file: $path says $($p.root), $($p.rootFile) hashes to $actual. The agent refuses such a release, and so does this."
        }
    }
    return $publishers.Count
}
