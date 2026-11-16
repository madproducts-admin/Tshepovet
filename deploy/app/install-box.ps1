<#
  Box setup for the TshepoVet API on this shared Windows box. Safe to re-run: each step
  checks what is already there. Run from an elevated Windows PowerShell 5.1:

    powershell -NoProfile -ExecutionPolicy Bypass -File deploy\app\install-box.ps1

  Sets up (owner-approved 2026-11-16; see deploy/README.md, "The API on the box"):
    1. secrets   C:\ProgramData\MADProducts\tshepovet\secrets.env (Administrators/SYSTEM
                 only), generated once. The three crypto keys are NEVER regenerated: data
                 encrypted or blind-indexed under them would become unreadable.
    2. database  logins and the databases tshepovet + tshepovet_test on the existing
                 PostgreSQL 18 (multisciple-new's instance), and a pg_hba block that keeps
                 these logins to their own databases. Admin access is SSPI as postgres.
    3. Redis     service tshepovet-redis on 127.0.0.1:6391, its own virtual account, its own
                 hash-checked copy of the Redis 8.10.2 binaries, no persistence.
    4. IIS       site tshepovet: https://tshepovet.madproducts.ai with the *.madproducts.ai
                 wildcard certificate, proxy only (deploy/app/web.config), no :80 binding.
    5. purge     scheduled task, hourly, SYSTEM: the POPIA retention purge (run-purge.ps1).
  The two Node services (tshepovet-api, tshepovet-webhooks) are installed by deploy-app.ps1.
  No secret is ever printed.
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'TsvBox.psm1') -Force
$p = Get-TsvPaths
$redisAcct = "NT SERVICE\$($p.RedisService)"
$apiAcct = "NT SERVICE\$($p.ApiService)"
$jobsAcct = "NT SERVICE\$($p.JobsService)"

# -- 0. Prerequisites ----------------------------------------------------------------------
Step 'prerequisites'
foreach ($f in $p.WinSW, $p.NodeExe, $p.PsqlExe, $p.PgHba) { if (-not (Test-Path -LiteralPath $f)) { throw "$f not found" } }
Assert-SameHash $p.WinSW (Get-WinSWSha256)
if ((Get-Service $p.PgService).Status -ne 'Running') { throw "$($p.PgService) is not running" }
foreach ($port in $p.ApiPort, $p.RedisPort) {
    $l = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if ($l.Count) {
        $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($l[0].OwningProcess)").CommandLine
        if ($cmd -notmatch 'tshepovet') { throw "port $port is already in use by: $cmd" }
    }
}
Ok 'WinSW pinned, PostgreSQL running, ports 9131/6391 free or ours'

# -- 1. Secrets ----------------------------------------------------------------------------
Step 'secrets'
Lock-Folder $p.SecretsDir
$want = [ordered]@{
    TSV_DB_OWNER_PASSWORD      = { New-HexPassword }
    TSV_DB_API_PASSWORD        = { New-HexPassword }
    TSV_DB_JOBS_PASSWORD       = { New-HexPassword }
    TSV_DB_TEST_OWNER_PASSWORD = { New-HexPassword }
    TSV_DB_TEST_API_PASSWORD   = { New-HexPassword }
    TSV_REDIS_PASSWORD         = { New-HexPassword }
    TSV_KEK_KEYS               = { "1:$(New-Base64Key)" }
    TSV_BLIND_INDEX_ROOT_KEY   = { New-Base64Key }
    TSV_API_KEY_PEPPER         = { New-Base64Key }
}
$lines = @()
$have = @{}
if (Test-Path -LiteralPath $p.SecretsFile) {
    $have = Read-SecretsFile $p.SecretsFile
    $lines = @(Get-Content -LiteralPath $p.SecretsFile)
}
$added = @()
foreach ($k in $want.Keys) {
    if (-not $have.ContainsKey($k)) { $lines += "$k=$(& $want[$k])"; $added += $k }
}
if ($added.Count) {
    Write-Utf8NoBom $p.SecretsFile (($lines -join "`r`n") + "`r`n")
    Lock-Folder $p.SecretsDir
    Ok "generated $($added -join ', ')"
} else {
    Ok 'all present (nothing regenerated)'
}
$S = Read-SecretsFile $p.SecretsFile

