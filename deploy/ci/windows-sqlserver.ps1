# Prepares a SQL Server Express instance for the platform-server steps of the Windows job: installs one when the image has
# none (windows-2025 images carry no SQL Server), starts it, switches on mixed-mode sign-in and TCP on port 1433, sets sa's
# password, and prints the owner URL. CI only: the install is a pinned Chocolatey package on a throwaway runner.
param([Parameter(Mandatory)][string]$SaPassword)
$ErrorActionPreference = 'Stop'
$instance = 'SQLEXPRESS'
# Pinned: the Chocolatey package for Microsoft SQL Server 2022 Express (approved, 2022-11-28), whose instance is SQLEXPRESS.
$expressPackageVersion = '2022.16.0.1000'
$service = "MSSQL`$$instance"
$base = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server'
function Get-InstanceId {
    # Asked without -ErrorAction Stop: on an image with no SQL Server the key is absent, and that is an answer, not a failure.
    $names = Get-ItemProperty "$base\Instance Names\SQL" -ErrorAction SilentlyContinue
    if ($names) { $names.$instance } else { $null }
}
$id = Get-InstanceId
if (-not $id) {
    Write-Host "No SQL Server instance $instance on this image; installing SQL Server 2022 Express ($expressPackageVersion)."
    $choco = (Get-Command choco -ErrorAction SilentlyContinue).Source
    if (-not $choco) { throw "No SQL Server instance $instance on this image, and Chocolatey is not there to install one." }
    & $choco install sql-server-express --version $expressPackageVersion -y --no-progress
    if ($LASTEXITCODE -ne 0) { throw "Installing SQL Server Express $expressPackageVersion failed (choco exit $LASTEXITCODE)." }
    $id = Get-InstanceId
    if (-not $id) { throw "SQL Server Express $expressPackageVersion installed, but there is still no instance named $instance." }
}
Write-Host "SQL Server instance $instance ($id)."
Set-ItemProperty "$base\$id\MSSQLServer" -Name LoginMode -Value 2                       # mixed mode
$tcp = "$base\$id\MSSQLServer\SuperSocketNetLib\Tcp"
Set-ItemProperty $tcp -Name Enabled -Value 1
Set-ItemProperty "$tcp\IPAll" -Name TcpDynamicPorts -Value ''
Set-ItemProperty "$tcp\IPAll" -Name TcpPort -Value '1433'
Set-Service $service -StartupType Automatic
Restart-Service $service -Force
# Windows authentication (this runner's administrator) sets sa's password and enables it.
$sqlcmd = (Get-Command sqlcmd -ErrorAction SilentlyContinue).Source
if (-not $sqlcmd) { throw 'sqlcmd is not on this runner, so sa cannot be set up with Windows authentication.' }
for ($i = 0; $i -lt 30; $i++) { & $sqlcmd -S ".\$instance" -E -Q 'SELECT 1' -b -o NUL; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 2 }
& $sqlcmd -S ".\$instance" -E -b -Q "ALTER LOGIN sa ENABLE; ALTER LOGIN sa WITH PASSWORD = N'$SaPassword', CHECK_POLICY = OFF"
if ($LASTEXITCODE -ne 0) { throw 'Could not set up sa.' }
"sqlserver://sa:$([uri]::EscapeDataString($SaPassword))@localhost:1433/cabinet?trustServerCertificate=true"
