# Disposable native two-process manual reinstall, no production Agent targeting.
param([ValidateSet('success','prestart','poststart','tamper')][string]$Scenario='success')
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.ToString() -notlike '5.1.*') { throw 'Windows PowerShell 5.1 required' }
$serviceName='CabinetManualProbe-'+[guid]::NewGuid().ToString('N')
$root=Join-Path $env:ProgramData $serviceName
$install=Join-Path $root 'Synthetic'; $backup=Join-Path $root 'Backup'
$helper=Join-Path $PSScriptRoot 'Restore-CabinetDemoAgent.ps1'
$manual=Join-Path $PSScriptRoot 'Manual-Reinstall-CabinetDemoAgent.ps1'
$child=Join-Path $PSScriptRoot 'Test-ManualReinstallNativeChild.ps1'
if ((Test-Path $root) -or (Get-Service $serviceName -ErrorAction SilentlyContinue)) { throw 'Fixture already exists' }
$intent=Join-Path $env:ProgramData ($serviceName+'.intent.txt')
[IO.File]::WriteAllText($intent,"service=$serviceName`r`nroot=$root`r`nscenario=$Scenario`r`n")
Write-Output "INTENT=$intent SERVICE=$serviceName ROOT=$root"
try {
 New-Item -ItemType Directory -Path $install,$backup,(Join-Path $install 'state'),(Join-Path $root 'Kit') -Force | Out-Null
 $exe=Join-Path $install 'CabinetPlatform.Agent.exe'
 $source='using System.ServiceProcess; public sealed class InertManual:ServiceBase {public InertManual(){ServiceName="'+$serviceName+'";AutoLog=false;} protected override void OnStart(string[] args){System.Threading.Thread.Sleep(400);} protected override void OnStop(){System.Threading.Thread.Sleep(400);} public static void Main(){ServiceBase.Run(new InertManual());}}'
 Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.ServiceProcess.dll' -OutputAssembly $exe -OutputType ConsoleApplication
 $endpoint='https://srv1522777.tail72f980.ts.net/'
 $config=@{Agent=@{ServerBaseUrl=$endpoint;OfficeEnrollmentFile='office-enrollment.json';StateDirectory='C:/Program Files/Mashura/CabinetAgent/state';LogDirectory='C:/Program Files/Mashura/CabinetAgent/logs';Buffer=@{Directory='C:/Program Files/Mashura/CabinetAgent/buffer'};Actions=@{ExecutionMode='DiagnosticOnly';DiagnosticBundleDirectory='C:/Program Files/Mashura/CabinetAgent/bundles'}}}|ConvertTo-Json -Depth 10
 [IO.File]::WriteAllText((Join-Path $install 'appsettings.json'),$config)
 [IO.File]::WriteAllText((Join-Path $install 'office-enrollment.json.device'),('{"ServerBaseUrl":"'+$endpoint+'","MachineId":"synthetic-manual","DeviceKey":"'+('A'*64)+'","Confirmed":true}'))
 [IO.File]::WriteAllText((Join-Path $install 'state\agent-state.json'),' {"MachineId":"synthetic-manual","CabinetId":"synthetic-cabinet"}')
 foreach($p in @($root,$install,$backup,(Join-Path $install 'state'),(Join-Path $root 'Kit'))){& "$env:SystemRoot\System32\icacls.exe" $p /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null;if($LASTEXITCODE){throw 'Directory ACL failed'}}
 foreach($p in @($exe,(Join-Path $install 'appsettings.json'),(Join-Path $install 'office-enrollment.json.device'),(Join-Path $install 'state\agent-state.json'))){& "$env:SystemRoot\System32\icacls.exe" $p /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null;if($LASTEXITCODE){throw 'File ACL failed'}}
 # The executable remains the inert ServiceBase, not a renamed production Agent.
 $zip=Join-Path $root 'Kit\cabinet-agent.zip'; $commit='b685e425e9d92fed7a02012ea19d1cc7bec1f7f8'
 Add-Type -AssemblyName System.IO.Compression
 $stream=[IO.File]::Open($zip,[IO.FileMode]::CreateNew)
 try {
  $archive=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create,$true)
  try {
   $members=@{'CabinetPlatform.Agent.exe'=[IO.File]::ReadAllBytes($exe); 'appsettings.json'=[Text.Encoding]::UTF8.GetBytes($config)}
   $hashes=@{}
   foreach($name in $members.Keys){$hashes[$name]=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($members[$name])).Replace('-','');$entry=$archive.CreateEntry($name);$writer=$entry.Open();try{$writer.Write($members[$name],0,$members[$name].Length)}finally{$writer.Dispose()}}
   $manifest=@{schema=1;component='agent';endpoint=$endpoint;sourceCommit=$commit;signed=$false;sha256=$hashes}|ConvertTo-Json -Depth 8
   $bytes=[Text.Encoding]::UTF8.GetBytes($manifest);$entry=$archive.CreateEntry('kit-manifest.json');$writer=$entry.Open();try{$writer.Write($bytes,0,$bytes.Length)}finally{$writer.Dispose()}
  }finally{$archive.Dispose()}
 }finally{$stream.Dispose()}
 $digest=(Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash
 foreach($name in @('Restore-CabinetDemoAgent.ps1','Manual-Reinstall-CabinetDemoAgent.ps1','RecoveryProcess.cs')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $root "Kit\$name")}
 # Bind only the fixed service and path constants in the disposable helper copy.
 $bound=Join-Path $root 'Kit\Restore-CabinetDemoAgent.ps1'
 $text=[IO.File]::ReadAllText($bound).Replace("`$serviceName = 'CabinetPlatformAgent'",("`$serviceName = '"+$serviceName+"'"))
 $text=$text.Replace("`$install = 'C:\Program Files\Mashura\CabinetAgent'",("`$install = '"+$install+"'"))
 [IO.File]::WriteAllText($bound,$text)
 if($text -notmatch [regex]::Escape("`$serviceName = '"+$serviceName+"'")){throw 'Fixture binding failed'}
 New-Service -Name $serviceName -BinaryPathName ('"'+$exe+'"') -DisplayName 'Cabinet Recovery Inert Manual' -StartupType Manual | Out-Null
 Start-Service $serviceName
 & "$env:SystemRoot\System32\sc.exe" config $serviceName start= auto | Out-Null
 if($LASTEXITCODE){throw 'Start mode setup failed'}
 $powershell="$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
 & $powershell -NoProfile -NonInteractive -File $child (Join-Path $root 'Kit\Manual-Reinstall-CabinetDemoAgent.ps1') $serviceName $install $backup $zip $digest $commit 'prepare' $Scenario
 $first=$LASTEXITCODE; Write-Output "PREPARE_EXIT=$first"
 if($first){throw 'Prepare child failed'}
 if(Get-Service $serviceName -ErrorAction SilentlyContinue){throw 'Probe not absent between clean processes'}
 Write-Output 'PASS exact service absent between processes'
 & $powershell -NoProfile -NonInteractive -File $child (Join-Path $root 'Kit\Manual-Reinstall-CabinetDemoAgent.ps1') $serviceName $install $backup $zip $digest $commit 'restore' $Scenario
 $second=$LASTEXITCODE;Write-Output "RESTORE_EXIT=$second"
 if($second){throw 'Restore child failed'}
} finally {
 $svc=Get-Service $serviceName -ErrorAction SilentlyContinue
 if($svc){if($svc.Status -ne 'Stopped'){Stop-Service $serviceName -ErrorAction Stop;$svc.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))}; & "$env:SystemRoot\System32\sc.exe" delete $serviceName | Out-Null;if($LASTEXITCODE){throw 'Exact service cleanup failed'}}
 for($i=0;$i -lt 30;$i++){if(!(Get-Service $serviceName -ErrorAction SilentlyContinue)){break};Start-Sleep -Seconds 1}
 if(Get-Service $serviceName -ErrorAction SilentlyContinue){throw "CLEANUP_REQUIRED service=$serviceName root=$root"}
 Write-Output 'EXACT_SERVICE_ABSENT'
 if(Test-Path $root){Remove-Item -LiteralPath $root -Recurse -Force}
 if(Test-Path $root){throw "CLEANUP_REQUIRED root=$root"}
 Write-Output 'EXACT_ROOT_ABSENT'
}
