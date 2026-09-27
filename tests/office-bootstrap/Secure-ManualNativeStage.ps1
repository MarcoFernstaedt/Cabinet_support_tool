$ErrorActionPreference='Stop'
$p=Join-Path $env:ProgramData 'CabinetManualNativeStage'
if (!(Test-Path -LiteralPath $p)) { throw 'Stage absent' }
& "$env:SystemRoot\System32\icacls.exe" $p /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE) { throw 'Stage ACL failed' }
$acl=Get-Acl -LiteralPath $p
foreach($ace in $acl.Access){if($ace.AccessControlType -eq 'Allow' -and $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18','S-1-5-32-544')){throw 'Untrusted stage ACL'}}
Write-Output 'PRIVATE_STAGE_PASS'
