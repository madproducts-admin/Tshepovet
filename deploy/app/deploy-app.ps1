<#
  Deploys the TshepoVet API to this box: the services tshepovet-api (Express on
  127.0.0.1:9131, behind the IIS site tshepovet) and tshepovet-webhooks (the outbox
  dispatcher). Run install-box.ps1 once first. From an elevated Windows PowerShell 5.1:

    powershell -NoProfile -ExecutionPolicy Bypass -File deploy\app\deploy-app.ps1
        [-SkipTests] [-SeedSandbox] [-SkipEdgeCheck]
    powershell -NoProfile -ExecutionPolicy Bypass -File deploy\app\deploy-app.ps1 -Rollback

  In order; anything before step 6 leaves the live API untouched:
    1. the working tree is clean (the build ships the working tree, not HEAD)
    2. typecheck + the FULL test suite (all 82) against the box's tshepovet_test database
       and Redis db 15, as the test logins
    3. build (tsc), stage D:\releases\tshepovet\<stamp>-<sha> with production node_modules
       (copied from the live release when package-lock.json is unchanged)
    4. migrations, forward-only, as tshepovet_owner (scripts/migrate.ts)
    5. -SeedSandbox, once: a sandbox tenant with R1,000 credit and API keys, written to
       C:\ProgramData\MADProducts\tshepovet\sandbox-tenant.json (never printed)
    6. switch both services to the new release; if the API is not healthy in 60 s, both go
       back to the previous release
    7. check https://tshepovet.madproducts.ai/healthz through Cloudflare, then run the API
       smoke suite there (with the sandbox key, so a real sandbox company check runs)
    8. keep the newest three releases

  -Rollback switches both services to the release before the live one. Migrations are
  forward-only: a rollback runs older code against the newer schema.
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param([switch]$Rollback, [switch]$SkipTests, [switch]$SeedSandbox, [switch]$SkipEdgeCheck)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'TsvBox.psm1') -Force
$p = Get-TsvPaths
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$apiAcct = "NT SERVICE\$($p.ApiService)"
$jobsAcct = "NT SERVICE\$($p.JobsService)"
if (-not (Test-Path -LiteralPath $p.SecretsFile)) { throw "no $($p.SecretsFile): run deploy\app\install-box.ps1 first" }
$S = Read-SecretsFile $p.SecretsFile

# This script stages the single-package layout (dist/server.js). The workspace layout
# (apps/api, packages/*, later apps/web) needs a new staging step, new service entry points
# (apps/api/dist/main.js, apps/api/dist/worker.js) and the worker replacing tshepovet-webhooks
# and the purge task: all part of docs/PLAN.md M10, built and tested together with the web
# service. Until then, refuse rather than ship a release that cannot start. -Rollback only
# switches between releases already on disk, so it still works.
if (-not $Rollback -and (Test-Path -LiteralPath (Join-Path $repo 'apps\api\package.json'))) {
    throw 'deploy-app.ps1 is not updated for the workspace layout yet (docs/PLAN.md M10). The live sandbox deploys from branch deploy/app.'
}

