# Audit setup is a short-lived process, not an ambient production helper import.
param([Parameter(Mandatory=$true)][string]$Manifest,
      [Parameter(Mandatory=$true)][string]$ApprovedGuestIdentity,
      [Parameter(Mandatory=$true)][string]$ApprovedSnapshot)
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
$powershell="$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$guard=Join-Path $PSScriptRoot 'DisposableServiceFixture.ps1'
& $powershell -NoProfile -NonInteractive -File $guard -Action Gate -Manifest $Manifest -ApprovedGuestIdentity $ApprovedGuestIdentity -ApprovedSnapshot $ApprovedSnapshot
if($LASTEXITCODE -ne 0){throw 'Audit fixture guest/target gate refused'}
$service=(Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json).Service
Add-Type -TypeDefinition @'
using System;using System.ComponentModel;using System.Runtime.InteropServices;using System.Security.AccessControl;
public static class ManualFixtureAudit {
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenSCManager(string a,string b,uint c);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenService(IntPtr a,string b,uint c);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetServiceObjectSecurity(IntPtr a,uint b,byte[] c);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool QueryServiceObjectSecurity(IntPtr a,uint b,byte[] c,uint length,out uint needed);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LookupPrivilegeValue(string system,string name,out Luid luid);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token,bool disable,ref TokenPrivileges state,uint length,out TokenPrivileges previous,out uint returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
 [StructLayout(LayoutKind.Sequential)] struct TokenPrivileges { public uint Count; public Luid Luid; public uint Attributes; }
 const int ERROR_NOT_ALL_ASSIGNED=1300;
 [DllImport("advapi32.dll")] public static extern bool CloseServiceHandle(IntPtr a);
 static RawSecurityDescriptor Read(IntPtr service,uint info){uint needed;QueryServiceObjectSecurity(service,info,new byte[0],0,out needed);if(needed==0||needed>65536)throw new InvalidOperationException("Security descriptor size refused");var bytes=new byte[needed];if(!QueryServiceObjectSecurity(service,info,bytes,needed,out needed))throw new Win32Exception(Marshal.GetLastWin32Error());return new RawSecurityDescriptor(bytes,0);}
 public static void Audit(string name){IntPtr token=IntPtr.Zero,manager=IntPtr.Zero,service=IntPtr.Zero;TokenPrivileges previous=new TokenPrivileges();uint returned=0;bool adjusted=false;try{
  if(!OpenProcessToken(GetCurrentProcess(),0x28,out token))throw new Win32Exception(Marshal.GetLastWin32Error());
  Luid luid;if(!LookupPrivilegeValue(null,"SeSecurityPrivilege",out luid))throw new Win32Exception(Marshal.GetLastWin32Error());
  var enabled=new TokenPrivileges{Count=1,Luid=luid,Attributes=2};
  if(!AdjustTokenPrivileges(token,false,ref enabled,(uint)Marshal.SizeOf(typeof(TokenPrivileges)),out previous,out returned))throw new Win32Exception(Marshal.GetLastWin32Error());
  adjusted=true;if(Marshal.GetLastWin32Error()==ERROR_NOT_ALL_ASSIGNED)throw new InvalidOperationException("SeSecurityPrivilege unavailable");
  manager=OpenSCManager(null,null,1);if(manager==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
  service=OpenService(manager,name,0x01000000);if(service==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
  var intended=new RawSecurityDescriptor("S:(AU;SA;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;WD)");byte[] bytes=new byte[intended.BinaryLength];intended.GetBinaryForm(bytes,0);
  if(!SetServiceObjectSecurity(service,8,bytes))throw new Win32Exception(Marshal.GetLastWin32Error());
  var actual=Read(service,8);if(actual.SystemAcl==null || actual.GetSddlForm(AccessControlSections.Audit)!=intended.GetSddlForm(AccessControlSections.Audit))throw new InvalidOperationException("AuditReadback mismatch");
 }finally{if(service!=IntPtr.Zero)CloseServiceHandle(service);if(manager!=IntPtr.Zero)CloseServiceHandle(manager);
  if(adjusted){TokenPrivileges ignored;uint length;if(!AdjustTokenPrivileges(token,false,ref previous,(uint)Marshal.SizeOf(typeof(TokenPrivileges)),out ignored,out length)||Marshal.GetLastWin32Error()==ERROR_NOT_ALL_ASSIGNED)throw new InvalidOperationException("SeSecurityPrivilege restoration failed");}
  if(token!=IntPtr.Zero)CloseHandle(token);
 }}

}
'@
[ManualFixtureAudit]::Audit($service)
Write-Output 'AUDIT_SACL_READBACK_PASS'
