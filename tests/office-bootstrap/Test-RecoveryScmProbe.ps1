# Only a uniquely named, inert ServiceBase probe. No Agent service calls.
param([switch]$MetadataOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$helper = Join-Path $PSScriptRoot 'Restore-CabinetDemoAgent.ps1'
$t = $null; $e = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($helper, [ref]$t, [ref]$e)
if ($e.Count) { throw 'Recovery helper parse failure.' }
foreach ($d in $ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] }) {
    . ([scriptblock]::Create($d.Extent.Text))
}
$serviceName = 'CabinetRecoveryProbe-' + [guid]::NewGuid().ToString('N')
$root = Join-Path $env:TEMP ('CabinetRecoveryProbe-' + [guid]::NewGuid().ToString('N'))
$install = Join-Path $root 'Inert Probe'
New-Item -ItemType Directory -Path $install -Force | Out-Null
$exe = Join-Path $install 'CabinetPlatform.Agent.exe'
# Independently inspect this source before execution. No I/O, Agent, network or application code.
$source = 'using System.ServiceProcess; public sealed class InertProbe:ServiceBase { public InertProbe(){ServiceName="' + $serviceName + '";AutoLog=false;} protected override void OnStart(string[] args){System.Threading.Thread.Sleep(2000);} protected override void OnStop(){System.Threading.Thread.Sleep(2000);} public static void Main(){ServiceBase.Run(new InertProbe());}}'
Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.ServiceProcess.dll' -OutputAssembly $exe -OutputType ConsoleApplication
if ((Get-Item -LiteralPath $exe).Length -eq 0 -or (Get-Service -Name $serviceName -ErrorAction SilentlyContinue)) { throw 'Probe precondition failed.' }
$intent = Join-Path $root 'intent.txt'
[IO.File]::WriteAllText($intent, "probe=$serviceName`r`nimage=$exe`r`ncreate disabled, read, delayed start/stop, pending deletion, exact cleanup; repeat rollback phase`r`n")
Write-Output "INTENT_PERSISTED=$intent SERVICE=$serviceName"
try {
    foreach ($phase in @('replacement','rollback')) {
        try {
            Service-CreateDisabled
            $s = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
            if (!$s -or $s.PathName -cne ('"' + $exe + '"') -or $s.State -cne 'Stopped' -or $s.StartMode -cne 'Disabled' -or $s.StartName -cne 'LocalSystem') { throw "SCM readback mismatch at $phase" }
            $d = Service-Recovery
            if ($d.Reset -ne 86400 -or $d.Count -ne 3 -or $d.ActionSequence -cne '1/60000;1/120000;1/300000;' -or !$d.FailureFlag -or $d.Delayed -or $d.Sid -ne 0 -or $d.TriggerCount -ne 0) { throw "Typed SCM policy mismatch at $phase" }
            Write-Output "SCM_QUOTED_MATCH=$phase TYPED_POLICY_MATCH=$phase DACL_DEFAULT=$($d.Dacl -ceq 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)')"
            if (!$MetadataOnly) {
            Service-SetStart 'demand'
            $controller=[System.ServiceProcess.ServiceController]::new($serviceName)
            try {
                try { $controller.Start() } catch { throw ('Probe start failed: ' + $_.Exception.ToString()) }
                $controller.Refresh()
                if ($controller.Status -ne 'StartPending') { throw 'Controlled start did not enter pending state' }
                if ((Service-WaitTerminal) -ne 'Running') { throw 'Delayed start not reconciled' }
                $controller.Stop()
                $controller.Refresh()
                if ($controller.Status -ne 'StopPending') { throw 'Controlled stop did not enter pending state' }
                if ((Service-WaitTerminal) -ne 'Stopped') { throw 'Delayed stop not reconciled' }
                Write-Output "NATIVE_DELAYED_TRANSITIONS=$phase"
            } finally { $controller.Dispose() }
            }
            # Roundtrip captured harmless metadata, including HP's zero-action policy.
            $original = Service-Recovery
            $empty = Service-Recovery
            $empty.Reset=0; $empty.Count=0; $empty.ActionSequence=''; $empty.FailureFlag=$false
            [CabinetRecoveryDefinition]::ApplyPolicy($serviceName,$empty)
            if ((Service-Recovery).Policy -cne $empty.Policy) { throw 'Empty captured policy did not roundtrip' }
            [CabinetRecoveryDefinition]::ApplyPolicy($serviceName,$original)
            if ((Service-Recovery).Policy -cne $original.Policy) { throw 'Original captured policy not restored' }
            Write-Output "CAPTURED_POLICY_ROUNDTRIP=$phase"
        } finally {
            $state=Service-Read
            if ($state -and $state.State -ne 'Stopped') { Service-Stop }
            $held=[System.ServiceProcess.ServiceController]::new($serviceName)
            $heldHandle=$held.ServiceHandle
            & "$env:SystemRoot\System32\sc.exe" delete $serviceName | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Probe delete failed: $serviceName" }
            try {
                $watch=[Diagnostics.Stopwatch]::StartNew();$refused=$false
                try { Service-WaitAbsent } catch { $refused=$true }
                if (!$refused -or $watch.Elapsed.TotalSeconds -gt 45) { throw 'Pending deletion was not bounded and refused' }
                Write-Output "NATIVE_PENDING_DELETION_REFUSED=$phase"
            } finally { $heldHandle.Dispose(); $held.Dispose() }
            for ($i=0; $i -lt 30; $i++) {
                if (!(Get-Service -Name $serviceName -ErrorAction SilentlyContinue)) { break }
                Start-Sleep -Seconds 1
            }
            if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { throw "Probe deletion pending: $serviceName" }
            Write-Output "PROBE_ABSENT=$phase"
        }
    }
} finally {
    if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { throw "PROBE CLEANUP REQUIRED $serviceName at $root" }
    Remove-Item -LiteralPath $root -Recurse -Force
    if (Test-Path -LiteralPath $root) { throw "Probe directory cleanup failed: $root" }
    Write-Output "PROBE_ROOT_ABSENT=$root"
}
