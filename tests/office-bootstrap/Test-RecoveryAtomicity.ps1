$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$helper=Join-Path $PSScriptRoot 'Restore-CabinetDemoAgent.ps1'
# Source tested in this worktree, never the production entry point.
$t=$null;$e=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($helper,[ref]$t,[ref]$e)
foreach($d in $ast.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst]}){. ([scriptblock]::Create($d.Extent.Text))}
$trusted=@('S-1-5-18','S-1-5-32-544');$endpoint='https://srv1522777.tail72f980.ts.net/'
$root=Join-Path $env:TEMP ('CabinetAtomicityReview-'+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory $root|Out-Null
$install=Join-Path $root 'Synthetic';$backup=Join-Path $root 'Backup';New-Item -ItemType Directory $backup|Out-Null;Lock-Directory $backup
$script:checks=0
function Start-Sleep { param([int]$Seconds) } # Fast synthetic pending loop only.
function Check($v,$label){if(!$v){throw "HARNESS FAILURE $label"};$script:checks++;Write-Output "OBSERVED $label"}
function Fixture {
 if(Test-Path $install){Remove-Item $install -Recurse -Force};New-Item -ItemType Directory $install|Out-Null;Lock-Directory $install
 New-Item -ItemType Directory (Join-Path $install 'state')|Out-Null
 $c=@{Agent=@{ServerBaseUrl=$endpoint;OfficeEnrollmentFile='office-enrollment.json';StateDirectory='C:/Program Files/Mashura/CabinetAgent/state';LogDirectory='C:/Program Files/Mashura/CabinetAgent/logs';Buffer=@{Directory='C:/Program Files/Mashura/CabinetAgent/buffer'};Actions=@{ExecutionMode='DiagnosticOnly';DiagnosticBundleDirectory='C:/Program Files/Mashura/CabinetAgent/bundles'}}}|ConvertTo-Json -Depth 10
 $f=@{'CabinetPlatform.Agent.exe'='old';'appsettings.json'=$c;'office-enrollment.json.device'='{"ServerBaseUrl":"https://srv1522777.tail72f980.ts.net/","MachineId":"synthetic-id","DeviceKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","Confirmed":true}';'state\agent-state.json'='{"MachineId":"synthetic-id","CabinetId":"synthetic-cabinet"}'}
 foreach($n in $f.Keys){[IO.File]::WriteAllText((Join-Path $install $n),$f[$n])}
 $script:exists=$true;$script:state='Running';$script:mode='Auto';$script:policy='baseline';$script:fault='';$script:starts=0;$script:deletes=0;$script:deleteWhileRunning=$false
}
function Service-Read {if(!$script:exists){return $null};[pscustomobject]@{State=$script:state;StartName='LocalSystem';StartMode=$script:mode;PathName=('"'+$install+'\CabinetPlatform.Agent.exe"');DisplayName='Mashura Cabinet Support Agent'}}
function Service-Recovery {[pscustomobject]@{Policy=$script:policy}}
function Service-Admission { if ($script:policy -ne 'baseline') { Refuse 'Unsupported original service recovery policy.' } }
function Assert-ExecutionEnvironment {} # Synthetic adapter, not an SCM environment proof.
function Service-Stop {if($script:fault -eq 'stop-pending'){$script:state='Stop Pending';throw 'timeout waiting stop'};$script:state='Stopped'}
function Service-Delete {$script:deletes++;if($script:state -eq 'Running'){$script:deleteWhileRunning=$true};$script:exists=$false;if($script:fault -eq 'delete-after'){$script:fault='';throw 'external delete succeeded then transport failed'}}
function Service-CreateDisabled {$script:exists=$true;$script:mode='Disabled';$script:state='Stopped';if($script:fault -eq 'policy'){$script:policy='hardcoded-default'}}
function Service-SetStart($v){$script:mode=@{auto='Auto';demand='Manual';disabled='Disabled'}[$v]}
function Service-Start {$script:starts++;if($script:fault -eq 'start-pending'){$script:state='Start Pending';[IO.File]::WriteAllText((Join-Path $install 'office-enrollment.json.device'),'newer synthetic journal');throw 'start unresolved'};$script:state='Running'}
$realSameTree=${function:Same-Tree}
function Move-Item {param([string]$LiteralPath,[string]$Destination,[string]$ErrorAction)
 Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination -ErrorAction Stop
 if($script:fault -eq 'move-after' -and $LiteralPath -eq $install){$script:fault='';throw 'move succeeded then reported error'}
}
function Same-Tree($expected,$path){& $realSameTree $expected $path;if($script:fault -eq 'restart' -and $path.EndsWith('original-copy')){$script:state='Running'}}
$package=@{'cabinetplatform.agent.exe'=[pscustomobject]@{Name='CabinetPlatform.Agent.exe';Bytes=[Text.Encoding]::UTF8.GetBytes('new')}}
try {
 foreach($scenario in @('policy','stop-pending','move-after','restart','start-pending')){
  Fixture;$script:fault=$scenario;if($scenario -eq 'policy'){$script:policy='nondefault'};$message='';try{Invoke-Recovery $package $backup|Out-Null}catch{$message=$_.Exception.Message}
  Write-Output "CASE=$scenario RESULT=$message STATE=$script:state MODE=$script:mode STARTS=$script:starts DELETES=$script:deletes"
  switch($scenario){
   'policy' {Check ($message -like '*Unsupported original service recovery policy*' -and $script:state -eq 'Running' -and $script:policy -eq 'nondefault' -and $script:deletes -eq 0 -and $script:starts -eq 0) 'nondefault original policy refused before stop'}
   'stop-pending' {Check ($message -notlike '*Original service restored*' -and $script:state -eq 'Stop Pending' -and $script:deletes -eq 0) 'unresolved stop does not claim restored'}
   'delete-after' {Check ($message -like 'Recovery failed before start*' -and $script:state -eq 'Running' -and [IO.File]::ReadAllText((Join-Path $install 'CabinetPlatform.Agent.exe')) -eq 'old') 'effectful delete error reconciles and restores original'}
   'move-after' {Check ($message -like 'Recovery failed before start*' -and $script:state -eq 'Running' -and [IO.File]::ReadAllText((Join-Path $install 'CabinetPlatform.Agent.exe')) -eq 'old') 'effectful move error reconciles and restores original'}
   'restart' {Check (!$script:deleteWhileRunning -and $script:deletes -eq 0 -and $message -like '*recovery incomplete*') 'concurrent restart blocked before deletion'}
   'start-pending' {Check ($message -like '*Fail-stop unresolved*' -and $script:state -eq 'Start Pending' -and $script:mode -eq 'Disabled' -and [IO.File]::ReadAllText((Join-Path $install 'office-enrollment.json.device')) -eq 'newer synthetic journal') 'pending start unverified, newer journal retained'}
  }
 }
 Write-Output "checks=$script:checks"
}finally{Remove-Item -LiteralPath $root -Recurse -Force;if(Test-Path $root){throw 'cleanup failed'};Write-Output 'SYNTHETIC_CLEANUP_VERIFIED'}