# -- 2. PostgreSQL -------------------------------------------------------------------------
Step 'PostgreSQL: roles and databases'
# The migration creates the two group roles itself if they are missing, but BYPASSRLS needs
# a superuser, so they are made here. Attributes such as BYPASSRLS are not inherited through
# membership, so the logins that need it carry it themselves.
$roles = @(
    @{ n = 'tshepovet_owner';      a = 'BYPASSRLS';   pw = 'TSV_DB_OWNER_PASSWORD';      in = $null }
    @{ n = 'tshepovet_api';        a = 'NOBYPASSRLS'; pw = 'TSV_DB_API_PASSWORD';        in = 'tshepovet_app' }
    @{ n = 'tshepovet_jobs';       a = 'BYPASSRLS';   pw = 'TSV_DB_JOBS_PASSWORD';       in = 'tshepovet_worker' }
    @{ n = 'tshepovet_test_owner'; a = 'BYPASSRLS';   pw = 'TSV_DB_TEST_OWNER_PASSWORD'; in = $null }
    @{ n = 'tshepovet_test_api';   a = 'NOBYPASSRLS'; pw = 'TSV_DB_TEST_API_PASSWORD';   in = 'tshepovet_app' }
)
$sql = @(
    "DO `$`$ BEGIN",
    "  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tshepovet_app') THEN CREATE ROLE tshepovet_app NOLOGIN; END IF;",
    "  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tshepovet_worker') THEN CREATE ROLE tshepovet_worker NOLOGIN BYPASSRLS; END IF;"
)
foreach ($r in $roles) { $sql += "  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$($r.n)') THEN CREATE ROLE $($r.n) LOGIN; END IF;" }
$sql += "END `$`$;"
foreach ($r in $roles) {
    $sql += "ALTER ROLE $($r.n) LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION $($r.a) PASSWORD '$($S[$r.pw])';"
    if ($r.in) { $sql += "GRANT $($r.in) TO $($r.n);" }
}
Invoke-PgAdmin ($sql -join "`n") | Out-Null
$dbs = @(
    @{ n = $p.Database;     owner = 'tshepovet_owner';      logins = 'tshepovet_owner, tshepovet_api, tshepovet_jobs' }
    @{ n = $p.TestDatabase; owner = 'tshepovet_test_owner'; logins = 'tshepovet_test_owner, tshepovet_test_api' }
)
foreach ($db in $dbs) {
    if (-not (Invoke-PgAdmin "SELECT 1 FROM pg_database WHERE datname = '$($db.n)'")) {
        Invoke-PgAdmin "CREATE DATABASE $($db.n) OWNER $($db.owner) ENCODING 'UTF8' TEMPLATE template0" | Out-Null
        Ok "created database $($db.n)"
    }
    Invoke-PgAdmin "REVOKE ALL ON DATABASE $($db.n) FROM PUBLIC; GRANT CONNECT, TEMPORARY ON DATABASE $($db.n) TO $($db.logins);" | Out-Null
}
Ok 'roles, passwords and databases in place'

