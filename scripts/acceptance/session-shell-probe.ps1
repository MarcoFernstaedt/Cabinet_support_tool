# Read-only cabinet preflight, always invoked from the repository acceptance driver.
$ErrorActionPreference = 'Stop'
[ordered]@{
  hostname = $env:COMPUTERNAME
  os = [Environment]::OSVersion.VersionString
  services = @(Get-CimInstance Win32_Service | Where-Object { $_.Name -in @('CabinetAgentNetwork','CabinetAgentBroker') } | Select-Object Name, State, StartName, PathName)
  configuration = if (Test-Path "$env:ProgramData\Mashura\CabinetAgent\agent-config.json") { Get-Content "$env:ProgramData\Mashura\CabinetAgent\agent-config.json" -Raw | ConvertFrom-Json } else { $null }
} | ConvertTo-Json -Depth 8
