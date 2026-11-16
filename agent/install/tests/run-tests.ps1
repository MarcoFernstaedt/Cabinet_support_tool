<#
.SYNOPSIS
  Tests for the publisher root, the trust list and the release gate (agent/install/TrustFolder.ps1, New-PublisherRoot.ps1,
  New-AgentRelease.ps1). Plain PowerShell, no Pester, so it runs wherever pwsh 7 does.
.DESCRIPTION
  Run it: pwsh -File agent/install/tests/run-tests.ps1   (exit code 0 = all passed)
  Every case here exists because of a way the fleet, not just the build, could end up broken: a private key inside the
  checkout, a pinned root that is not the root in the folder, a release packaged with its signature check skipped.
#>
[CmdletBinding()]
param([switch] $KeepWork)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Run these tests with PowerShell 7 or later.' }
$install = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repo = (Resolve-Path (Join-Path $install '..\..')).Path
. (Join-Path $install 'TrustFolder.ps1')
$runner = Join-Path $install 'New-PublisherRoot.ps1'
$release = Join-Path $install 'New-AgentRelease.ps1'

# A stand-in for a published program: the release script reads the PE Machine field at 0x44, so these files are exactly
# that header and nothing else. Nothing here is executed, and nothing is signed, which is the point of the cases below.
function New-FakePe([string] $Path, [int] $Machine) {
    $bytes = [byte[]]::new(0x100)
    $bytes[0] = 0x4D; $bytes[1] = 0x5A
    [BitConverter]::GetBytes([int]0x40).CopyTo($bytes, 0x3C)
    $bytes[0x40] = 0x50; $bytes[0x41] = 0x45
    [BitConverter]::GetBytes([uint16]$Machine).CopyTo($bytes, 0x44)
    [IO.File]::WriteAllBytes($Path, $bytes)
}

$script:passed = 0
$script:failed = 0
function Test-That([string] $Name, [scriptblock] $Body) {
    try { & $Body; $script:passed++; Write-Host "ok   $Name" }
    catch { $script:failed++; Write-Host "FAIL $Name`n       $($_.Exception.Message)" }
}
function Assert-True($Condition, [string] $Because) { if (-not $Condition) { throw "Expected $Because." } }
function Assert-Equal($Expected, $Actual, [string] $What) { if ($Expected -ne $Actual) { throw "${What}: expected '$Expected', got '$Actual'." } }
function Assert-Throws([scriptblock] $Body, [string] $MessagePart) {
    try { & $Body } catch {
        if ($MessagePart -and $_.Exception.Message -notlike "*$MessagePart*") { throw "Threw, but not about '$MessagePart': $($_.Exception.Message)" }
        return
    }
    throw "Expected it to refuse and say something about '$MessagePart', and it did not throw."
}

