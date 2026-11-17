$ErrorActionPreference = 'Continue'
$name = 'srv1522777.tail72f980.ts.net'
try {
  $c = New-Object Net.Sockets.TcpClient
  $c.Connect($name, 8443)
  $ssl = New-Object Net.Security.SslStream($c.GetStream(), $false, { param($s, $cert, $chain, $errors) $true })
  $ssl.AuthenticateAsClient($name)
  Write-Output ("  TLS handshake OK with " + $name + ":8443 -> " + $ssl.RemoteCertificate.Subject)
  $req = "GET /api/health HTTP/1.1" + [char]13 + [char]10 + "Host: " + $name + [char]13 + [char]10 + "Connection: close" + [char]13 + [char]10 + [char]13 + [char]10
  $b = [Text.Encoding]::ASCII.GetBytes($req)
  $ssl.Write($b, 0, $b.Length); $ssl.Flush()
  $buf = New-Object byte[] 256
  $n = $ssl.Read($buf, 0, 256)
  if ($n -gt 0) { Write-Output ("  first response line: " + ([Text.Encoding]::ASCII.GetString($buf, 0, $n)).Split([char]13)[0]) }
  $ssl.Dispose(); $c.Close()
} catch {
  Write-Output ("  TLS preflight FAILED: " + $_.Exception.Message)
}
