# UNVERIFIED on a real runner: prepares the SQL Server Express that GitHub's Windows images carry, for the platform-server steps of the
# Windows job: starts it, switches on mixed-mode sign-in and TCP on port 1433, sets sa's password, and prints the owner URL.
# If the image has no SQL Server Express, install one first (choco install sql-server-express).
param([Parameter(Mandatory)][string]$SaPassword)
$ErrorActionPreference = 'Stop'
$instance = 'SQLEXPRESS'
$service = "MSSQL`$$instance"
$base = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server'
$id = (Get-ItemProperty "$base\Instance Names\SQL").$instance
if (-not $id) { throw "No SQL Server instance $instance on this image." }
Set-ItemProperty "$base\$id\MSSQLServer" -Name LoginMode -Value 2                       # mixed mode
$tcp = "$base\$id\MSSQLServer\SuperSocketNetLib\Tcp"
Set-ItemProperty $tcp -Name Enabled -Value 1
Set-ItemProperty "$tcp\IPAll" -Name TcpDynamicPorts -Value ''
Set-ItemProperty "$tcp\IPAll" -Name TcpPort -Value '1433'
Set-Service $service -StartupType Automatic
Restart-Service $service -Force
# Windows authentication (this runner's administrator) sets sa's password and enables it.
$sqlcmd = (Get-Command sqlcmd -ErrorAction Stop).Source
for ($i = 0; $i -lt 30; $i++) { & $sqlcmd -S ".\$instance" -E -Q 'SELECT 1' -b -o NUL; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 2 }
& $sqlcmd -S ".\$instance" -E -b -Q "ALTER LOGIN sa ENABLE; ALTER LOGIN sa WITH PASSWORD = N'$SaPassword', CHECK_POLICY = OFF"
if ($LASTEXITCODE -ne 0) { throw 'Could not set up sa.' }
"sqlserver://sa:$([uri]::EscapeDataString($SaPassword))@localhost:1433/cabinet?trustServerCertificate=true"
