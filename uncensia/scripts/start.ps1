# Starts Uncensia for real use: server in the background, Cloudflare tunnel in
# front of it, logs and pids under run/. Safe to run when it is already up —
# it stops the previous instance first.
#
#   default    start the tunnel and listen on the LAN as well
#   -Local     skip the tunnel, listen on 127.0.0.1 only
#   -Port      override the listening port (the tunnel expects the default)
#   -NoComfy   leave the image backend alone

param(
  [int]$Port = 8090,
  [switch]$Local,
  [switch]$NoComfy
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'common.ps1')
$root = Get-UncensiaProjectRoot
$nodeExe = Get-UncensiaNode $root
$node = Split-Path -Parent $nodeExe
$runDir = Join-Path $root "run"
$tunnelDir = Join-Path $root "runtime\cloudflared"

$env:PATH = "$node;$env:PATH"
$env:UNCENSIA_PORT = "$Port"
$env:UNCENSIA_HOST = if ($Local) { "127.0.0.1" } else { "0.0.0.0" }
# Behind the tunnel every request arrives from 127.0.0.1, so without this the
# per-client lockout has a single bucket the whole internet shares — and the
# security screen cannot tell an HTTPS connection from a plaintext one. Declared
# only when something really is in front: read unconditionally, a forwarded
# address is a fresh rate-limit budget per request and a forwarded protocol is
# whatever the caller says it is.
if ($Local) {
  Remove-Item Env:UNCENSIA_TRUST_PROXY, Env:LUMA_TRUST_PROXY -ErrorAction SilentlyContinue
} else {
  $env:UNCENSIA_TRUST_PROXY = "1"
}
# restart.ps1 sets a throwaway code for development; it must never seed a real run.
Remove-Item Env:UNCENSIA_ACCESS_CODE, Env:LUMA_ACCESS_CODE -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

Set-Location $root

# ComfyUI takes far longer to load than Uncensia does, and Uncensia starts fine without
# it, so let it warm up alongside the build instead of gating startup on it.
# Invoked as a script rather than with -FilePath, which would run the file's
# contents as a bare scriptblock and leave $PSScriptRoot empty inside it.
$comfy = $null
if (-not $NoComfy) {
  $comfyScript = Join-Path $PSScriptRoot "comfy.ps1"
  $comfy = Start-Job -ScriptBlock { & $using:comfyScript }
}

if (-not (Test-Path (Join-Path $root "node_modules"))) {
  Write-Host "installing dependencies..."
  & npm.cmd ci --silent
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
}

# The server hands out a static bundle, so a stale dist would silently serve
# yesterday's UI. Rebuilding takes under a second.
Write-Host "building web bundle..."
& npm.cmd run build --silent | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Web build failed; the existing server was kept running' }

& (Join-Path $PSScriptRoot "stop.ps1") | Out-Null

$log = Join-Path $runDir "uncensia.log"
$errLog = Join-Path $runDir "uncensia.err.log"
$process = Start-Process -FilePath $nodeExe `
  -ArgumentList "--import", "tsx", "src\server\main.ts" `
  -WorkingDirectory $root -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $log -RedirectStandardError $errLog
$process.Id | Set-Content (Join-Path $runDir "uncensia.pid")

$ready = $false
foreach ($attempt in 1..40) {
  Start-Sleep -Milliseconds 500
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$Port/v1/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
    $ready = $true
    break
  } catch { }
}
if (-not $ready) {
  Write-Host "server did not come up; last output:" -ForegroundColor Red
  Get-Content $log, $errLog -Tail 20 -ErrorAction SilentlyContinue
  exit 1
}
Write-Host "Uncensia is up on http://127.0.0.1:$Port (pid $($process.Id))"
if (-not $Local) {
  Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
    Select-Object -ExpandProperty IPAddress -Unique |
    ForEach-Object { Write-Host "LAN address: http://${_}:$Port" }
}

if (-not $Local) {
  $exe = Join-Path $tunnelDir "cloudflared.exe"
  $config = Join-Path $tunnelDir "config.yml"
  if (Test-Path $exe) {
    $tunnel = Start-Process -FilePath $exe `
      -ArgumentList "--config", "`"$config`"", "tunnel", "run" `
      -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $runDir "tunnel.log") `
      -RedirectStandardError (Join-Path $runDir "tunnel.err.log")
    $tunnel.Id | Set-Content (Join-Path $runDir "tunnel.pid")
    Start-Sleep -Seconds 3
    $hostname = (Select-String -Path $config -Pattern "hostname:\s*(\S+)").Matches.Groups[1].Value
    Write-Host "Public address: https://$hostname (pid $($tunnel.Id))"
  } else {
    Write-Host "cloudflared not found at $exe; running local-only." -ForegroundColor Yellow
  }
}

& (Join-Path $PSScriptRoot "show-code.ps1")

# Last, because a cold ComfyUI can take a minute and the access code should not
# wait behind it.
if ($comfy) {
  Receive-Job -Job $comfy -Wait -AutoRemoveJob | ForEach-Object { Write-Host $_ }
}
