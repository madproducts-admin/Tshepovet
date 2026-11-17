<#
  Deploys the complete TshepoVet app (docs/PLAN.md M10) to this box: three services behind the
  IIS site tshepovet, sandbox only.
    tshepovet-api     the API (NestJS) on 127.0.0.1:9131: /api, /v1, /webhooks, /healthz, /readyz
    tshepovet-worker  the jobs: verifications, webhooks, mail, monitoring, the retention purge
    tshepovet-web     the web app (Next.js standalone) on 127.0.0.1:9132: every other path
  Run install-box.ps1 first. From an elevated Windows PowerShell 5.1:

    deploy-app.ps1 -StageOnly                build, stage and rehearse a release; nothing live changes
    deploy-app.ps1 -Release <name>           switch to a release that -StageOnly rehearsed
    deploy-app.ps1                           all of it in one go: stage, rehearse, switch
    deploy-app.ps1 -Rollback                 back to the release that was live before this one
    (-SkipTests, -SeedSandbox, -SkipEdgeCheck as before)

  In order; nothing before step 6 touches the live site:
    1. the working tree is clean (the build ships the working tree, not HEAD)
    2. gates: typecheck, the design check, the full API and core suite (run-tests.ps1)
    3. build: tsc (core, contracts, api) and next build (standalone; its build id is the
       release name, sent on every page as X-TshepoVet-Build)
    4. stage D:\releases\tshepovet\<stamp>-<sha>: each workspace's package.json and dist,
       production node_modules for the API (npm ci), the web server under web\, web.config
    5. rehearse: the staged API, worker and web run from the release folder on loopback
       ports 9197/9198 against the test database and Redis db 15, are checked, then stopped
       (-StageOnly ends here and marks the release REHEARSED)
    6. back up the live database (pg_dump, custom format) to D:\madproducts-data\tshepovet\backups
    7. migrations, forward-only, as tshepovet_owner
    8. -SeedSandbox, once
    9. switch the services to the release (the first release's tshepovet-webhooks service and
       hourly purge task are disabled: the worker does both), check them, then write the
       release's web.config to the IIS site. Not healthy: everything goes back.
   10. through Cloudflare: /healthz and the release header, the landing page and the build
       header, the certificate, then the API, web and docs smoke suites
   11. keep the newest three releases (never the live one or the one before it)

  -Rollback switches to the release that was live before this one, first-release layout
  included (dist\server.js with tshepovet-webhooks and the purge task), and writes that
  release's web.config back. Migrations are forward-only: a rollback runs older code on the
  newer schema; the step-6 backup is how to get the old schema back (pg_restore, by hand).
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param([switch]$Rollback, [switch]$StageOnly, [string]$Release, [switch]$SkipTests, [switch]$SeedSandbox, [switch]$SkipEdgeCheck)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'TsvBox.psm1') -Force
$p = Get-TsvPaths
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$acct = @{
    api     = "NT SERVICE\$($p.ApiService)"
    worker  = "NT SERVICE\$($p.WorkerService)"
    web     = "NT SERVICE\$($p.WebService)"
    jobs    = "NT SERVICE\$($p.JobsService)"
}
$historyFile = Join-Path $p.ReleaseRoot 'history.txt'
if (-not (Test-Path -LiteralPath $p.SecretsFile)) { throw "no $($p.SecretsFile): run deploy\app\install-box.ps1 first" }
$S = Read-SecretsFile $p.SecretsFile

