<#
  The web app's end-to-end flows on this box: a fresh test database, this branch's API in
  sandbox mode on 127.0.0.1:9195 with its worker, the web app built against it on
  127.0.0.1:3195, then Playwright (apps/web/tests). Everything it starts it stops. Secrets are
  never printed.

    powershell -NoProfile -ExecutionPolicy Bypass -File deploy\app\run-web-e2e.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File deploy\app\run-web-e2e.ps1 -SkipBuild
#>
param([switch]$SkipBuild, [string[]]$Spec = @())
$ErrorActionPreference = 'Stop'
# -File passes "a,b" as one string: split it (e.g. -Spec portal.spec,supplier.spec).
$Spec = @($Spec | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
Import-Module (Join-Path $PSScriptRoot 'TsvBox.psm1') -Force
$p = Get-TsvPaths
$S = Read-SecretsFile $p.SecretsFile
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root

$apiPort = 9195
$webPort = 3195
foreach ($port in $apiPort, $webPort) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { throw "port $port is already in use" }
}

# This process (and its children) only.
$env:TEST_OWNER_DATABASE_URL = "postgres://tshepovet_test_owner:$($S['TSV_DB_TEST_OWNER_PASSWORD'])@127.0.0.1:5432/$($p.TestDatabase)"
$env:TEST_APP_DATABASE_URL = "postgres://tshepovet_test_api:$($S['TSV_DB_TEST_API_PASSWORD'])@127.0.0.1:5432/$($p.TestDatabase)"
$env:TEST_REDIS_URL = "redis://:$($S['TSV_REDIS_PASSWORD'])@127.0.0.1:$($p.RedisPort)/15"
$rand = { $b = New-Object byte[] 32; (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b); [Convert]::ToBase64String($b) }

$ErrorActionPreference = 'Continue'
# The design reference (design/*.json, the dashboard's Design system and User interface tabs):
# generated tokens, AAA contrast, fonts and the page map must agree with the app.
& node tools\design-sync.mjs check
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (-not $SkipBuild) {
  & npx.cmd tsc -b packages/core packages/contracts apps/api
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $env:TSV_API_ORIGIN = "http://127.0.0.1:$apiPort"
  $env:NEXT_TELEMETRY_DISABLED = '1'
  Push-Location apps\web
  & npx.cmd next build
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { exit $code }
}
# The build bakes its /api and /v1 rewrites in. deploy-app.ps1 builds in this same folder against
# the LIVE API (9131): reusing that build here would send the browser's API calls (sign-ups,
# top-ups, checks) to the live sandbox. So -SkipBuild only reuses a build made for this test API.
$manifest = Get-Content -LiteralPath (Join-Path $root 'apps\web\.next\routes-manifest.json') -Raw | ConvertFrom-Json
$targets = @(@($manifest.rewrites.beforeFiles) + @($manifest.rewrites.afterFiles) + @($manifest.rewrites.fallback) | Where-Object { $_ } | ForEach-Object { $_.destination })
$foreign = @($targets | Where-Object { $_ -notlike "http://127.0.0.1:$apiPort/*" })
if (-not $targets.Count -or $foreign.Count) {
  Write-Host "The web build sends /api to $($targets -join ', '), not the test API on $apiPort (a deploy build?). Run without -SkipBuild."
  exit 1
}
& node tools\reset-test-db.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$api = $null; $web = $null; $worker = $null
try {
  $env:NODE_ENV = 'test'
  # NODE_ENV=test silences the logger; keep warnings and errors in tsv-e2e-api.log.
  $env:LOG_LEVEL = 'warn'
  $env:HOST = '127.0.0.1'
  $env:PORT = "$apiPort"
  $env:DATABASE_URL = $env:TEST_APP_DATABASE_URL
  $env:REDIS_URL = $env:TEST_REDIS_URL
  $env:SANDBOX = 'true'
  $env:COOKIE_SECURE = 'false'
  $env:APP_URL = "http://127.0.0.1:$webPort"
  $env:ENABLED_PROVIDERS = 'mock'
  $env:KEK_KEYS = "1:$(& $rand)"
  $env:BLIND_INDEX_ROOT_KEY = & $rand
  $env:API_KEY_PEPPER = & $rand
  # The staff console and the worker work across tenants: the BYPASSRLS test owner login.
  $env:STAFF_DATABASE_URL = $env:TEST_OWNER_DATABASE_URL
  $env:WORKER_DATABASE_URL = $env:TEST_OWNER_DATABASE_URL
  $env:DOCUMENT_STORE_DIR = Join-Path $env:TEMP 'tsv-e2e-documents'
  $api = Start-Process node -ArgumentList 'apps\api\dist\main.js' -PassThru -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\tsv-e2e-api.log" -RedirectStandardError "$env:TEMP\tsv-e2e-api.err"
  # The worker shares the API's keys (the same process environment).
  $worker = Start-Process node -ArgumentList 'apps\api\dist\worker.js' -PassThru -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\tsv-e2e-worker.log" -RedirectStandardError "$env:TEMP\tsv-e2e-worker.err"
  $env:TSV_API_ORIGIN = "http://127.0.0.1:$apiPort"
  $env:NODE_ENV = 'production'
  $web = Start-Process node -ArgumentList "$root\node_modules\next\dist\bin\next", 'start', '--port', "$webPort", '--hostname', '127.0.0.1' -WorkingDirectory "$root\apps\web" -PassThru -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\tsv-e2e-web.log" -RedirectStandardError "$env:TEMP\tsv-e2e-web.err"

  foreach ($url in "http://127.0.0.1:$apiPort/healthz", "http://127.0.0.1:$webPort/design-system") {
    $ok = $false
    for ($i = 0; $i -lt 60 -and -not $ok; $i++) {
      try { $r = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 5; $ok = $r.StatusCode -eq 200 } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $ok) { throw "$url did not come up (logs in $env:TEMP\tsv-e2e-*.log)" }
  }

  $env:TSV_WEB_URL = "http://127.0.0.1:$webPort"
  & npx.cmd playwright test -c apps/web/playwright.config.ts @Spec
  $code = $LASTEXITCODE
} finally {
  foreach ($proc in $web, $api, $worker) { if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force } }
  # next start runs its server in a child process: stop whatever still holds our ports.
  foreach ($port in $apiPort, $webPort) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
      $pr = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"
      if ($pr.CommandLine -match 'next|apps\\api\\dist\\main.js') { Stop-Process -Id $pr.ProcessId -Force }
    }
  }
}
exit $code