function Get-Releases {
    @(Get-ChildItem -LiteralPath $p.ReleaseRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d{8}-\d{6}-[0-9a-f]{7}$' } | Sort-Object Name)
}
function Get-Current {
    if (Test-Path -LiteralPath $p.CurrentFile) { (Get-Content -LiteralPath $p.CurrentFile -Raw).Trim() } else { $null }
}

# Runs a command in the repo, streaming its output; throws on a non-zero exit.
function Invoke-Step([string]$What, [scriptblock]$Block) {
    $ErrorActionPreference = 'Continue'
    Push-Location $repo
    try { & $Block; $code = $LASTEXITCODE } finally { Pop-Location }
    if ($code -ne 0) { throw "$What failed ($code)" }
}

function Write-NodeServiceXml([string]$Name, [string]$Display, [string]$Script, [string]$Release, $Envs, [string]$What) {
    $svcDir = Join-Path $p.ServicesRoot $Name
    $logDir = Join-Path $p.DataRoot "$($Name -replace '^tshepovet-', '')\logs"
    $xml = @"
<service>
  <id>$Name</id>
  <name>$Display</name>
  <description>$What, release $(Split-Path $Release -Leaf). Managed by deploy/app/deploy-app.ps1 (TshepoVet repo).</description>
  <executable>$($p.NodeExe)</executable>
  <arguments>"$(Join-Path $Release $Script)"</arguments>
  <workingdirectory>$Release</workingdirectory>
$(ConvertTo-EnvXml $Envs)
  <depend>$($p.PgService)</depend>
  <depend>$($p.RedisService)</depend>
  <logpath>$logDir</logpath>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>8</keepFiles></log>
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="30 sec" />
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>20 sec</stoptimeout>
  <startmode>Automatic</startmode>
</service>
"@
    Write-Utf8NoBom (Join-Path $svcDir "$Name.xml") $xml
}

function Install-NodeService([string]$Name, [string]$Display, [string]$Script, [string]$Release, $Envs, [string]$What) {
    $acct = "NT SERVICE\$Name"
    $svcDir = Join-Path $p.ServicesRoot $Name
    $logRoot = Join-Path $p.DataRoot ($Name -replace '^tshepovet-', '')
    $svcExe = Join-Path $svcDir "$Name.exe"
    Lock-Folder $svcDir @($acct)
    Lock-Folder $logRoot @($acct)
    New-Item -ItemType Directory (Join-Path $logRoot 'logs') -Force | Out-Null
    Write-NodeServiceXml $Name $Display $Script $Release $Envs $What
    if (-not (Get-Service -Name $Name -ErrorAction SilentlyContinue)) {
        Copy-Item -LiteralPath $p.WinSW $svcExe -Force
        Assert-SameHash $svcExe (Get-WinSWSha256)
        Invoke-Native "WinSW install ($Name)" $svcExe @('install') | Out-Null
        Invoke-Native "sc config ($Name)" 'sc.exe' @('config', $Name, 'obj=', $acct) | Out-Null
        Ok "service $Name installed, runs as $acct"
    }
    Assert-SameHash $svcExe (Get-WinSWSha256)
    Grant-Folder $svcDir $acct 'RX'
    Grant-Folder $logRoot $acct 'M'
    Grant-Folder $p.ReleaseRoot $acct 'RX'
}

function Test-ApiHealthy {
    $r = Test-Native 'curl.exe' @('-s', '--max-time', '5', "http://127.0.0.1:$($p.ApiPort)/healthz")
    $r.Code -eq 0 -and $r.Out -match '"ok":\s*true'
}

# Points both services at $Release and restarts them. Returns $true when the API answers
# /healthz within 60 s and the dispatcher is still running 10 s after its start.
function Switch-To([string]$Release) {
    Install-NodeService $p.JobsService 'TshepoVet webhook dispatcher' 'dist\workers\webhookDispatcher.js' $Release (Get-AppEnv $S 'jobs') 'TshepoVet webhook outbox dispatcher'
    Install-NodeService $p.ApiService 'TshepoVet API' 'dist\server.js' $Release (Get-AppEnv $S 'api') "TshepoVet Express API on 127.0.0.1:$($p.ApiPort)"
    Restart-Service -Name $p.JobsService -Force
    Restart-Service -Name $p.ApiService -Force
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline -and -not (Test-ApiHealthy)) { Start-Sleep -Seconds 2 }
    if (-not (Test-ApiHealthy)) { return $false }
    Start-Sleep -Seconds 10
    (Get-Service -Name $p.JobsService).Status -eq 'Running'
}

