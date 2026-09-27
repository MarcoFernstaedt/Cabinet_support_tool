# Disposable native two-process manual reinstall, no production Agent targeting.
param([ValidateSet('success','prestart','poststart','tamper','inherited-read','owner','group','preshutdown','pending-deletion','alias','audit-sacl','destination-replacement')][string]$Scenario='success',
      [Parameter(Mandatory=$true)][string]$ApprovedGuestIdentity,
      [Parameter(Mandatory=$true)][string]$ApprovedSnapshot)
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.ToString() -notlike '5.1.*') { throw 'Windows PowerShell 5.1 required' }
$powershell="$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$guard=Join-Path $PSScriptRoot 'DisposableServiceFixture.ps1'
& $powershell -NoProfile -NonInteractive -File $guard -Action MachineGate -ApprovedGuestIdentity $ApprovedGuestIdentity -ApprovedSnapshot $ApprovedSnapshot
if ($LASTEXITCODE -ne 0) { throw 'Disposable machine gate failed before fixture creation.' }
$serviceName='CabinetManualProbe-'+[guid]::NewGuid().ToString('N')
$root=Join-Path $env:ProgramData $serviceName
$fixtureManifestPath=Join-Path $root 'fixture-target.json'
Set-Variable -Name fixtureManifestPath -Option ReadOnly
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
 $vm=Get-CimInstance Win32_ComputerSystemProduct
 $key=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Cryptography')
 try { $machine=[string]$key.GetValue('MachineGuid') } finally { $key.Dispose() }
 $manifestText=@{Service=$serviceName;Root=$root;Image=$exe;Sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash;
   Machine=$machine;UUID=[string]$vm.UUID;Scenario=$Scenario} | ConvertTo-Json
 $manifestStream=[IO.File]::Open($fixtureManifestPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try { $bytes=[Text.Encoding]::UTF8.GetBytes($manifestText); $manifestStream.Write($bytes,0,$bytes.Length) }
 finally { $manifestStream.Dispose() }
 & "$env:SystemRoot\System32\icacls.exe" $fixtureManifestPath /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
 if ($LASTEXITCODE -ne 0) { throw 'Manifest ACL failed.' }
 & $powershell -NoProfile -NonInteractive -File $guard -Action Gate -Manifest $fixtureManifestPath -ApprovedGuestIdentity $ApprovedGuestIdentity -ApprovedSnapshot $ApprovedSnapshot
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
   $packageManifestJson=@{schema=1;component='agent';endpoint=$endpoint;sourceCommit=$commit;signed=$false;sha256=$hashes}|ConvertTo-Json -Depth 8
   $bytes=[Text.Encoding]::UTF8.GetBytes($packageManifestJson);$entry=$archive.CreateEntry('kit-manifest.json');$writer=$entry.Open();try{$writer.Write($bytes,0,$bytes.Length)}finally{$writer.Dispose()}
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
 & $powershell -NoProfile -NonInteractive -File $guard -Action Gate -Manifest $fixtureManifestPath -ApprovedGuestIdentity $ApprovedGuestIdentity -ApprovedSnapshot $ApprovedSnapshot
 if ($LASTEXITCODE -ne 0) { throw 'Fixture manifest gate failed before SCM creation.' }
 New-Service -Name $serviceName -BinaryPathName ('"'+$exe+'"') -DisplayName 'Cabinet Recovery Inert Manual' -StartupType Manual | Out-Null
 & $powershell -NoProfile -NonInteractive -File $guard -Action Gate -Manifest $fixtureManifestPath -ApprovedGuestIdentity $ApprovedGuestIdentity -ApprovedSnapshot $ApprovedSnapshot
 if ($LASTEXITCODE -ne 0) { throw 'Fixture manifest gate failed before SCM start.' }
 Start-Service $serviceName
 & $powershell -NoProfile -NonInteractive -File $guard -Action Gate -Manifest $fixtureManifestPath -ApprovedGuestIdentity $ApprovedGuestIdentity -ApprovedSnapshot $ApprovedSnapshot
 if ($LASTEXITCODE -ne 0) { throw 'Fixture manifest gate failed before SCM config.' }
 & "$env:SystemRoot\System32\sc.exe" config $serviceName start= auto | Out-Null
 if($LASTEXITCODE){throw 'Start mode setup failed'}
 if($Scenario -eq 'inherited-read'){
  & icacls.exe $root /grant '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
  if($LASTEXITCODE){throw 'Fixture parent reader ACL failed'}
 }
 if($Scenario -in @('owner','group','preshutdown','pending-deletion','audit-sacl')){
  Add-Type -TypeDefinition @'
using System;using System.ComponentModel;using System.Runtime.InteropServices;using System.Security.AccessControl;using System.Security.Principal;
public static class ManualFixtureScm {
 const uint SERVICE_QUERY_CONFIG=0x0001;
 const uint SERVICE_CHANGE_CONFIG=0x0002;
 const uint READ_CONTROL=0x00020000;
 const uint WRITE_OWNER=0x00080000;
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenSCManager(string a,string b,uint c);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenService(IntPtr a,string b,uint c);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetServiceObjectSecurity(IntPtr a,uint b,byte[] c);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool QueryServiceObjectSecurity(IntPtr a,uint b,byte[] c,uint length,out uint needed);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool ChangeServiceConfig2(IntPtr a,uint b,IntPtr c);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool QueryServiceConfig2(IntPtr a,uint b,IntPtr c,uint d,out uint e);
 [DllImport("advapi32.dll")] public static extern bool CloseServiceHandle(IntPtr a);
 public static IntPtr Hold(string name){IntPtr manager=OpenSCManager(null,null,1);try{IntPtr service=OpenService(manager,name,SERVICE_QUERY_CONFIG|SERVICE_CHANGE_CONFIG|READ_CONTROL|WRITE_OWNER);if(service==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());return service;}finally{CloseServiceHandle(manager);}}
 static RawSecurityDescriptor Read(IntPtr service,uint info){uint needed;if(QueryServiceObjectSecurity(service,info,new byte[0],0,out needed)||Marshal.GetLastWin32Error()!=122)throw new InvalidOperationException("Security descriptor size query refused");if(needed==0||needed>8192)throw new InvalidOperationException("Security descriptor size refused");var bytes=new byte[needed];uint returned;if(!QueryServiceObjectSecurity(service,info,bytes,needed,out returned))throw new Win32Exception(Marshal.GetLastWin32Error());if(returned>needed)throw new InvalidOperationException("Security descriptor grew during read");var descriptor=new RawSecurityDescriptor(bytes,0);if(descriptor.BinaryLength>bytes.Length)throw new InvalidOperationException("Incomplete security descriptor read");return descriptor;}
 public static void Owner(IntPtr service){var sid=WindowsIdentity.GetCurrent().User;if(Read(service,1).Owner.Equals(sid))throw new InvalidOperationException("Owner fixture is already default; distinct owner required");var sd=new RawSecurityDescriptor("O:"+sid.Value);byte[] bytes=new byte[sd.BinaryLength];sd.GetBinaryForm(bytes,0);if(!SetServiceObjectSecurity(service,1,bytes))throw new Win32Exception(Marshal.GetLastWin32Error());if(!Read(service,1).Owner.Equals(sid))throw new InvalidOperationException("Owner readback mismatch");}
 public static void Group(IntPtr service){var sid=new SecurityIdentifier("S-1-5-32-545");if(Read(service,2).Group.Equals(sid))throw new InvalidOperationException("Group fixture is already default; distinct group required");var sd=new RawSecurityDescriptor("G:"+sid.Value);byte[] bytes=new byte[sd.BinaryLength];sd.GetBinaryForm(bytes,0);if(!SetServiceObjectSecurity(service,2,bytes))throw new Win32Exception(Marshal.GetLastWin32Error());if(!Read(service,2).Group.Equals(sid))throw new InvalidOperationException("Group readback mismatch");}
 public static uint Preshutdown(IntPtr service,bool set){IntPtr data=Marshal.AllocHGlobal(4);try{if(set){Marshal.WriteInt32(data,12345);if(!ChangeServiceConfig2(service,7,data))throw new Win32Exception(Marshal.GetLastWin32Error());}uint needed;if(!QueryServiceConfig2(service,7,data,4,out needed))throw new Win32Exception(Marshal.GetLastWin32Error());return (uint)Marshal.ReadInt32(data);}finally{Marshal.FreeHGlobal(data);}}
}
'@
  $held=[ManualFixtureScm]::Hold($serviceName)
  if($Scenario -eq 'owner'){[ManualFixtureScm]::Owner($held);[ManualFixtureScm]::CloseServiceHandle($held)|Out-Null;$held=[IntPtr]::Zero}
  if($Scenario -eq 'group'){[ManualFixtureScm]::Group($held);[ManualFixtureScm]::CloseServiceHandle($held)|Out-Null;$held=[IntPtr]::Zero}
  if($Scenario -eq 'preshutdown'){if([ManualFixtureScm]::Preshutdown($held,$true) -ne 12345){throw 'Preshutdown setup failed'};[ManualFixtureScm]::CloseServiceHandle($held)|Out-Null;$held=[IntPtr]::Zero}
  if($Scenario -eq 'audit-sacl'){
   & $powershell -NoProfile -NonInteractive -File $guard -Action Gate -Manifest $fixtureManifestPath -ApprovedGuestIdentity $ApprovedGuestIdentity -ApprovedSnapshot $ApprovedSnapshot
   if ($LASTEXITCODE -ne 0) { throw 'Fixture audit gate failed.' }
   & $powershell -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'Set-DisposableAuditFixture.ps1') -Manifest $fixtureManifestPath -ApprovedGuestIdentity $ApprovedGuestIdentity -ApprovedSnapshot $ApprovedSnapshot
   if($LASTEXITCODE -ne 0){throw 'Audit fixture setup/readback failed'}
   [ManualFixtureScm]::CloseServiceHandle($held)|Out-Null;$held=[IntPtr]::Zero
  }
 }
 & $powershell -NoProfile -NonInteractive -File $guard -Action Gate -Manifest $fixtureManifestPath -ApprovedGuestIdentity $ApprovedGuestIdentity -ApprovedSnapshot $ApprovedSnapshot
 if ($LASTEXITCODE -ne 0) { throw 'Fixture gate failed before child.' }
 $prepareEvidence=@(& $powershell -NoProfile -NonInteractive -File $child (Join-Path $root 'Kit\Manual-Reinstall-CabinetDemoAgent.ps1') $serviceName $install $backup $zip $digest $commit 'prepare' $Scenario $ApprovedGuestIdentity $ApprovedSnapshot)
 $first=$LASTEXITCODE; Write-Output "PREPARE_EXIT=$first"
 if($Scenario -eq 'pending-deletion'){
  if(!$first -or !(Test-Path (Join-Path $backup 'manual-reinstall-*' ))){throw 'Expected held-handle deletion timeout'}
  [ManualFixtureScm]::CloseServiceHandle($held)|Out-Null;$held=[IntPtr]::Zero
  for($i=0;$i -lt 30;$i++){if(!(Get-Service $serviceName -ErrorAction SilentlyContinue)){break};Start-Sleep -Seconds 1}
  if((Get-Service $serviceName -ErrorAction SilentlyContinue) -or (Test-Path $install)){throw 'Pending deletion did not leave restorable layout'}
  Write-Output 'PASS deletion requested but not completed, archive retained after handle release'
  $first=0
 }
 if($Scenario -in @('owner','group','audit-sacl')){
  if($first -ne 42 -or $prepareEvidence.Count -ne 1 -or $prepareEvidence -cne 'EXPECTED_METADATA_REFUSAL') {throw 'Expected production metadata refusal evidence missing'}
  $svc=Get-CimInstance Win32_Service -Filter ("Name='"+$serviceName+"'")
  if(!$svc -or !(Test-Path $install) -or $svc.State -cne 'Running' -or $svc.StartMode -cne 'Auto'){throw 'Unsupported metadata interrupted original Running Auto service'}
  Write-Output "PASS unsupported $Scenario refused before stop"
  return
 }
 $prepareEvidence | Write-Output
 if($first){throw 'Prepare child failed'}
 if(Get-Service $serviceName -ErrorAction SilentlyContinue){throw 'Probe not absent between clean processes'}
 Write-Output 'PASS exact service absent between processes'
 & $powershell -NoProfile -NonInteractive -File $child (Join-Path $root 'Kit\Manual-Reinstall-CabinetDemoAgent.ps1') $serviceName $install $backup $zip $digest $commit 'restore' $Scenario $ApprovedGuestIdentity $ApprovedSnapshot
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
 if (!(Get-Variable fixtureManifestPath -ErrorAction SilentlyContinue) -or !(Test-Path -LiteralPath $fixtureManifestPath)) {
  throw "Fixture manifest unavailable. Preserve intent and inspect exact root: $intent"
 }
 & $powershell -NoProfile -NonInteractive -File $guard -Action Cleanup -Manifest $fixtureManifestPath -ApprovedGuestIdentity $ApprovedGuestIdentity -ApprovedSnapshot $ApprovedSnapshot
 if ($LASTEXITCODE -ne 0) { throw "Fixture cleanup refused. Preserve intent and inspect exact root: $intent" }
}