Step 'PostgreSQL: pg_hba (these logins reach only their own database)'
$begin = '# >>> tshepovet: written by deploy/app/install-box.ps1 (TshepoVet repo); edits are overwritten'
$end = '# <<< tshepovet'
$all = 'tshepovet_owner,tshepovet_api,tshepovet_jobs,tshepovet_test_owner,tshepovet_test_api'
$block = @(
    $begin,
    'host    tshepovet       tshepovet_owner,tshepovet_api,tshepovet_jobs  127.0.0.1/32  scram-sha-256',
    'host    tshepovet       tshepovet_owner,tshepovet_api,tshepovet_jobs  ::1/128       scram-sha-256',
    'host    tshepovet_test  tshepovet_test_owner,tshepovet_test_api       127.0.0.1/32  scram-sha-256',
    'host    tshepovet_test  tshepovet_test_owner,tshepovet_test_api       ::1/128       scram-sha-256',
    "host    all             $all  all  reject",
    "local   all             $all       reject",
    $end
)
$old = @(Get-Content -LiteralPath $p.PgHba)
$kept = @()
$inBlock = $false
foreach ($l in $old) {
    if ($l -eq $begin) { $inBlock = $true; continue }
    if ($inBlock) { if ($l -eq $end) { $inBlock = $false }; continue }
    $kept += $l
}
# Before the first catch-all "host all all" rule: pg_hba stops at the first match.
$anchor = -1
for ($i = 0; $i -lt $kept.Count; $i++) { if ($kept[$i] -match '^\s*host\s+all\s+all\s') { $anchor = $i; break } }
if ($anchor -lt 0) { throw "no 'host all all' rule in $($p.PgHba) to insert before; look at the file" }
$new = @()
if ($anchor -gt 0) { $new += $kept[0..($anchor - 1)] }
$new += $block
$new += $kept[$anchor..($kept.Count - 1)]
if (($new -join "`n") -ne ($old -join "`n")) {
    $backup = "$($p.PgHba).tshepovet-$(Get-Date -Format yyyyMMdd-HHmmss).bak"
    Copy-Item -LiteralPath $p.PgHba $backup
    Write-Utf8NoBom $p.PgHba (($new -join "`r`n") + "`r`n")
    $errors = Invoke-PgAdmin "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL"
    if ([int]($errors | Select-Object -First 1) -ne 0) {
        Copy-Item -LiteralPath $backup $p.PgHba -Force
        throw "the new pg_hba.conf has errors; restored $backup and did not reload"
    }
    Invoke-PgAdmin 'SELECT pg_reload_conf()' | Out-Null
    Ok "pg_hba updated and reloaded (backup $backup)"
} else {
    Ok 'pg_hba already has the block'
}
$env:PGPASSWORD = $S['TSV_DB_OWNER_PASSWORD']
try {
    $own = Test-Native $p.PsqlExe @('-h', '127.0.0.1', '-U', 'tshepovet_owner', '-d', $p.Database, '-w', '-X', '-At', '-c', 'select current_user')
    if ($own.Code -ne 0) { throw "tshepovet_owner cannot connect: $($own.Out)" }
    $other = Test-Native $p.PsqlExe @('-h', '127.0.0.1', '-U', 'tshepovet_owner', '-d', 'postgres', '-w', '-X', '-At', '-c', 'select 1')
    if ($other.Code -eq 0) { throw 'tshepovet_owner can reach the postgres database: the pg_hba block is not in effect' }
} finally { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
Ok 'tshepovet_owner connects to tshepovet and is refused elsewhere'

# -- 3. Redis ------------------------------------------------------------------------------
Step "Redis: $($p.RedisService) on 127.0.0.1:$($p.RedisPort)"
$hashes = Get-RedisFileHashes
Lock-Folder $p.RedisBin @($redisAcct)
foreach ($f in $hashes.Keys) {
    $dst = Join-Path $p.RedisBin $f
    $same = (Test-Path -LiteralPath $dst) -and ((Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash -eq $hashes[$f])
    if (-not $same) {
        $src = Join-Path $p.RedisSource $f
        Assert-SameHash $src $hashes[$f]
        Copy-Item -LiteralPath $src $dst -Force
    }
    Assert-SameHash $dst $hashes[$f]
}
Lock-Folder $p.RedisBin @($redisAcct)

Lock-Folder $p.DataRoot @($redisAcct, $apiAcct, $jobsAcct) -Shallow
$redisDir = Join-Path $p.DataRoot 'redis'
Lock-Folder $redisDir @($redisAcct)
New-Item -ItemType Directory (Join-Path $redisDir 'data'), (Join-Path $redisDir 'logs') -Force | Out-Null
$confPath = Join-Path $redisDir 'redis.conf'
$conf = @"
# TshepoVet Redis. Written by deploy/app/install-box.ps1 (TshepoVet repo); edits are overwritten.
# Cache, locks, rate limits and provider health only: nothing here has to survive a restart,
# so there is no persistence (and WinSW's stop, which kills the process, loses nothing).
bind 127.0.0.1
protected-mode yes
port $($p.RedisPort)
tcp-backlog 511
timeout 0
tcp-keepalive 60
daemonize no
loglevel notice
logfile ""
always-show-logo no
set-proc-title no
databases 16
requirepass $($S['TSV_REDIS_PASSWORD'])
dir $((Join-Path $redisDir 'data') -replace '\\', '/')
save ""
appendonly no
maxmemory 256mb
maxmemory-policy volatile-lru
maxclients 200
enable-debug-command no
enable-module-command no
enable-protected-configs no
"@
$confChanged = -not (Test-Path -LiteralPath $confPath) -or ((Get-Content -LiteralPath $confPath -Raw) -ne $conf)
if ($confChanged) { Write-Utf8NoBom $confPath $conf }

$svcDir = Join-Path $p.ServicesRoot $p.RedisService
$svcExe = Join-Path $svcDir "$($p.RedisService).exe"
$svcXml = Join-Path $svcDir "$($p.RedisService).xml"
Lock-Folder $svcDir @($redisAcct)
# The config file is passed relative to the working directory: this (msys) Redis build reads
# an argument like D:/x/redis.conf as a path under the working directory.
$xml = @"
<service>
  <id>$($p.RedisService)</id>
  <name>TshepoVet Redis</name>
  <description>Redis 8.10.2 for TshepoVet on 127.0.0.1:$($p.RedisPort): cache, locks, rate limits, no persistence. Managed by deploy/app/install-box.ps1 (TshepoVet repo).</description>
  <executable>$(Join-Path $p.RedisBin 'redis-server.exe')</executable>
  <arguments>redis.conf</arguments>
  <workingdirectory>$redisDir</workingdirectory>
  <logpath>$(Join-Path $redisDir 'logs')</logpath>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>4</keepFiles></log>
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="30 sec" />
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>10 sec</stoptimeout>
  <startmode>Automatic</startmode>
</service>
"@
$xmlChanged = -not (Test-Path -LiteralPath $svcXml) -or ((Get-Content -LiteralPath $svcXml -Raw) -ne $xml)
if ($xmlChanged) { Write-Utf8NoBom $svcXml $xml }
if (-not (Get-Service -Name $p.RedisService -ErrorAction SilentlyContinue)) {
    Copy-Item -LiteralPath $p.WinSW $svcExe -Force
    Assert-SameHash $svcExe (Get-WinSWSha256)
    Invoke-Native 'WinSW install (redis)' $svcExe @('install') | Out-Null
    Invoke-Native 'sc config (redis)' 'sc.exe' @('config', $p.RedisService, 'obj=', $redisAcct) | Out-Null
    Ok "service $($p.RedisService) installed, runs as $redisAcct"
}
Assert-SameHash $svcExe (Get-WinSWSha256)
Grant-Folder $p.RedisBin $redisAcct 'RX'
Grant-Folder $svcDir $redisAcct 'RX'
Grant-Folder $redisDir $redisAcct 'M'
$svc = Get-Service -Name $p.RedisService
if ($confChanged -or $xmlChanged -or $svc.Status -ne 'Running') {
    Restart-Service -Name $p.RedisService -Force
    Start-Sleep -Seconds 2
}
$cli = Join-Path $p.RedisBin 'redis-cli.exe'
$env:REDISCLI_AUTH = $S['TSV_REDIS_PASSWORD']
try {
    $pong = Test-Native $cli @('-h', '127.0.0.1', '-p', "$($p.RedisPort)", 'ping')
} finally { Remove-Item Env:\REDISCLI_AUTH -ErrorAction SilentlyContinue }
if ($pong.Out -ne 'PONG') { throw "Redis did not answer PING: $($pong.Out)" }
$anon = Test-Native $cli @('-h', '127.0.0.1', '-p', "$($p.RedisPort)", 'ping')
if ($anon.Out -match 'PONG') { throw 'Redis answers without a password' }
Ok 'running; answers PING with the password and refuses without it'

# -- 4. IIS --------------------------------------------------------------------------------
Step "IIS: site $($p.SiteName) for https://$($p.Host)"
Import-Module WebAdministration
$poolPath = "IIS:\AppPools\$($p.SiteName)"
if (-not (Test-Path $poolPath)) { New-WebAppPool -Name $p.SiteName | Out-Null; Ok "app pool $($p.SiteName) created" }
Set-ItemProperty $poolPath -Name managedRuntimeVersion -Value ''
$poolAcct = "IIS AppPool\$($p.SiteName)"
Lock-Folder $p.SiteDir @($poolAcct)
$webConfig = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'web.config') -Raw
$target = Join-Path $p.SiteDir 'web.config'
if (-not (Test-Path -LiteralPath $target) -or ((Get-Content -LiteralPath $target -Raw) -ne $webConfig)) {
    Write-Utf8NoBom $target $webConfig
    Ok 'web.config written'
}
Lock-Folder $p.SiteDir @($poolAcct)
Grant-Folder $p.SiteDir $poolAcct 'RX'

$cert = Get-ChildItem Cert:\LocalMachine\WebHosting |
    Where-Object { $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date).AddDays(7) -and ($_.DnsNameList | ForEach-Object { $_.Unicode }) -contains '*.madproducts.ai' } |
    Sort-Object NotAfter -Descending | Select-Object -First 1