$work = Join-Path ([IO.Path]::GetTempPath()) ("publisher-root-tests-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$keys = Join-Path $work 'keys'                 # outside the repository, as the script requires
$keys2 = Join-Path $work 'keys-2'
$trust = Join-Path $work 'trust'               # a stand-in for contracts/trust/upgrade
New-Item -ItemType Directory -Force -Path $trust, $keys2 | Out-Null
# A release key already in the list, as the committed one has: pinning a publisher must not disturb it.
$existingKeyId = 'a' * 64
$existing = [ordered]@{ version = 1; keys = @([ordered]@{ keyId = $existingKeyId; name = 'Release key'; publicKey = 'A' * 124 }); publishers = @() }
Set-Content -LiteralPath (Join-Path $trust 'upgrade-keys.json') -Value (($existing | ConvertTo-Json -Depth 5) + "`n") -Encoding utf8NoBOM -NoNewline

try {
    Test-That 'refuses to write the private keys inside the repository' {
        $inside = Join-Path $repo 'agent\install\publisher-keys-test'
        Assert-Throws { & $runner -KeyDir $inside -UpgradeKeysFile (Join-Path $trust 'upgrade-keys.json') } 'must never be written inside the repository'
        Assert-True (-not (Test-Path $inside)) 'the directory is not created when the key directory is refused'
    }

    Test-That 'creates a root and an issuing certificate, and pins the publisher in the trust list' {
        & $runner -KeyDir $keys -CommonName 'Mashura Code Signing' -Organization 'Mashura LLC' -UpgradeKeysFile (Join-Path $trust 'upgrade-keys.json') | Out-Null
        $rootPem = Join-Path $keys 'publisher-root.cert.pem'
        $issPem = Join-Path $keys 'publisher-issuing.cert.pem'
        foreach ($f in $rootPem, (Join-Path $keys 'publisher-root.cer'), (Join-Path $keys 'publisher-root.key.pem'), $issPem, (Join-Path $keys 'publisher-issuing.key.pem')) {
            Assert-True (Test-Path $f) "$f exists"
        }
        $doc = Read-UpgradeKeys (Join-Path $trust 'upgrade-keys.json')
        $publishers = Get-PublisherList $doc
        Assert-Equal 1 $publishers.Count 'publishers pinned'
        Assert-Equal 'Mashura Code Signing' $publishers[0].commonName 'the pinned common name'
        Assert-Equal 'Mashura LLC' $publishers[0].organization 'the pinned organization'
        Assert-Equal 'agent-code-signing-root.pem' $publishers[0].rootFile 'the pinned root file name'
        Assert-Equal (Get-CertificateRootSha256 (Join-Path $trust 'agent-code-signing-root.pem')) $publishers[0].root 'the pinned root hash'
        Assert-Equal 1 (Get-KeyList $doc).Count 'release keys kept'
        Assert-Equal $existingKeyId (Get-KeyList $doc)[0].keyId 'the release key that was there is untouched'
        Assert-Equal 1 (Assert-PublisherPinned $trust) 'the consistent list passes the gate'
    }

    Test-That 'the issuing certificate chains to the root and signs with its key' {
        $rootKey = [Security.Cryptography.ECDsa]::Create(); $rootKey.ImportFromPem((Get-Content -Raw (Join-Path $keys 'publisher-root.key.pem')))
        $issKey = [Security.Cryptography.ECDsa]::Create(); $issKey.ImportFromPem((Get-Content -Raw (Join-Path $keys 'publisher-issuing.key.pem')))
        $rootCert = Read-PemCertificate (Join-Path $keys 'publisher-root.cert.pem')
        $issCert = Read-PemCertificate (Join-Path $keys 'publisher-issuing.cert.pem')
        $blob = [Text.Encoding]::UTF8.GetBytes('a release build the fleet has to accept')
        $issPublic = [Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPublicKey($issCert)
        $rootPublic = [Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPublicKey($rootCert)
        Assert-True ($issPublic.VerifyData($blob, $issKey.SignData($blob, 'SHA256'), 'SHA256')) 'the issuing certificate verifies its own signature'
        Assert-True ($rootPublic.VerifyData($blob, $rootKey.SignData($blob, 'SHA256'), 'SHA256')) 'the root key signs with the root certificate'
        $chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
        $chain.ChainPolicy.TrustMode = [Security.Cryptography.X509Certificates.X509ChainTrustMode]::CustomRootTrust
        $chain.ChainPolicy.CustomTrustStore.Add($rootCert)
        $chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
        Assert-True ($chain.Build($issCert)) 'the issuing certificate chains to the pinned root'
        Assert-True (-not $issCert.HasPrivateKey) 'the certificate written for machines carries no private key'
    }

    Test-That 'running again reuses the root instead of making a second one' {
        $before = [IO.File]::ReadAllBytes((Join-Path $keys 'publisher-root.cer'))
        & $runner -KeyDir $keys -CommonName 'Mashura Code Signing' -Organization 'Mashura LLC' -UpgradeKeysFile (Join-Path $trust 'upgrade-keys.json') | Out-Null
        $after = [IO.File]::ReadAllBytes((Join-Path $keys 'publisher-root.cer'))
        Assert-Equal ([Convert]::ToHexString($before)) ([Convert]::ToHexString($after)) 'the root certificate is unchanged'
        Assert-Equal 1 (Get-PublisherList (Read-UpgradeKeys (Join-Path $trust 'upgrade-keys.json'))).Count 'still one publisher, not two'
    }

    Test-That 'creates a second, independent root when asked for one' {
        & $runner -KeyDir $keys2 -CommonName 'Mashura Test Signing' -Organization 'Mashura LLC' | Out-Null
        $a = Get-CertificateRootSha256 (Join-Path $keys 'publisher-root.cert.pem')
        $b = Get-CertificateRootSha256 (Join-Path $keys2 'publisher-root.cert.pem')
        Assert-True ($a -ne $b) 'the second root is a different certificate'
    }

    Test-That 'refuses a third publisher: an agent holds two, the one it uses and the next' {
        $two = [ordered]@{ version = 1; keys = @(); publishers = @(
            [ordered]@{ commonName = 'A'; organization = 'A'; root = 'a' * 64; rootFile = 'a.pem' },
            [ordered]@{ commonName = 'B'; organization = 'B'; root = 'b' * 64; rootFile = 'b.pem' }) }
        $path = Join-Path $work 'two-publishers.json'
        Set-Content -LiteralPath $path -Value (($two | ConvertTo-Json -Depth 5) + "`n") -Encoding utf8NoBOM -NoNewline
        Assert-Throws { Set-Publisher -UpgradeKeysFile $path -CommonName 'C' -Organization 'C' -RootSha256 ('c' * 64) -RootFile 'c.pem' } 'at most two publishers'
        Assert-Throws { Set-Publisher -UpgradeKeysFile $path -CommonName 'D' -Organization 'D' -RootSha256 'nonsense' -RootFile 'd.pem' } 'lower-case hex'
        Assert-Throws { Set-Publisher -UpgradeKeysFile $path -CommonName 'D' -Organization 'D' -RootSha256 ('d' * 64) -RootFile 'D.pem' } 'lower-case like'
    }

    Test-That 'the gate refuses a trust list with no publisher, and one whose pinned root is not the root in the folder' {
        $empty = Join-Path $work 'empty-trust'
        New-Item -ItemType Directory -Force -Path $empty | Out-Null
        Set-Content -LiteralPath (Join-Path $empty 'upgrade-keys.json') -Value (([ordered]@{ version = 1; keys = @(); publishers = @() } | ConvertTo-Json -Depth 5) + "`n") -Encoding utf8NoBOM -NoNewline
        Assert-Throws { Assert-PublisherPinned $empty } 'pins no code-signing publisher'
        # A root that was swapped after the list was written: the hash in the list no longer describes the file.
        Copy-Item -Recurse $trust (Join-Path $work 'swapped-trust')
        Set-Content -LiteralPath (Join-Path $work 'swapped-trust\agent-code-signing-root.pem') -Value (Get-Content -Raw (Join-Path $keys2 'publisher-root.cert.pem')) -NoNewline -Encoding ascii
        Assert-Throws { Assert-PublisherPinned (Join-Path $work 'swapped-trust') } 'does not match its file'
        Assert-Equal 1 (Assert-PublisherPinned $trust) 'the list that is consistent passes'
    }

    Test-That 'the release script refuses to package a release it cannot check' {
        $fake = Join-Path $work 'publish'
        New-Item -ItemType Directory -Force -Path (Join-Path $fake 'Cabinet.Agent.Broker'), (Join-Path $fake 'Cabinet.Agent.Network'), (Join-Path $fake 'Cabinet.Agent.Updater') | Out-Null
        foreach ($name in 'Cabinet.Agent.Broker', 'Cabinet.Agent.Network', 'Cabinet.Agent.Updater') { New-FakePe (Join-Path $fake "$name\$name.exe") 0x8664 }
        New-FakePe (Join-Path $fake 'Cabinet.Agent.Broker\Cabinet.Agent.Broker.dll') 0x8664
        $releaseArgs = @{ PublishDir = $fake; Architecture = 'win-x64'; Version = '0.2.0'; MinimumVersion = '0.1.0'; OutDir = (Join-Path $work 'release'); DevKeyFile = (Join-Path $work 'dev-key.pem') }
        & (Join-Path $install 'New-UpgradeTrust.ps1') -NewDevKey $releaseArgs.DevKeyFile -OutDir (Join-Path $work 'dev-trust') | Out-Null
        if ($IsWindows -or $env:OS -eq 'Windows_NT') {
            # On Windows the check runs instead of being refused, and these binaries are not signed by anyone.
            Assert-Throws { & $release @releaseArgs -UpgradeTrustDir (Join-Path $work 'dev-trust') } 'not validly Authenticode-signed'
        } else {
            Assert-Throws { & $release @releaseArgs -UpgradeTrustDir (Join-Path $work 'dev-trust') } 'cannot be checked on this host'
        }
        # The test path still works, which is what proves the refusal above is the check and not the packaging.
        & $release @releaseArgs -UpgradeTrustDir (Join-Path $work 'dev-trust') -AllowUnsignedForTest | Out-Null
        foreach ($f in 'agent-0.2.0.zip', 'manifest.json', 'signature.json') { Assert-True (Test-Path (Join-Path $work "release\$f")) "$f was written by a test release" }
    }

    # Windows PowerShell 5.1 ignores -Include when the path was given with -LiteralPath, and 5.1 is the shell the
    # console's own launcher runs. The installer's signature check learned this on a real cabinet: it saw 24 files
    # where 4 are programs, counted the .pdb and .xml shipped beside them, and refused a fully signed release.
    # These tests refuse to run below pwsh 7, where -Include does apply, so the check is made against the source.
    Test-That 'both scripts pick the programs they check by extension, never with -Include' {
        foreach ($name in 'Install-CabinetAgent.ps1', 'Test-CabinetAgent.ps1') {
            $code = @(Get-Content -LiteralPath (Join-Path $install $name) | Where-Object { $_ -notmatch '^\s*#' })
            $scan = @($code | Where-Object { $_ -match 'Get-ChildItem' -and $_ -match 'Extension' })
            Assert-True ($scan.Count -ge 1) "$name to choose the files it checks by extension"
            Assert-True (($scan -join "`n") -match '\.exe') "$name to name .exe"
            foreach ($line in @($code | Where-Object { $_ -match '-Include' })) {
                Assert-True $false "no -Include in $name, but found: $($line.Trim())"
            }
        }
    }
}
finally {
    if ($KeepWork) { Write-Host "work kept in $work" } else { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }
}
Write-Host ""
Write-Host "$($script:passed) passed, $($script:failed) failed."
if ($script:failed) { exit 1 }