function Get-Releases {
    @(Get-ChildItem -LiteralPath $p.ReleaseRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d{8}-\d{6}-[0-9a-f]{7}$' } | Sort-Object Name)
}
function Get-Current {
    if (Test-Path -LiteralPath $p.CurrentFile) { (Get-Content -LiteralPath $p.CurrentFile -Raw).Trim() } else { $null }
}
# The releases that were live, oldest first (a rollback goes to the one before the live one,
# never to a release that was only staged).
function Get-History {
    $h = @()
    if (Test-Path -LiteralPath $historyFile) { $h = @(Get-Content -LiteralPath $historyFile | Where-Object { $_.Trim() }) }
    $cur = Get-Current
    if ($cur -and ($h.Count -eq 0 -or $h[-1] -ne $cur)) { $h += $cur }
    $h
}
function Set-Live([string]$Rel) {
    $h = @(Get-History) + $Rel
    Write-Utf8NoBom $historyFile (($h | Select-Object -Last 20) -join "`r`n")
    Write-Utf8NoBom $p.CurrentFile $Rel
}
# 'full' (this layout) or 'first' (the first release: dist\server.js, before the workspaces).
function Get-Layout([string]$Rel) {
    if (Test-Path -LiteralPath (Join-Path $Rel 'apps\api\dist\main.js')) { return 'full' }
    if (Test-Path -LiteralPath (Join-Path $Rel 'dist\server.js')) { return 'first' }
    throw "$Rel is not a release this script knows"
}

# Runs a command in the repo, streaming its output; throws on a non-zero exit.
function Invoke-Step([string]$What, [scriptblock]$Block) {
    $ErrorActionPreference = 'Continue'
    Push-Location $repo
    try { & $Block; $code = $LASTEXITCODE } finally { Pop-Location }
    if ($code -ne 0) { throw "$What failed ($code)" }
}

function Copy-Tree([string]$From, [string]$To) {
    $rc = Test-Native 'robocopy.exe' @($From, $To, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    if ($rc.Code -ge 8) { throw "robocopy $From failed ($($rc.Code))" }
}

# -- Services ------------------------------------------------------------------------------
function Install-NodeService([string]$Name, [string]$Display, [string]$Script, [string]$WorkDir, $Envs, [string]$What, [switch]$NoDepends) {
    $account = "NT SERVICE\$Name"
    $svcDir = Join-Path $p.ServicesRoot $Name
    $logRoot = Join-Path $p.DataRoot ($Name -replace '^tshepovet-', '')
    $svcExe = Join-Path $svcDir "$Name.exe"
    Lock-Folder $svcDir @($account)
    Lock-Folder $logRoot @($account)
    New-Item -ItemType Directory (Join-Path $logRoot 'logs') -Force | Out-Null
    $depends = if ($NoDepends) { '' } else { "  <depend>$($p.PgService)</depend>`r`n  <depend>$($p.RedisService)</depend>" }
    $xml = @"
<service>
  <id>$Name</id>
  <name>$Display</name>
  <description>$What, release $(Split-Path (Get-ReleaseOf $WorkDir) -Leaf). Managed by deploy/app/deploy-app.ps1 (TshepoVet repo).</description>
  <executable>$($p.NodeExe)</executable>
  <arguments>"$Script"</arguments>
  <workingdirectory>$WorkDir</workingdirectory>
$(ConvertTo-EnvXml $Envs)
$depends
  <logpath>$(Join-Path $logRoot 'logs')</logpath>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>8</keepFiles></log>
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="30 sec" />
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>20 sec</stoptimeout>
  <startmode>Automatic</startmode>
</service>
"@
    Write-Utf8NoBom (Join-Path $svcDir "$Name.xml") $xml
    if (-not (Get-Service -Name $Name -ErrorAction SilentlyContinue)) {
        Copy-Item -LiteralPath $p.WinSW $svcExe -Force
        Assert-SameHash $svcExe (Get-WinSWSha256)
        Invoke-Native "WinSW install ($Name)" $svcExe @('install') | Out-Null
        Invoke-Native "sc config ($Name)" 'sc.exe' @('config', $Name, 'obj=', $account) | Out-Null
        Ok "service $Name installed, runs as $account"
    }
    Assert-SameHash $svcExe (Get-WinSWSha256)
    Set-Service -Name $Name -StartupType Automatic
    Grant-Folder $svcDir $account 'RX'
    Grant-Folder $logRoot $account 'M'
    Grant-Folder $p.ReleaseRoot $account 'RX'
}
function Get-ReleaseOf([string]$Path) {
    $root = $p.ReleaseRoot.TrimEnd('\') + '\'
    if (-not $Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { return $Path }
    Join-Path $p.ReleaseRoot ($Path.Substring($root.Length).Split('\')[0])
}
function Disable-ServiceIfPresent([string]$Name) {
    if (Get-Service -Name $Name -ErrorAction SilentlyContinue) {
        Stop-Service -Name $Name -Force -ErrorAction SilentlyContinue
        Set-Service -Name $Name -StartupType Disabled
        Note "service $Name stopped and disabled"
    }
}
function Set-PurgeTask([bool]$Enabled) {
    if (Get-ScheduledTask -TaskName $p.PurgeTask -ErrorAction SilentlyContinue) {
        if ($Enabled) { Enable-ScheduledTask -TaskName $p.PurgeTask | Out-Null; Note 'purge task enabled' }
        else { Disable-ScheduledTask -TaskName $p.PurgeTask | Out-Null; Note 'purge task disabled (the worker purges)' }
    }
}

function Test-Url([string]$Url, [string]$Expect) {
    $r = Test-Native 'curl.exe' @('-s', '--max-time', '10', '-o', 'NUL', '-w', '%{http_code}', $Url)
    $r.Code -eq 0 -and $r.Out -eq $Expect
}
function Wait-Until([int]$Seconds, [scriptblock]$Check) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) { if (& $Check) { return $true }; Start-Sleep -Seconds 2 }
    & $Check
}

# Points the services at $Rel and restarts them; $true when all answer. The IIS site's
# web.config is written last, so a release that does not come up never gets traffic routed
# to it.
function Switch-To([string]$Rel) {
    $layout = Get-Layout $Rel
    if ($layout -eq 'full') {
        $webDir = Join-Path $Rel 'web\apps\web'
        Install-NodeService $p.WorkerService 'TshepoVet worker' (Join-Path $Rel 'apps\api\dist\worker.js') $Rel (Get-ServiceEnv $S 'worker' $Rel) 'TshepoVet jobs: verifications, webhooks, mail, monitoring, purge'
        Install-NodeService $p.ApiService 'TshepoVet API' (Join-Path $Rel 'apps\api\dist\main.js') $Rel (Get-ServiceEnv $S 'api' $Rel) "TshepoVet API (NestJS) on 127.0.0.1:$($p.ApiPort)"
        Install-NodeService $p.WebService 'TshepoVet web' (Join-Path $webDir 'server.js') $webDir (Get-ServiceEnv $S 'web' $Rel) "TshepoVet web app (Next.js) on 127.0.0.1:$($p.WebPort)" -NoDepends
        # The services' virtual accounts exist now: the encrypted documents are theirs.
        Lock-Folder $p.DocumentsDir @($acct.api, $acct.worker)
        Grant-Folder $p.DocumentsDir $acct.api 'M'
        Grant-Folder $p.DocumentsDir $acct.worker 'M'
        # Next writes its fetch and image cache under .next\cache; nothing else in the release.
        $cache = Join-Path $webDir '.next\cache'
        New-Item -ItemType Directory $cache -Force | Out-Null
        Grant-Folder $cache $acct.web 'M'
        Disable-ServiceIfPresent $p.JobsService
        Set-PurgeTask $false
        Restart-Service -Name $p.WorkerService -Force
        Restart-Service -Name $p.ApiService -Force
        Restart-Service -Name $p.WebService -Force
        $api = Wait-Until 90 { Test-Url "http://127.0.0.1:$($p.ApiPort)/healthz" '200' }
        $web = Wait-Until 90 { Test-Url "http://127.0.0.1:$($p.WebPort)/" '200' }
        Start-Sleep -Seconds 10
        $worker = (Get-Service -Name $p.WorkerService).Status -eq 'Running'
        Note "api $api, web $web, worker $worker"
        if (-not ($api -and $web -and $worker)) { return $false }
    } else {
        Disable-ServiceIfPresent $p.WebService
        Disable-ServiceIfPresent $p.WorkerService
        Install-NodeService $p.JobsService 'TshepoVet webhook dispatcher' (Join-Path $Rel 'dist\workers\webhookDispatcher.js') $Rel (Get-AppEnv $S 'jobs') 'TshepoVet webhook outbox dispatcher'
        Install-NodeService $p.ApiService 'TshepoVet API' (Join-Path $Rel 'dist\server.js') $Rel (Get-AppEnv $S 'api') "TshepoVet Express API on 127.0.0.1:$($p.ApiPort)"
        Set-PurgeTask $true
        Restart-Service -Name $p.JobsService -Force
        Restart-Service -Name $p.ApiService -Force
        $api = Wait-Until 60 { Test-Url "http://127.0.0.1:$($p.ApiPort)/healthz" '200' }
        Start-Sleep -Seconds 10
        if (-not ($api -and (Get-Service -Name $p.JobsService).Status -eq 'Running')) { return $false }
    }
    $wc = Join-Path $Rel 'web.config'
    if (-not (Test-Path -LiteralPath $wc)) { throw "$wc is missing: the site's routing for this release is unknown" }
    Write-Utf8NoBom (Join-Path $p.SiteDir 'web.config') (Get-Content -LiteralPath $wc -Raw)
    Ok "IIS routes $($p.Host) per $(Split-Path $Rel -Leaf)\web.config"
    $true
}

# -- Rehearsal: the staged release, from its own folder, against the test database -----------
function Invoke-Rehearsal([string]$Rel) {
    $stamp = Split-Path $Rel -Leaf
    $apiPort = $p.RehearsalApiPort
    $webPort = $p.RehearsalWebPort
    $logs = Join-Path $p.DataRoot 'rehearsal'
    Lock-Folder $logs
    $names = 'TEST_OWNER_DATABASE_URL', 'TEST_APP_DATABASE_URL', 'TEST_REDIS_URL', 'NODE_ENV', 'HOST', 'PORT', 'HOSTNAME', 'DATABASE_URL', 'STAFF_DATABASE_URL',
        'WORKER_DATABASE_URL', 'REDIS_URL', 'SANDBOX', 'COOKIE_SECURE', 'APP_URL', 'ENABLED_PROVIDERS', 'KEK_KEYS', 'BLIND_INDEX_ROOT_KEY', 'API_KEY_PEPPER',
        'DOCUMENT_STORE_DIR', 'TSV_RELEASE', 'WEBHOOK_DENY_IPS', 'TSV_API_ORIGIN', 'TSV_PUBLIC_ORIGIN', 'NEXT_TELEMETRY_DISABLED', 'LOG_LEVEL'
    $procs = @()
    try {
        $owner = "postgres://tshepovet_test_owner:$($S['TSV_DB_TEST_OWNER_PASSWORD'])@127.0.0.1:5432/$($p.TestDatabase)"
        $env:TEST_OWNER_DATABASE_URL = $owner
        $env:TEST_APP_DATABASE_URL = "postgres://tshepovet_test_api:$($S['TSV_DB_TEST_API_PASSWORD'])@127.0.0.1:5432/$($p.TestDatabase)"
        $env:TEST_REDIS_URL = "redis://:$($S['TSV_REDIS_PASSWORD'])@127.0.0.1:$($p.RedisPort)/15"
        Invoke-Step 'reset the test database' { & node tools\reset-test-db.mjs }
        $env:NODE_ENV = 'production'
        $env:LOG_LEVEL = 'warn'
        $env:HOST = '127.0.0.1'
        $env:PORT = "$apiPort"
        $env:DATABASE_URL = $env:TEST_APP_DATABASE_URL
        $env:STAFF_DATABASE_URL = $owner
        $env:WORKER_DATABASE_URL = $owner
        $env:REDIS_URL = $env:TEST_REDIS_URL
        $env:SANDBOX = 'true'
        $env:COOKIE_SECURE = 'false'
        $env:APP_URL = "http://127.0.0.1:$webPort"
        $env:ENABLED_PROVIDERS = 'mock'
        $env:KEK_KEYS = "1:$(New-Base64Key)"
        $env:BLIND_INDEX_ROOT_KEY = New-Base64Key
        $env:API_KEY_PEPPER = New-Base64Key
        $env:DOCUMENT_STORE_DIR = Join-Path $logs 'documents'
        $env:TSV_RELEASE = $stamp
        $env:WEBHOOK_DENY_IPS = $p.PublicIp
        $procs += Start-Process $p.NodeExe -ArgumentList "`"$(Join-Path $Rel 'apps\api\dist\main.js')`"" -WorkingDirectory $Rel -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'api.log') -RedirectStandardError (Join-Path $logs 'api.err')
        $procs += Start-Process $p.NodeExe -ArgumentList "`"$(Join-Path $Rel 'apps\api\dist\worker.js')`"" -WorkingDirectory $Rel -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'worker.log') -RedirectStandardError (Join-Path $logs 'worker.err')
        $env:HOSTNAME = '127.0.0.1'
        $env:PORT = "$webPort"
        $env:TSV_API_ORIGIN = "http://127.0.0.1:$apiPort"
        $env:TSV_PUBLIC_ORIGIN = "http://127.0.0.1:$webPort"
        $env:NEXT_TELEMETRY_DISABLED = '1'
        $webDir = Join-Path $Rel 'web\apps\web'
        $procs += Start-Process $p.NodeExe -ArgumentList "`"$(Join-Path $webDir 'server.js')`"" -WorkingDirectory $webDir -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'web.log') -RedirectStandardError (Join-Path $logs 'web.err')

        $api = "http://127.0.0.1:$apiPort"
        $web = "http://127.0.0.1:$webPort"
        if (-not (Wait-Until 90 { Test-Url "$api/healthz" '200' })) { throw "the staged API did not answer (logs in $logs)" }
        if (-not (Wait-Until 90 { Test-Url "$web/" '200' })) { throw "the staged web app did not answer (logs in $logs)" }
        $fails = @()
        $h = (Test-Native 'curl.exe' @('-s', '-D', '-', '-o', 'NUL', '--max-time', '10', "$api/healthz")).Out
        if ($h -notmatch "x-tshepovet-release: $stamp") { $fails += 'API: no X-TshepoVet-Release header for this release' }
        if ($h -notmatch "content-security-policy: default-src 'none'") { $fails += 'API: no JSON-only Content-Security-Policy' }
        if (-not (Test-Url "$api/v1/verifications/00000000-0000-4000-8000-000000000000" '401')) { $fails += 'API: /v1 without a key is not 401' }
        if (-not (Test-Url "$api/api/auth/csrf" '200')) { $fails += 'API: /api/auth/csrf is not 200' }
        $h = (Test-Native 'curl.exe' @('-s', '-D', '-', '-o', 'NUL', '--max-time', '20', "$web/")).Out
        if ($h -notmatch "x-tshepovet-build: $stamp") { $fails += 'web: no X-TshepoVet-Build header for this release' }
        if ($h -notmatch "content-security-policy: [^;]*;\s*script-src 'self' 'nonce-") { $fails += 'web: no nonce Content-Security-Policy' }
        foreach ($path in '/pricing', '/glossary', '/sign-in', '/supplier/sign-in', '/staff/sign-in', '/verify-passport') {
            if (-not (Test-Url "$web$path" '200')) { $fails += "web: $path is not 200" }
        }
        $page = (Test-Native 'curl.exe' @('-s', '--max-time', '20', "$web/pricing")).Out
        if ($page -notmatch 'R\d') { $fails += 'web: /pricing shows no prices (the web app could not read them from the API)' }
        # Behind IIS: the visitor's host and scheme arrive as X-Forwarded-*; a redirect must
        # send the visitor back to that host, never to the loopback address.
        $loc = (Test-Native 'curl.exe' @('-s', '-D', '-', '-o', 'NUL', '--max-time', '10', '-H', "X-Forwarded-Host: $($p.Host)", '-H', 'X-Forwarded-Proto: https', "$web/app")).Out
        if ($loc -notmatch "location: (https://$([regex]::Escape($p.Host)))?/sign-in") { $fails += "web: /app does not redirect to $($p.Host)/sign-in ($(($loc -split ';' | Where-Object { $_ -match '^\s*location' }) -join ' '))" }
        $asset = [regex]::Match((Test-Native 'curl.exe' @('-s', '--max-time', '20', "$web/")).Out, '/_next/static/[^"''\s]+\.js').Value
        if (-not $asset -or -not (Test-Url "$web$asset" '200')) { $fails += 'web: a /_next/static script does not load' }
        Start-Sleep -Seconds 5
        if ($procs[1].HasExited) { $fails += "worker: exited with $($procs[1].ExitCode)" }
        if ($fails.Count) { throw "rehearsal of $stamp failed (logs in $logs):`n  $($fails -join "`n  ")" }
        Write-Utf8NoBom (Join-Path $Rel 'REHEARSED') "$(Get-Date -Format o)`n"
        Ok "rehearsed ${stamp}: the API, worker and web app ran from the release folder against the test database"
    } finally {
        foreach ($pr in $procs) { if ($pr -and -not $pr.HasExited) { Stop-Process -Id $pr.Id -Force -ErrorAction SilentlyContinue } }
        foreach ($n in $names) { Remove-Item "Env:\$n" -ErrorAction SilentlyContinue }
    }
}

New-Item -ItemType Directory $p.ReleaseRoot -Force | Out-Null
Lock-Folder $p.ReleaseRoot @($acct.api, $acct.jobs, $acct.worker, $acct.web) -Shallow
try { $lock = [IO.File]::Open($p.LockFile, 'OpenOrCreate', 'ReadWrite', 'None') }
catch { throw "another deploy holds $($p.LockFile)" }
try {
    $current = Get-Current

    # -- Rollback --------------------------------------------------------------------------
    if ($Rollback) {
        Step 'rollback'
        $h = @(Get-History)
        if ($h.Count -lt 2) { throw "no release was live before $current" }
        $target = $h[-2]
        if (-not (Test-Path -LiteralPath $target)) { throw "$target is gone" }
        if (-not (Switch-To $target)) { throw "the services are not healthy on $target either; look at $($p.DataRoot)\*\logs" }
        Set-Live $target
        Ok "live: $(Split-Path $target -Leaf) (was $(Split-Path $current -Leaf))"
        return
    }

    $sha = ((Invoke-Native 'git rev-parse' 'git' @('-C', $repo, 'rev-parse', 'HEAD')) -join '').Trim()
    $short = $sha.Substring(0, 7)
    if ($Release) {
        # -- A release -StageOnly already built and rehearsed ------------------------------
        $rel = Join-Path $p.ReleaseRoot $Release
        if (-not (Test-Path -LiteralPath (Join-Path $rel 'REHEARSED'))) { throw "$rel was not rehearsed (run -StageOnly)" }
        $stamp = $Release
        Ok "switching to $stamp, rehearsed $((Get-Content -LiteralPath (Join-Path $rel 'REHEARSED') -Raw).Trim())"
    } else {
        # -- 1. Committed work only --------------------------------------------------------
        Step 'working tree is clean'
        $dirty = (Invoke-Native 'git status' 'git' @('-C', $repo, 'status', '--porcelain')) -join "`n"
        if ($dirty.Trim()) { throw "uncommitted changes would ship:`n$dirty" }
        Ok "clean at $short"

        # -- 2. Gates ----------------------------------------------------------------------
        Step 'design check'
        Invoke-Step 'design check' { & node tools\design-sync.mjs check }
        if (-not $SkipTests) {
            Step 'typecheck'
            Invoke-Step 'typecheck' { & npm.cmd run typecheck }
            Step 'the full API and core suite against tshepovet_test and Redis db 15'
            Invoke-Step 'tests' { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'run-tests.ps1') }
        } else {
            Note '(skipping typecheck and tests at your request)'
        }

        # -- 3. Build ----------------------------------------------------------------------
        $stamp = "$(Get-Date -Format yyyyMMdd-HHmmss)-$short"
        Step "build $stamp"
        Invoke-Step 'tsc' { & npm.cmd run build }
        $env:TSV_BUILD_ID = $stamp
        $env:TSV_API_ORIGIN = "http://127.0.0.1:$($p.ApiPort)"
        $env:NEXT_TELEMETRY_DISABLED = '1'
        try { Invoke-Step 'next build' { Push-Location apps\web; try { & npx.cmd next build } finally { Pop-Location } } }
        finally { Remove-Item Env:\TSV_BUILD_ID, Env:\TSV_API_ORIGIN, Env:\NEXT_TELEMETRY_DISABLED -ErrorAction SilentlyContinue }

        # -- 4. Stage ----------------------------------------------------------------------
        Step 'stage the release'
        $rel = Join-Path $p.ReleaseRoot $stamp
        New-Item -ItemType Directory $rel | Out-Null
        foreach ($f in 'package.json', 'package-lock.json') { Copy-Item -LiteralPath (Join-Path $repo $f) (Join-Path $rel $f) }
        foreach ($ws in 'packages\core', 'packages\contracts', 'apps\api') {
            New-Item -ItemType Directory (Join-Path $rel $ws) -Force | Out-Null
            Copy-Item -LiteralPath (Join-Path $repo "$ws\package.json") (Join-Path $rel "$ws\package.json")
            Copy-Tree (Join-Path $repo "$ws\dist") (Join-Path $rel "$ws\dist")
        }
        # The web workspace's package.json keeps npm ci's view of the lockfile whole; its code
        # ships as the standalone server below, with its own traced node_modules.
        New-Item -ItemType Directory (Join-Path $rel 'apps\web') -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $repo 'apps\web\package.json') (Join-Path $rel 'apps\web\package.json')
        Push-Location $rel
        try { Invoke-Native 'npm ci --omit=dev (api)' 'npm.cmd' @('ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--workspace', '@tshepovet/api') | Out-Null }
        finally { Pop-Location }
        Ok 'production node_modules for the API installed'
        $std = Join-Path $repo 'apps\web\.next\standalone'
        Copy-Tree $std (Join-Path $rel 'web')
        Copy-Tree (Join-Path $repo 'apps\web\.next\static') (Join-Path $rel 'web\apps\web\.next\static')
        Copy-Tree (Join-Path $repo 'apps\web\public') (Join-Path $rel 'web\apps\web\public')
        if (-not (Test-Path -LiteralPath (Join-Path $rel 'web\apps\web\server.js'))) { throw 'the standalone web server is missing from the build' }
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'web.config') (Join-Path $rel 'web.config')
        Write-Utf8NoBom (Join-Path $rel 'COMMIT') "$sha`n"
        Ok "staged $rel"

        # -- 5. Rehearse -------------------------------------------------------------------
        Step 'rehearse the staged release on loopback (test database)'
        Invoke-Rehearsal $rel
        if ($StageOnly) {
            Write-Host "`nStaged and rehearsed $stamp; nothing live changed. Switch: deploy\app\deploy-app.ps1 -Release $stamp" -ForegroundColor Green
            return
        }
    }

    # -- 6. Backup -------------------------------------------------------------------------
    Step 'back up the live database'
    Lock-Folder $p.BackupDir
    $dump = Join-Path $p.BackupDir "tshepovet-$stamp.dump"
    $env:PGPASSWORD = $S['TSV_DB_OWNER_PASSWORD']
    try { Invoke-Native 'pg_dump' $p.PgDumpExe @('-h', '127.0.0.1', '-U', 'tshepovet_owner', '-d', $p.Database, '-Fc', '-f', $dump) | Out-Null }
    finally { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
    Ok "$dump ($([math]::Round((Get-Item -LiteralPath $dump).Length / 1KB)) KB)"

    # -- 7. Migrations ---------------------------------------------------------------------
    Step 'migrations (as tshepovet_owner)'
    $env:MIGRATION_DATABASE_URL = "postgres://tshepovet_owner:$($S['TSV_DB_OWNER_PASSWORD'])@127.0.0.1:5432/$($p.Database)"
    try { Invoke-Step 'migrate' { & npx.cmd tsx scripts/migrate.ts } }
    finally { Remove-Item Env:\MIGRATION_DATABASE_URL -ErrorAction SilentlyContinue }
    Ok 'schema up to date'

    # -- 8. Sandbox tenant (once) ----------------------------------------------------------
    if ($SeedSandbox) {
        Step 'sandbox tenant'
        if (Test-Path -LiteralPath $p.SandboxFile) { throw "$($p.SandboxFile) exists: the sandbox tenant was seeded already" }
        $env:MIGRATION_DATABASE_URL = "postgres://tshepovet_owner:$($S['TSV_DB_OWNER_PASSWORD'])@127.0.0.1:5432/$($p.Database)"
        $env:API_KEY_PEPPER = $S['TSV_API_KEY_PEPPER']
        try {
            Push-Location $repo
            $ErrorActionPreference = 'Continue'
            $seed = & npx.cmd tsx scripts/seed-dev.ts 2>$null
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

    # -- 9. Switch -------------------------------------------------------------------------
    Step "switch to $stamp"
    # The first release carries no web.config of its own: keep the live one with it, so a
    # rollback to it restores its routing.
    if ($current -and (Test-Path -LiteralPath $current) -and -not (Test-Path -LiteralPath (Join-Path $current 'web.config'))) {
        Copy-Item -LiteralPath (Join-Path $p.SiteDir 'web.config') (Join-Path $current 'web.config')
        Note "kept the live web.config with $(Split-Path $current -Leaf) for a rollback"
    }
    if (Switch-To $rel) {
        Set-Live $rel
        Ok "live: $stamp"
    } else {
        if ($current) {
            Note "not healthy; switching back to $(Split-Path $current -Leaf)"
            if (Switch-To $current) { Ok 'previous release restored' } else { Note 'the previous release is not healthy either' }
        }
        throw "$stamp did not come up; look at $($p.DataRoot)\api\logs, \worker\logs and \web\logs"
    }

    # -- 10. Through Cloudflare ------------------------------------------------------------
    if (-not $SkipEdgeCheck) {
        Step 'through Cloudflare'
        $cb = "cb=$(Get-Random)"
        $edge = Test-Native 'curl.exe' @('-s', '-D', '-', '--max-time', '20', "https://$($p.Host)/healthz?$cb")
        if ($edge.Out -notmatch '"ok":\s*true' -or $edge.Out -notmatch "x-tshepovet-release: $stamp") { throw "https://$($p.Host)/healthz answered: $($edge.Out)" }
        Ok "/healthz: ok, release $stamp"
        $page = Test-Native 'curl.exe' @('-s', '-D', '-', '-o', 'NUL', '--max-time', '20', "https://$($p.Host)/?$cb")
        if ($page.Out -notmatch 'HTTP/\S+ 200' -or $page.Out -notmatch "x-tshepovet-build: $stamp") { throw "https://$($p.Host)/ answered: $($page.Out)" }
        Ok "/: 200, build $stamp"
        # The certificate Cloudflare serves, by a .NET handshake that verifies the chain and the name
        # (throws if either fails). curl.exe uses Schannel here, whose -v prints no certificate details.
        $tcp = New-Object Net.Sockets.TcpClient($p.Host, 443)
        try {
            $ssl = New-Object Net.Security.SslStream($tcp.GetStream(), $false)
            $ssl.AuthenticateAsClient($p.Host)
            $cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2 $ssl.RemoteCertificate
            $tlsVersion = $ssl.SslProtocol
            $ssl.Dispose()
        } finally { $tcp.Close() }
        $days = [int]($cert.NotAfter - (Get-Date)).TotalDays
        Ok "certificate: $($cert.Subject), issuer $($cert.GetNameInfo('SimpleName', $true)), $tlsVersion, chain and name verified, valid until $($cert.NotAfter.ToString('yyyy-MM-dd')) ($days days)"
        if ($days -lt 14) { Note "the edge certificate expires in $days days: check Cloudflare's certificate renewal" }

        Step 'smoke suites through Cloudflare (API, web, docs)'
        if (Test-Path -LiteralPath $p.SandboxFile) {
            $env:TSV_SANDBOX_API_KEY = ((Get-Content -LiteralPath $p.SandboxFile -Raw) | ConvertFrom-Json).api_keys.test
        }
        $env:TSV_E2E_BASE_URL = "https://$($p.Host)"
        $env:TSV_EXPECT_BUILD = $stamp
        $env:TSV_EXPECT_RELEASE = $stamp
        try { Invoke-Step 'smoke suites' { & npx.cmd playwright test tests/smoke/api.smoke.ts tests/smoke/web.smoke.ts tests/smoke/site.smoke.ts --reporter=line } }
        catch { throw "$_ - $stamp is live; roll back with deploy\app\deploy-app.ps1 -Rollback if it is the cause" }
        finally { Remove-Item Env:\TSV_SANDBOX_API_KEY, Env:\TSV_E2E_BASE_URL, Env:\TSV_EXPECT_BUILD, Env:\TSV_EXPECT_RELEASE -ErrorAction SilentlyContinue }
    }

    # -- 11. Prune -------------------------------------------------------------------------
    $h = @(Get-History)
    $keep = @(Get-Releases | Select-Object -Last 3 | ForEach-Object { $_.FullName }) + @($h | Select-Object -Last 2)
    foreach ($r in Get-Releases) {
        if ($keep -notcontains $r.FullName -and $r.FullName -ne $rel) { Remove-Item -LiteralPath $r.FullName -Recurse -Force; Note "removed old release $($r.Name)" }
    }
    Write-Host "`nDeployed $stamp. Roll back: deploy\app\deploy-app.ps1 -Rollback" -ForegroundColor Green
} finally {
    $lock.Dispose()
}
