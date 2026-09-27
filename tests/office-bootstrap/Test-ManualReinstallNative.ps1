# Disposable native two-process manual reinstall, no production Agent targeting.
param([ValidateSet('success','prestart','poststart','tamper','inherited-read','owner-group','preshutdown','pending-deletion','alias','audit-sacl','destination-replacement')][string]$Scenario='success')
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.ToString() -notlike '5.1.*') { throw 'Windows PowerShell 5.1 required' }
$powershell="$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$guard=Join-Path $PSScriptRoot 'DisposableServiceFixture.ps1'
& $powershell -NoProfile -NonInteractive -File $guard -Action MachineGate
if ($LASTEXITCODE -ne 0) { throw 'Disposable machine gate failed before fixture creation.' }
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
 $manifest=Join-Path $root 'fixture-target.json'
 $vm=Get-CimInstance Win32_ComputerSystemProduct
 $key=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Cryptography')
 try { $machine=[string]$key.GetValue('MachineGuid') } finally { $key.Dispose() }
 @{Service=$serviceName;Root=$root;Image=$exe;Sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash;
   Machine=$machine;UUID=[string]$vm.UUID;Scenario=$Scenario} | ConvertTo-Json | Set-Content -LiteralPath $manifest
 & "$env:SystemRoot\System32\icacls.exe" $manifest /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
 if ($LASTEXITCODE -ne 0) { throw 'Manifest ACL failed.' }
 & $powershell -NoProfile -NonInteractive -File $guard -Action Gate -Manifest $manifest
 if ($LASTEXITCODE -ne 0) { throw 'Fixture manifest gate failed before SCM creation.' }
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
 foreach($name in @('Restore-CabinetDemoAgent.ps1','Manual-Reinstall-CabinetDemoAgent.ps1','RecoveryProcess.cs','DisposableServiceFixture.ps1')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $root "Kit\$name")}
 # Bind only the fixed service and path constants in the disposable helper copy.
 $bound=Join-Path $root 'Kit\Restore-CabinetDemoAgent.ps1'
 $text=[IO.File]::ReadAllText($bound).Replace("`$serviceName = 'CabinetPlatformAgent'",("`$serviceName = '"+$serviceName+"'"))
 $text=$text.Replace("`$install = 'C:\Program Files\Mashura\CabinetAgent'",("`$install = '"+$install+"'"))
 [IO.File]::WriteAllText($bound,$text)
 if($text -notmatch [regex]::Escape("`$serviceName = '"+$serviceName+"'") -or
    $text -notmatch [regex]::Escape("`$install = '"+$install+"'") -or
    $text -match [regex]::Escape("`$serviceName = 'CabinetPlatformAgent'")) {throw 'Fixture binding failed'}
 & $powershell -NoProfile -NonInteractive -File $guard -Action Gate -Manifest $manifest
 if ($LASTEXITCODE -ne 0) { throw 'Fixture manifest gate failed before SCM creation.' }
 New-Service -Name $serviceName -BinaryPathName ('"'+$exe+'"') -DisplayName 'Cabinet Recovery Inert Manual' -StartupType Manual | Out-Null
 & $powershell -NoProfile -NonInteractive -File $guard -Action Gate -Manifest $manifest
 if ($LASTEXITCODE -ne 0) { throw 'Fixture manifest gate failed before SCM start.' }
 Start-Service $serviceName
 & $powershell -NoProfile -NonInteractive -File $guard -Action Gate -Manifest $manifest
 if ($LASTEXITCODE -ne 0) { throw 'Fixture manifest gate failed before SCM config.' }
 & "$env:SystemRoot\System32\sc.exe" config $serviceName start= auto | Out-Null
 if($LASTEXITCODE){throw 'Start mode setup failed'}
 if($Scenario -eq 'inherited-read'){
  & icacls.exe $root /grant '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
  if($LASTEXITCODE){throw 'Fixture parent reader ACL failed'}
 }
 if($Scenario -in @('owner-group','preshutdown','pending-deletion','audit-sacl')){
  Add-Type -TypeDefinition @'
using System;using System.ComponentModel;using System.Runtime.InteropServices;using System.Security.AccessControl;
public static class ManualFixtureScm {
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenSCManager(string a,string b,uint c);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenService(IntPtr a,string b,uint c);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetServiceObjectSecurity(IntPtr a,uint b,byte[] c);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool ChangeServiceConfig2(IntPtr a,uint b,IntPtr c);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool QueryServiceConfig2(IntPtr a,uint b,IntPtr c,uint d,out uint e);
 [DllImport("advapi32.dll")] public static extern bool CloseServiceHandle(IntPtr a);
 public static IntPtr Hold(string name){IntPtr manager=OpenSCManager(null,null,1);try{IntPtr service=OpenService(manager,name,0x80003);if(service==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());return service;}finally{CloseServiceHandle(manager);}}
 public static void Audit(string name){IntPtr manager=OpenSCManager(null,null,1),service=IntPtr.Zero;try{if(manager==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());service=OpenService(manager,name,0x01000000);if(service==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());var sd=new RawSecurityDescriptor("S:(AU;SA;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;WD)");byte[] bytes=new byte[sd.BinaryLength];sd.GetBinaryForm(bytes,0);if(!SetServiceObjectSecurity(service,8,bytes))throw new Win32Exception(Marshal.GetLastWin32Error());}finally{if(service!=IntPtr.Zero)CloseServiceHandle(service);if(manager!=IntPtr.Zero)CloseServiceHandle(manager);}}
 public static void Group(IntPtr service){var sd=new RawSecurityDescriptor("O:BAG:BA");byte[] bytes=new byte[sd.BinaryLength];sd.GetBinaryForm(bytes,0);if(!SetServiceObjectSecurity(service,2,bytes))throw new Win32Exception(Marshal.GetLastWin32Error());}
 public static uint Preshutdown(IntPtr service,bool set){IntPtr data=Marshal.AllocHGlobal(4);try{if(set){Marshal.WriteInt32(data,12345);if(!ChangeServiceConfig2(service,7,data))throw new Win32Exception(Marshal.GetLastWin32Error());}uint needed;if(!QueryServiceConfig2(service,7,data,4,out needed))throw new Win32Exception(Marshal.GetLastWin32Error());return (uint)Marshal.ReadInt32(data);}finally{Marshal.FreeHGlobal(data);}}
}
'@
  $held=[ManualFixtureScm]::Hold($serviceName)
  if($Scenario -eq 'owner-group'){[ManualFixtureScm]::Group($held);[ManualFixtureScm]::CloseServiceHandle($held)|Out-Null;$held=[IntPtr]::Zero}
  if($Scenario -eq 'preshutdown'){if([ManualFixtureScm]::Preshutdown($held,$true) -ne 12345){throw 'Preshutdown setup failed'};[ManualFixtureScm]::CloseServiceHandle($held)|Out-Null;$held=[IntPtr]::Zero}
  if($Scenario -eq 'audit-sacl'){
   & $powershell -NoProfile -NonInteractive -File $guard -Action Gate -Manifest $manifest
   if ($LASTEXITCODE -ne 0) { throw 'Fixture audit gate failed.' }
   [ManualFixtureScm]::Audit($serviceName)
   [ManualFixtureScm]::CloseServiceHandle($held)|Out-Null;$held=[IntPtr]::Zero
  }
 }
 & $powershell -NoProfile -NonInteractive -File $guard -Action Gate -Manifest $manifest
 if ($LASTEXITCODE -ne 0) { throw 'Fixture gate failed before child.' }
 & $powershell -NoProfile -NonInteractive -File $child (Join-Path $root 'Kit\Manual-Reinstall-CabinetDemoAgent.ps1') $serviceName $install $backup $zip $digest $commit 'prepare' $Scenario
 $first=$LASTEXITCODE; Write-Output "PREPARE_EXIT=$first"
 if($Scenario -eq 'pending-deletion'){
  if(!$first -or !(Test-Path (Join-Path $backup 'manual-reinstall-*' ))){throw 'Expected held-handle deletion timeout'}
  [ManualFixtureScm]::CloseServiceHandle($held)|Out-Null;$held=[IntPtr]::Zero
  for($i=0;$i -lt 30;$i++){if(!(Get-Service $serviceName -ErrorAction SilentlyContinue)){break};Start-Sleep -Seconds 1}
  if((Get-Service $serviceName -ErrorAction SilentlyContinue) -or (Test-Path $install)){throw 'Pending deletion did not leave restorable layout'}
  Write-Output 'PASS deletion requested but not completed, archive retained after handle release'
  $first=0
 }
 if($Scenario -in @('owner-group','audit-sacl')){
  if(!$first -or !(Get-Service $serviceName -ErrorAction SilentlyContinue) -or !(Test-Path $install)){throw 'Unsupported metadata was not refused before stop'}
  if((Get-Service $serviceName).Status -ne 'Running'){throw 'Unsupported metadata interrupted original service'}
  Write-Output "PASS unsupported $Scenario refused before stop"
  return
 }
 if($first){throw 'Prepare child failed'}
 if(Get-Service $serviceName -ErrorAction SilentlyContinue){throw 'Probe not absent between clean processes'}
 Write-Output 'PASS exact service absent between processes'
 & $powershell -NoProfile -NonInteractive -File $child (Join-Path $root 'Kit\Manual-Reinstall-CabinetDemoAgent.ps1') $serviceName $install $backup $zip $digest $commit 'restore' $Scenario
 $second=$LASTEXITCODE;Write-Output "RESTORE_EXIT=$second"
 if($second){throw 'Restore child failed'}
 if($Scenario -eq 'preshutdown'){
  $query=[ManualFixtureScm]::Hold($serviceName)
  try{if([ManualFixtureScm]::Preshutdown($query,$false) -ne 12345){throw 'Preshutdown metadata lost'}}finally{[ManualFixtureScm]::CloseServiceHandle($query)|Out-Null}
  Write-Output 'PASS preshutdown preserved after service recreation'
 }
 if($Scenario -eq 'inherited-read'){
  $device=Join-Path $install 'office-enrollment.json.device'
  $rules=(Get-Acl $device).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
  if(@($rules | Where-Object {$_.IdentityReference.Value -eq 'S-1-5-32-545' -and $_.AccessControlType -eq 'Allow'}).Count){throw 'Synthetic device journal inherited Users access'}
  Write-Output 'PASS synthetic identity copied privately beneath shared vendor parent'
 }
} finally {
 if((Get-Variable held -ErrorAction SilentlyContinue) -and $held -ne [IntPtr]::Zero){[ManualFixtureScm]::CloseServiceHandle($held)|Out-Null}
 if (!(Get-Variable manifest -ErrorAction SilentlyContinue) -or !(Test-Path -LiteralPath $manifest)) {
  throw "Fixture manifest unavailable. Preserve intent and inspect exact root: $intent"
 }
 & $powershell -NoProfile -NonInteractive -File $guard -Action Cleanup -Manifest $manifest
 if ($LASTEXITCODE -ne 0) { throw "Fixture cleanup refused. Preserve intent and inspect exact root: $intent" }
}
