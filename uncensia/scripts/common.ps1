# Resolve compatibility junctions to the current source checkout.
function Get-UncensiaProjectRoot {
  $scripts = Get-Item -LiteralPath $PSScriptRoot
  if ($scripts.LinkType -and $scripts.Target) { return Split-Path -Parent @($scripts.Target)[0] }
  return Split-Path -Parent $PSScriptRoot
}

# Resolve the same supported runtime for Windows operational scripts.
function Get-UncensiaNode {
  param([string]$ProjectRoot)
  $bundled = Join-Path $ProjectRoot 'runtime\node\node.exe'
  $systemNode = (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  foreach ($candidate in @($bundled, $systemNode)) {
    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    # --version avoids embedded JS quotes, which Windows PowerShell 5.1 strips
    # when it marshals native arguments (the .cmd launchers use that shell).
    $version = & $candidate --version 2>$null
    if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 24) { return $candidate }
  }
  throw 'Node 24+ is required. Keep the installed runtime/node or install Node 24+ on PATH.'
}
