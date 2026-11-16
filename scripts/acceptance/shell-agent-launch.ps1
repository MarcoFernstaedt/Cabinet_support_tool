param([switch]$Supervisor)
$ErrorActionPreference = 'Stop'
$state = Join-Path $PSScriptRoot 'process-state.json'
if (-not $Supervisor) {
    Remove-Item -LiteralPath (Join-Path $PSScriptRoot 'agent.pid'), $state -ErrorAction SilentlyContinue
    # WMI owns the supervisor outside the SSH session job. Only the script path
    # crosses the command line; the executable and arguments live in our JSON file.
    $command = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Supervisor'
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $command; CurrentDirectory = $PSScriptRoot }
    if ($result.ReturnValue -ne 0) { throw "WMI process creation failed: $($result.ReturnValue)" }
    exit 0
}
try {
    $config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'shell-agent-launch.json') | ConvertFrom-Json
    $p = Start-Process -FilePath $config.exe -ArgumentList $config.args -RedirectStandardOutput (Join-Path $PSScriptRoot 'run.out') -RedirectStandardError (Join-Path $PSScriptRoot 'run.err') -PassThru
    $handle = $p.Handle
    $p.Id | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'agent.pid')
    $p.WaitForExit()
    @{ pid = $p.Id; state = 'exited'; exitCode = $p.ExitCode } | ConvertTo-Json -Compress | Set-Content -LiteralPath ($state + '.tmp')
    Move-Item -LiteralPath ($state + '.tmp') -Destination $state -Force
} catch {
    @{ state = 'launch-failed'; exitCode = $null; error = $_.ToString() } | ConvertTo-Json -Compress | Set-Content -LiteralPath ($state + '.tmp')
    Move-Item -LiteralPath ($state + '.tmp') -Destination $state -Force
    throw
}
