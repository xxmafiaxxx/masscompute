# MassCompute donor installer (Windows).
# Installs the worker as a global `masscompute` command — no repo clone, no admin.
#
# Usage:
#   .\install-worker.ps1 <masscompute-worker-0.x.y.tgz>   # from a local tarball
#   .\install-worker.ps1 https://example.com/masscompute-worker-0.2.0.tgz
#
# After install:
#   masscompute doctor        <- check your GPU + grid reachability
#   masscompute               <- start donating (Ctrl+C to stop)
#   masscompute autostart     <- donate automatically at login

param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Package
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js 22+ is required. Install it from https://nodejs.org and re-run."
}
$nodeMajor = (node -p "process.versions.node.split('.')[0]")
if ([int]$nodeMajor -lt 22) { Write-Error "Node.js 22+ required (found $((node -v)))" }

$tmp = $null
if ($Package -match '^https?://') {
  $tmp = Join-Path $env:TEMP ("mc-worker-" + [guid]::NewGuid().ToString() + ".tgz")
  Write-Host "downloading $Package"
  Invoke-WebRequest -Uri $Package -OutFile $tmp -UseBasicParsing
  $Package = $tmp
}
if (-not (Test-Path $Package)) { Write-Error "package not found: $Package" }

Write-Host "installing globally (npm install -g $Package)…"
npm install -g $Package
if ($tmp) { Remove-Item $tmp -Force }

Write-Host ""
Write-Host "installed. checking your machine…"
masscompute doctor
Write-Host ""
Write-Host "next steps:"
Write-Host "  masscompute               start donating now"
Write-Host "  masscompute autostart     donate automatically at every login"
Write-Host "  masscompute set name <yours>   appear on the leaderboard by name"
