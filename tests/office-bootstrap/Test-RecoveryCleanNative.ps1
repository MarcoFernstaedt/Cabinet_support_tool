# Native-only regression. The parent compiles a uniquely named inert service;
# each transaction runs in a fresh Windows PowerShell 5.1 process.
param([ValidateSet('success','prestart','poststart')][string]$Scenario='success')
throw "Native fixture disabled: legacy entrypoint has no exact guest/manifest gate."
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.ToString() -notlike '5.1.*') { throw 'Windows PowerShell 5.1 required' }
$serviceName='CabinetRecoveryClean-' + [guid]::NewGuid().ToString('N')
$root=Join-Path $env:ProgramData $serviceName
$install=Join-Path $root 'Synthetic'; $backup=Join-Path $root 'Backup'
$helper=Join-Path $PSScriptRoot 'Restore-CabinetDemoAgent.ps1'
$child=Join-Path $PSScriptRoot 'Test-RecoveryCleanNativeChild.ps1'
if (!(Test-Path $helper) -or !(Test-Path (Join-Path $PSScriptRoot 'RecoveryProcess.cs')) -or (Test-Path $root) -or (Get-Service $serviceName -ErrorAction SilentlyContinue)) { throw 'Fixture precondition failed' }
$intent=Join-Path $env:ProgramData ($serviceName + '.intent.txt')
[IO.File]::WriteAllText($intent,"service=$serviceName`r`nroot=$root`r`nscenario=$Scenario`r`n")
Write-Output "INTENT=$intent SERVICE=$serviceName ROOT=$root"
try {
 New-Item -ItemType Directory -Path $install,$backup,(Join-Path $install 'state') -Force | Out-Null
 $exe=Join-Path $install 'CabinetPlatform.Agent.exe'
 $source='using System.ServiceProcess; public sealed class InertClean:ServiceBase {public InertClean(){ServiceName="'+$serviceName+'";AutoLog=false;} protected override void OnStart(string[] args){System.Threading.Thread.Sleep(500);} protected override void OnStop(){System.Threading.Thread.Sleep(500);} public static void Main(){ServiceBase.Run(new InertClean());}}'
 Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.ServiceProcess.dll' -OutputAssembly $exe -OutputType ConsoleApplication
 $endpoint='https://srv1522777.tail72f980.ts.net/'
 $config=@{Agent=@{ServerBaseUrl=$endpoint;OfficeEnrollmentFile='office-enrollment.json';StateDirectory='C:/Program Files/Mashura/CabinetAgent/state';LogDirectory='C:/Program Files/Mashura/CabinetAgent/logs';Buffer=@{Directory='C:/Program Files/Mashura/CabinetAgent/buffer'};Actions=@{ExecutionMode='DiagnosticOnly';DiagnosticBundleDirectory='C:/Program Files/Mashura/CabinetAgent/bundles'}}}|ConvertTo-Json -Depth 10
 [IO.File]::WriteAllText((Join-Path $install 'appsettings.json'),$config)
 [IO.File]::WriteAllText((Join-Path $install 'office-enrollment.json.device'),('{"ServerBaseUrl":"'+$endpoint+'","MachineId":"synthetic-clean","DeviceKey":"'+('A'*64)+'","Confirmed":true}'))
 [IO.File]::WriteAllText((Join-Path $install 'state\agent-state.json'),' {"MachineId":"synthetic-clean","CabinetId":"synthetic-cabinet"}')
 foreach($p in @($root,$install,$backup,(Join-Path $install 'state'))){& "$env:SystemRoot\System32\icacls.exe" $p /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null;if($LASTEXITCODE){throw 'Directory ACL failed'}}
 foreach($p in @($exe,(Join-Path $install 'appsettings.json'),(Join-Path $install 'office-enrollment.json.device'),(Join-Path $install 'state\agent-state.json'))){& "$env:SystemRoot\System32\icacls.exe" $p /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null;if($LASTEXITCODE){throw 'File ACL failed'}}
 New-Service -Name $serviceName -BinaryPathName ('"'+$exe+'"') -DisplayName 'Cabinet Recovery Inert Clean' -StartupType Manual | Out-Null
 Start-Service $serviceName
 & "$env:SystemRoot\System32\sc.exe" config $serviceName start= auto | Out-Null
 if($LASTEXITCODE){throw 'Start mode setup failed'}
 & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -File $child $helper $serviceName $install $backup $Scenario
 $exit=$LASTEXITCODE
 Write-Output "CHILD_EXIT=$exit SCENARIO=$Scenario"
 if($exit -ne 0){throw "Clean native regression failed: $Scenario exit $exit"}
} finally {
 $svc=Get-Service $serviceName -ErrorAction SilentlyContinue
 if($svc){if($svc.Status -ne 'Stopped'){Stop-Service $serviceName -ErrorAction Stop;$svc.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))}; & "$env:SystemRoot\System32\sc.exe" delete $serviceName | Out-Null; if($LASTEXITCODE){throw 'Exact service cleanup failed'}}
 for($i=0;$i -lt 30;$i++){if(!(Get-Service $serviceName -ErrorAction SilentlyContinue)){break};Start-Sleep -Seconds 1}
 if(Get-Service $serviceName -ErrorAction SilentlyContinue){throw "CLEANUP_REQUIRED service=$serviceName root=$root"}
 Write-Output 'EXACT_SERVICE_ABSENT'
 if(Test-Path $root){Remove-Item -LiteralPath $root -Recurse -Force}
 if(Test-Path $root){throw "CLEANUP_REQUIRED root=$root"}
 Write-Output 'EXACT_ROOT_ABSENT'
}
