# Prints the access code from the encrypted vault.

. (Join-Path $PSScriptRoot 'common.ps1')
$root = Get-UncensiaProjectRoot
$nodeExe = Get-UncensiaNode $root
$node = Split-Path -Parent $nodeExe
$env:PATH = "$node;$env:PATH"

Set-Location $root
$code = & $nodeExe --import tsx scripts\access-code.ts
Write-Host ""
Write-Host "Access code: $code" -ForegroundColor Cyan
Write-Host ""
