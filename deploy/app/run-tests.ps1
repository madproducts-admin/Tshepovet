<#
  Runs the vitest suite on this box against the tshepovet_test database and Redis db 15, as
  the test logins (deploy/app/install-box.ps1 creates them; secrets never printed). Extra
  arguments go to vitest:

    powershell -NoProfile -ExecutionPolicy Bypass -File deploy\app\run-tests.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File deploy\app\run-tests.ps1 apps/api
#>
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$VitestArgs = @())
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'TsvBox.psm1') -Force
$p = Get-TsvPaths
$S = Read-SecretsFile $p.SecretsFile
# This process only: the variables end with it.
$env:TEST_OWNER_DATABASE_URL = "postgres://tshepovet_test_owner:$($S['TSV_DB_TEST_OWNER_PASSWORD'])@127.0.0.1:5432/$($p.TestDatabase)"
$env:TEST_APP_DATABASE_URL = "postgres://tshepovet_test_api:$($S['TSV_DB_TEST_API_PASSWORD'])@127.0.0.1:5432/$($p.TestDatabase)"
$env:TEST_REDIS_URL = "redis://:$($S['TSV_REDIS_PASSWORD'])@127.0.0.1:$($p.RedisPort)/15"
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ErrorActionPreference = 'Continue'
& npx.cmd vitest run @VitestArgs
exit $LASTEXITCODE
