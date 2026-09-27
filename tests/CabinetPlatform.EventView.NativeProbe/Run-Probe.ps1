param([string]$ProbeDirectory = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$exe = Join-Path $ProbeDirectory 'CabinetPlatform.EventView.NativeProbe.exe'
if (!(Test-Path -LiteralPath $exe)) { throw 'Probe executable missing' }
$outDir = Join-Path $ProbeDirectory ('evidence-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $outDir | Out-Null
$results = @()
foreach ($mode in @('synthetic', 'broad', 'disk', 'no-providers', 'no-ids', 'one-provider', 'empty-control', 'invalid-query')) {
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $exe
    $start.Arguments = $mode
    $start.WorkingDirectory = $ProbeDirectory
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    # No inherited Agent/server configuration, credentials or .NET startup hooks.
    $start.EnvironmentVariables.Clear()
    foreach ($key in @('SystemRoot', 'WINDIR', 'TEMP', 'TMP')) {
        $value = [Environment]::GetEnvironmentVariable($key)
        if ($value) { $start.EnvironmentVariables[$key] = $value }
    }
    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $start
    try {
        if (!$p.Start()) { throw 'Probe did not start' }
        $stdout = $p.StandardOutput.ReadToEndAsync()
        $stderr = $p.StandardError.ReadToEndAsync()
        $timedOut = !$p.WaitForExit(30000)
        if ($timedOut) { $p.Kill(); $p.WaitForExit() }
        [IO.File]::WriteAllText((Join-Path $outDir ($mode + '.jsonl')), $stdout.GetAwaiter().GetResult())
        [IO.File]::WriteAllText((Join-Path $outDir ($mode + '.stderr.txt')), $stderr.GetAwaiter().GetResult())
        $expected = if ($mode -eq 'invalid-query') { 3 } else { 0 }
        $results += [pscustomobject]@{ mode = $mode; exitCode = $p.ExitCode; expected = $expected; timedOut = $timedOut; accepted = (!$timedOut -and $p.ExitCode -eq $expected) }
    } finally { $p.Dispose() }
}
$results | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outDir 'summary.json') -Encoding UTF8
$results | Format-Table -AutoSize
Write-Output ('Evidence directory: ' + $outDir)
if (@($results | Where-Object { !$_.accepted }).Count -gt 0) { exit 1 }
exit 0