New-Item -ItemType Directory $p.ReleaseRoot -Force | Out-Null
Lock-Folder $p.ReleaseRoot @($apiAcct, $jobsAcct) -Shallow
try { $lock = [IO.File]::Open($p.LockFile, 'OpenOrCreate', 'ReadWrite', 'None') }
catch { throw "another deploy holds $($p.LockFile)" }
try {
    $current = Get-Current

    # -- Rollback --------------------------------------------------------------------------
    if ($Rollback) {
        Step 'rollback'
        $all = Get-Releases
        $idx = -1
        for ($i = 0; $i -lt $all.Count; $i++) { if ($all[$i].FullName -eq $current) { $idx = $i } }
        if ($idx -lt 1) { throw "no release before $current to roll back to" }
        $target = $all[$idx - 1].FullName
        if (-not (Switch-To $target)) { throw "the API is not healthy on $target either; look at $($p.DataRoot)\api\logs" }
        Write-Utf8NoBom $p.CurrentFile $target
        Ok "live: $(Split-Path $target -Leaf) (was $(Split-Path $current -Leaf))"
        return
    }

    # -- 1. Committed work only ------------------------------------------------------------
    Step 'working tree is clean'
    $dirty = (Invoke-Native 'git status' 'git' @('-C', $repo, 'status', '--porcelain')) -join "`n"
    if ($dirty.Trim()) { throw "uncommitted changes would ship:`n$dirty" }
    $sha = ((Invoke-Native 'git rev-parse' 'git' @('-C', $repo, 'rev-parse', 'HEAD')) -join '').Trim()
    $short = $sha.Substring(0, 7)
    Ok "clean at $short"

    # -- 2. Gates --------------------------------------------------------------------------
    if (-not $SkipTests) {
        Step 'typecheck'
        Invoke-Step 'typecheck' { & npm run typecheck }
        Step 'full test suite (82) against tshepovet_test and Redis db 15'
        $env:TEST_OWNER_DATABASE_URL = "postgres://tshepovet_test_owner:$($S['TSV_DB_TEST_OWNER_PASSWORD'])@127.0.0.1:5432/$($p.TestDatabase)"
        $env:TEST_APP_DATABASE_URL = "postgres://tshepovet_test_api:$($S['TSV_DB_TEST_API_PASSWORD'])@127.0.0.1:5432/$($p.TestDatabase)"
        $env:TEST_REDIS_URL = "redis://:$($S['TSV_REDIS_PASSWORD'])@127.0.0.1:$($p.RedisPort)/15"
        try { Invoke-Step 'tests' { & npx vitest run } }
        finally { Remove-Item Env:\TEST_OWNER_DATABASE_URL, Env:\TEST_APP_DATABASE_URL, Env:\TEST_REDIS_URL -ErrorAction SilentlyContinue }
    } else {
        Note '(skipping typecheck and tests at your request)'
    }

    # -- 3. Build and stage ----------------------------------------------------------------
    Step 'build and stage the release'
    Invoke-Step 'build' { & npm run build }
    $stamp = "$(Get-Date -Format yyyyMMdd-HHmmss)-$short"
    $rel = Join-Path $p.ReleaseRoot $stamp
    New-Item -ItemType Directory $rel | Out-Null
    $rc = Test-Native 'robocopy.exe' @((Join-Path $repo 'dist'), (Join-Path $rel 'dist'), '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    if ($rc.Code -ge 8) { throw "robocopy dist failed ($($rc.Code))" }
    foreach ($f in 'package.json', 'package-lock.json') { Copy-Item -LiteralPath (Join-Path $repo $f) (Join-Path $rel $f) }
    Write-Utf8NoBom (Join-Path $rel 'COMMIT') "$sha`n"
    $lockHash = (Get-FileHash (Join-Path $rel 'package-lock.json') -Algorithm SHA256).Hash
    $reuse = $current -and (Test-Path (Join-Path $current 'node_modules')) -and (Test-Path (Join-Path $current 'package-lock.json')) -and
        ((Get-FileHash (Join-Path $current 'package-lock.json') -Algorithm SHA256).Hash -eq $lockHash)
    if ($reuse) {
        $rc = Test-Native 'robocopy.exe' @((Join-Path $current 'node_modules'), (Join-Path $rel 'node_modules'), '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
        if ($rc.Code -ge 8) { throw "robocopy node_modules failed ($($rc.Code))" }
        Ok "node_modules copied from $(Split-Path $current -Leaf) (package-lock.json unchanged)"
    } else {
        Push-Location $rel
        try { Invoke-Native 'npm ci --omit=dev' 'npm.cmd' @('ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund') | Out-Null }
        finally { Pop-Location }
        Ok 'production node_modules installed'
    }
    Ok "staged $rel"

    # -- 4. Migrations ---------------------------------------------------------------------
    Step 'migrations (as tshepovet_owner)'
    $env:MIGRATION_DATABASE_URL = "postgres://tshepovet_owner:$($S['TSV_DB_OWNER_PASSWORD'])@127.0.0.1:5432/$($p.Database)"
    try { Invoke-Step 'migrate' { & npx tsx scripts/migrate.ts } }
    finally { Remove-Item Env:\MIGRATION_DATABASE_URL -ErrorAction SilentlyContinue }
    Ok 'schema up to date'

    # -- 5. Sandbox tenant (once) ----------------------------------------------------------
    if ($SeedSandbox) {
        Step 'sandbox tenant'
        if (Test-Path -LiteralPath $p.SandboxFile) { throw "$($p.SandboxFile) exists: the sandbox tenant was seeded already" }
        $env:MIGRATION_DATABASE_URL = "postgres://tshepovet_owner:$($S['TSV_DB_OWNER_PASSWORD'])@127.0.0.1:5432/$($p.Database)"
        $env:API_KEY_PEPPER = $S['TSV_API_KEY_PEPPER']
        try {
            Push-Location $repo
            # stdout only (the JSON); npm/npx notices on stderr would break the parse.
            $ErrorActionPreference = 'Continue'
            $seed = & npx tsx scripts/seed-dev.ts 2>$null
            $seedCode = $LASTEXITCODE
            $ErrorActionPreference = 'Stop'
        } finally {
            Pop-Location
            Remove-Item Env:\MIGRATION_DATABASE_URL, Env:\API_KEY_PEPPER -ErrorAction SilentlyContinue
        }
        if ($seedCode -ne 0) { throw "seed failed ($seedCode)" }
        $json = ($seed -join "`n")
        $parsed = $json | ConvertFrom-Json
        Write-Utf8NoBom $p.SandboxFile $json
        Lock-Folder $p.SecretsDir
        Ok "tenant $($parsed.tenantId), R$([int]$parsed.wallet_cents / 100) credit; keys in $($p.SandboxFile) (Administrators only)"
    }

    # -- 6. Switch -------------------------------------------------------------------------
    Step "switch $($p.ApiService) and $($p.JobsService) to $stamp"
    if (Switch-To $rel) {
        Write-Utf8NoBom $p.CurrentFile $rel
        Ok "live: $stamp"
    } else {
        if ($current) {
            Note "not healthy; switching back to $(Split-Path $current -Leaf)"
            if (Switch-To $current) { Ok 'previous release restored' } else { Note 'the previous release is not healthy either' }
        }
        throw "the API did not come up on $stamp; look at $($p.DataRoot)\api\logs"
    }

    # -- 7. Through Cloudflare -------------------------------------------------------------
    if (-not $SkipEdgeCheck) {
        Step 'through Cloudflare'
        $edge = Test-Native 'curl.exe' @('-s', '--max-time', '20', "https://$($p.Host)/healthz?cb=$(Get-Random)")
        if ($edge.Out -notmatch '"ok":\s*true') { throw "https://$($p.Host)/healthz answered: $($edge.Out)" }
        Ok "https://$($p.Host)/healthz -> $($edge.Out)"

        Step 'API smoke suite through Cloudflare (tests/smoke/api.smoke.ts)'
        # The sandbox key reaches the suite through the environment only; it is never printed.
        if (Test-Path -LiteralPath $p.SandboxFile) {
            $env:TSV_SANDBOX_API_KEY = ((Get-Content -LiteralPath $p.SandboxFile -Raw) | ConvertFrom-Json).api_keys.test
        }
        $env:TSV_E2E_BASE_URL = "https://$($p.Host)"
        try { Invoke-Step 'API smoke suite' { & npx playwright test tests/smoke/api.smoke.ts --reporter=line } }
        catch { throw "$_ - the new release is live; roll back with deploy\app\deploy-app.ps1 -Rollback if it is the cause" }
        finally { Remove-Item Env:\TSV_SANDBOX_API_KEY, Env:\TSV_E2E_BASE_URL -ErrorAction SilentlyContinue }
    }

    # -- 8. Prune --------------------------------------------------------------------------
    $keep = @(Get-Releases | Select-Object -Last 3 | ForEach-Object { $_.FullName })
    foreach ($r in Get-Releases) {
        if ($keep -notcontains $r.FullName -and $r.FullName -ne $rel) { Remove-Item -LiteralPath $r.FullName -Recurse -Force; Note "removed old release $($r.Name)" }
    }
    Write-Host "`nDeployed $stamp. Roll back: deploy\app\deploy-app.ps1 -Rollback" -ForegroundColor Green
} finally {
    $lock.Dispose()
}