if (-not $cert) { throw 'no valid *.madproducts.ai certificate in LocalMachine\WebHosting' }
if (-not (Get-Website -Name $p.SiteName)) {
    New-Website -Name $p.SiteName -PhysicalPath $p.SiteDir -ApplicationPool $p.SiteName -HostHeader $p.Host -Port 443 -Ssl -SslFlags 1 | Out-Null
    Ok "site $($p.SiteName) created"
}
foreach ($b in @(Get-WebBinding -Name $p.SiteName -Protocol http)) { $b | Remove-WebBinding; Ok 'removed an http binding (Cloudflare does the redirect)' }
$binding = Get-WebBinding -Name $p.SiteName -Protocol https -Port 443 -HostHeader $p.Host
if (-not $binding) { New-WebBinding -Name $p.SiteName -Protocol https -Port 443 -HostHeader $p.Host -SslFlags 1; $binding = Get-WebBinding -Name $p.SiteName -Protocol https -Port 443 -HostHeader $p.Host }
$sslPath = "IIS:\SslBindings\!443!$($p.Host)"
$current = $null
if (Test-Path $sslPath) { $current = (Get-Item $sslPath).Thumbprint }
if ($current -ne $cert.Thumbprint) {
    $binding.AddSslCertificate($cert.Thumbprint, 'WebHosting')
    Ok "binding uses certificate $($cert.Thumbprint.Substring(0, 8))... (expires $($cert.NotAfter.ToString('yyyy-MM-dd')))"
}
if ((Get-Website -Name $p.SiteName).State -ne 'Started') { Start-Website -Name $p.SiteName }
$code = & curl.exe -s -o NUL -w '%{http_code} %{redirect_url}' --max-time 20 --resolve "$($p.Host):443:127.0.0.1" "https://$($p.Host)/"
if ($code -notmatch '^302 .*/docs/$') { throw "the origin answered '$code' for /, expected a 302 to /docs/" }
Ok "origin answers / with $code"

# -- 5. Retention purge task ---------------------------------------------------------------
Step "scheduled task: $($p.PurgeTask)"
$purgeDir = Join-Path $p.ServicesRoot 'tshepovet-purge'
Lock-Folder $purgeDir
foreach ($f in 'run-purge.ps1', 'TsvBox.psm1') { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $f) (Join-Path $purgeDir $f) -Force }
Lock-Folder $purgeDir
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $purgeDir 'run-purge.ps1')`""
$trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date.AddMinutes(17)) -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $p.PurgeTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'TshepoVet POPIA retention purge (node dist/workers/retentionPurge.js in the live release). deploy/app/install-box.ps1, TshepoVet repo.' -Force | Out-Null
Ok 'registered: hourly at :17, as SYSTEM (does nothing until the first app deploy)'

Write-Host "`nBox setup complete. Next: deploy\app\deploy-app.ps1" -ForegroundColor Green
