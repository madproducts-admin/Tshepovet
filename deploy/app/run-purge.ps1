<#
  The hourly POPIA retention purge (scheduled task "MADProducts tshepovet retention purge",
  as SYSTEM). install-box.ps1 copies this file and TsvBox.psm1 to
  C:\madproducts\services\tshepovet-purge and runs it from there.

  Runs dist\workers\retentionPurge.js from the live release (D:\releases\tshepovet\current.txt)
  as the tshepovet_jobs login (BYPASSRLS, member of tshepovet_worker): expire stale wallet
  holds, crypto-shred what is past its retention date, keep audit partitions ahead.
  Log: D:\madproducts-data\tshepovet\purge\purge.log (no secrets: pino logs counts only).
#>
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'TsvBox.psm1') -Force
$p = Get-TsvPaths
$logDir = Join-Path $p.DataRoot 'purge'
New-Item -ItemType Directory $logDir -Force | Out-Null
$log = Join-Path $logDir 'purge.log'
if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item $log "$log.1" -Force }
function Log([string]$m) { Add-Content -LiteralPath $log -Value "$(Get-Date -Format s) $m" -Encoding UTF8 }

if (-not (Test-Path -LiteralPath $p.CurrentFile)) { Log 'no release deployed yet; nothing to do'; exit 0 }
$release = (Get-Content -LiteralPath $p.CurrentFile -Raw).Trim()
$script = Join-Path $release 'dist\workers\retentionPurge.js'
if (-not (Test-Path -LiteralPath $script)) { Log "missing $script"; exit 1 }

$S = Read-SecretsFile $p.SecretsFile
$envs = Get-AppEnv $S 'jobs'
foreach ($k in $envs.Keys) { Set-Item -Path "Env:$k" -Value $envs[$k] }
try {
    Push-Location $release
    $ErrorActionPreference = 'Continue' # node's stderr must not abort the script (PS 5.1)
    $out = & $p.NodeExe $script 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
} finally {
    Pop-Location
    foreach ($k in $envs.Keys) { Remove-Item -Path "Env:$k" -ErrorAction SilentlyContinue }
}
Log "exit $code from $(Split-Path $release -Leaf)"
foreach ($line in $out) { Log "  $line" }
exit $code
