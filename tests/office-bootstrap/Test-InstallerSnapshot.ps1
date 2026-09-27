# Safe local fixture for Windows PowerShell 5.1 on a disposable lab machine.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
$folder = Join-Path $env:TEMP ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $folder | Out-Null
$path = Join-Path $folder 'synthetic.zip'
$replacement = Join-Path $folder 'replacement.zip'
try {
    $writer = [IO.FileStream]::new($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $archive = [IO.Compression.ZipArchive]::new($writer, [IO.Compression.ZipArchiveMode]::Create, $true)
        try {
            $member = $archive.CreateEntry('inert.txt')
            $stream = $member.Open()
            try {
                $bytes = [Text.Encoding]::UTF8.GetBytes('synthetic')
                $stream.Write($bytes, 0, $bytes.Length)
            } finally { $stream.Dispose() }
        } finally { $archive.Dispose() }
    } finally { $writer.Dispose() }
    [IO.File]::WriteAllBytes($replacement, [byte[]](1, 2, 3))
    $retained = [IO.FileStream]::new($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $digest = [BitConverter]::ToString($sha.ComputeHash($retained)).Replace('-', '') }
        finally { $sha.Dispose() }
        if ($digest.Length -ne 64) { throw 'Hash failed.' }
        $retained.Position = 0
        $writeDenied = $false
        try {
            $other = [IO.FileStream]::new($path, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
            $other.Dispose()
        } catch [IO.IOException] { $writeDenied = $true }
        $replaceDenied = $false
        try { [IO.File]::Replace($replacement, $path, $null) }
        catch [IO.IOException] { $replaceDenied = $true }
        if (!$writeDenied -or !$replaceDenied) { throw 'Retained stream did not deny write and replacement.' }
        $archive = [IO.Compression.ZipArchive]::new($retained, [IO.Compression.ZipArchiveMode]::Read, $true)
        try {
            if ($archive.GetEntry('inert.txt').Length -ne 9) { throw 'Archive was not read from retained stream.' }
        } finally { $archive.Dispose() }
        Write-Output 'PASS: write and replacement denied while hash and archive use one retained stream.'
    } finally { $retained.Dispose() }
} finally {
    Remove-Item -LiteralPath $folder -Recurse -Force
}
