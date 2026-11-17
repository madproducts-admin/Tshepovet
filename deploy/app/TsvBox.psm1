# Shared helpers and constants for the TshepoVet box scripts (deploy/app/*.ps1). Windows
# PowerShell 5.1. The folder helpers are multisciple-new's (deploy/box/MsnBox.psm1 in that
# repo), which came out of three security reviews; keep them in step.

# -- Where everything lives on the box -----------------------------------------------------
function Get-TsvPaths {
    @{
        Host          = 'tshepovet.madproducts.ai'
        Database      = 'tshepovet'
        TestDatabase  = 'tshepovet_test'
        ApiPort       = 9131
        WebPort       = 9132   # tshepovet-web (Next.js), behind IIS
        RehearsalApiPort = 9197  # deploy-app.ps1's rehearsal of a staged release: loopback,
        RehearsalWebPort = 9198  # the test database, never routed
        RedisPort     = 6391
        SecretsDir    = 'C:\ProgramData\MADProducts\tshepovet'
        SecretsFile   = 'C:\ProgramData\MADProducts\tshepovet\secrets.env'
        SandboxFile   = 'C:\ProgramData\MADProducts\tshepovet\sandbox-tenant.json'
        DataRoot      = 'D:\madproducts-data\tshepovet'
        DocumentsDir  = 'D:\madproducts-data\tshepovet\documents'
        BackupDir     = 'D:\madproducts-data\tshepovet\backups'
        ReleaseRoot   = 'D:\releases\tshepovet'
        CurrentFile   = 'D:\releases\tshepovet\current.txt'
        SiteDir       = 'D:\sites\tshepovet'
        SiteName      = 'tshepovet'
        ServicesRoot  = 'C:\madproducts\services'
        WinSW         = 'C:\madproducts\bin\WinSW-x64.exe'
        RedisSource   = 'C:\madproducts\bin\redis-8.10.2'          # multisciple-new's, hash-checked
        RedisBin      = 'C:\madproducts\bin\tshepovet-redis-8.10.2' # our own copy
        NodeExe       = 'C:\Program Files\nodejs\node.exe'
        PsqlExe       = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
        PgDumpExe     = 'C:\Program Files\PostgreSQL\18\bin\pg_dump.exe'
        PgService     = 'postgresql-x64-18'
        PgHba         = 'D:\PostgreSQL\18\data\pg_hba.conf'
        PublicIp      = '209.58.145.5'       # the box's own address: webhook targets never dial it
        ApiService    = 'tshepovet-api'
        WorkerService = 'tshepovet-worker'   # the full app's jobs (apps/api/dist/worker.js)
        WebService    = 'tshepovet-web'      # the web app (the Next.js standalone server)
        JobsService   = 'tshepovet-webhooks' # the first release's dispatcher: disabled, kept for a rollback
        RedisService  = 'tshepovet-redis'
        PurgeTask     = 'MADProducts tshepovet retention purge'
        LockFile      = 'D:\releases\tshepovet\.deploy.lock'
    }
}

# WinSW v2.12.0 x64 (github.com/winsw/winsw); the same pin as multisciple-new.
$script:WinSWSha256 = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA'

# The Redis 8.10.2 files multisciple-new installed after checking its release zip
# (install-redis.ps1 there). Copied, never used in place: that folder admits only its service.
$script:RedisFiles = @{
    'msys-2.0.dll'         = 'CFE7BD8E8B36B851BDF788B95DD2B2A0BEEC5EBF83B579FDEC480445F5919545'
    'msys-crypto-3.dll'    = '318A5FF40425F08F2B740649F9AFE40B28AF270C70A2253DF924AAEE49BC2548'
    'msys-gcc_s-seh-1.dll' = '59B816EE2880C2140AC8D7726F59E4E7435E309F272A80FD590D3130215F77F5'
    'msys-ssl-3.dll'       = 'A0C446AD917EEAE3E448100A30019CDCAA3CAA069B7F3A86436594AB6F16C60A'
    'msys-stdc++-6.dll'    = 'BE5745A191D1FA4813AC662F550BC48C568EE63915829A20ADA4E1BE7F625FDC'
    'redis-cli.exe'        = '30A52493ADA5D509D5B5D50DDFBE2CF1C909C29690479241806021F121418041'
    'redis-server.exe'     = '5BC44512F4FF7828F0D65E59AD712C1B66F692C4F827C966123D3ECE4EC5945C'
}

function Get-WinSWSha256 { $script:WinSWSha256 }
function Get-RedisFileHashes { $script:RedisFiles }

# -- Output --------------------------------------------------------------------------------
function Step([string]$Text) { Write-Host "`n-- $Text" -ForegroundColor Cyan }
function Ok([string]$Text) { Write-Host "   ok: $Text" -ForegroundColor Green }
function Note([string]$Text) { Write-Host "   $Text" }

# -- Native commands -----------------------------------------------------------------------
# PowerShell 5.1 turns a native command's redirected stderr into error records, which
# 'Stop' makes terminating; these helpers judge by exit code instead. They take the program
# and its arguments, not a scriptblock: a caller's scriptblock runs in the caller's session
# state, where the caller's 'Stop' still applies.
function Invoke-Native([string]$What, [string]$Exe, [string[]]$Arguments = @()) {
    $ErrorActionPreference = 'Continue'
    $out = & $Exe @Arguments 2>&1 | ForEach-Object { "$_" }
    if ($LASTEXITCODE -ne 0) { throw "$What failed ($LASTEXITCODE): $($out -join '; ')" }
    $out
}

# psql as the postgres superuser over SSPI (pg_ident maps Administrator to postgres): no
# password anywhere. The SQL goes in on stdin, so secrets in it never reach a command line.
function Invoke-PgAdmin([string]$Sql, [string]$Database = 'postgres') {
    $ErrorActionPreference = 'Continue'
    $p = Get-TsvPaths
    $OutputEncoding = New-Object Text.UTF8Encoding($false)
    $out = $Sql | & $p.PsqlExe -h 127.0.0.1 -U postgres -d $Database -w -X -q -At -v ON_ERROR_STOP=1 -f - 2>&1 | ForEach-Object { "$_" }
    if ($LASTEXITCODE -ne 0) { throw "psql ($Database) failed: $($out -join '; ')" }
    $out
}

# -- Folders (from multisciple-new's MsnBox.psm1) ------------------------------------------
function Invoke-Icacls {
    & icacls.exe @args | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls $($args -join ' ') failed ($LASTEXITCODE)" }
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

# No junction or symbolic link anywhere on the path: a planted link would redirect writes.
function Assert-NoLinks([string]$Path) {
    $p = $Path
    while ($p) {
        if (Test-Path -LiteralPath $p) {
            $item = Get-Item -LiteralPath $p -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$p is a link (reparse point); refusing to use it" }
        }
        $parent = Split-Path $p -Parent
        if (-not $parent -or $parent -eq $p) { break }
        $p = $parent
    }
}

# A folder only Administrators, SYSTEM and $Allowed can use; anything else on it stops the
# script for a person to look at. -Shallow checks the folder itself only (for folders whose
# contents only this tooling writes, such as releases with node_modules).
function Lock-Folder([string]$Path, [string[]]$Allowed = @(), [switch]$Shallow) {
    Assert-NoLinks $Path
    New-Item -ItemType Directory $Path -Force | Out-Null
    Assert-NoLinks $Path
    Invoke-Icacls $Path /inheritance:r /grant:r 'Administrators:(OI)(CI)F' 'SYSTEM:(OI)(CI)F' /L
    $ok = @('BUILTIN\Administrators', 'NT AUTHORITY\SYSTEM') + $Allowed
    Protect-Entry (Get-Item -LiteralPath $Path -Force) $ok
    if (-not $Shallow) { Protect-Contents $Path $ok }
}

function Protect-Entry([IO.FileSystemInfo]$Item, [string[]]$Ok) {
    if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$($Item.FullName) is a link (reparse point); refusing to use it" }
    Invoke-Icacls $Item.FullName /setowner 'Administrators' /L /Q
    $acl = Get-Acl -LiteralPath $Item.FullName
    if ($acl.Owner -ne 'BUILTIN\Administrators') { throw "$($Item.FullName) is owned by $($acl.Owner), not Administrators" }
    foreach ($ace in $acl.Access) {
        if ($Ok -notcontains $ace.IdentityReference.Value) {
            throw "$($Item.FullName) grants $($ace.FileSystemRights) to $($ace.IdentityReference); expected only $($Ok -join ', ')"
        }
    }
}

function Protect-Contents([string]$Dir, [string[]]$Ok) {
    foreach ($item in ([IO.DirectoryInfo]$Dir).EnumerateFileSystemInfos()) {
        Protect-Entry $item $Ok
        if ($item -is [IO.DirectoryInfo]) { Protect-Contents $item.FullName $Ok }
    }
}

function Grant-Folder([string]$Path, [string]$Identity, [string]$Rights) {
    Invoke-Icacls $Path /grant:r "${Identity}:(OI)(CI)$Rights"
}

function Assert-SameHash([string]$Path, [string]$Expected) {
    $h = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    if ($h -ne $Expected) { throw "$Path does not match its pinned SHA-256 (got $h)" }
}

# -- Secrets -------------------------------------------------------------------------------
# KEY=VALUE lines of the Administrators/SYSTEM-only secrets file. No caller prints a value.
function Read-SecretsFile([string]$Path) {
    $owner = (Get-Acl -LiteralPath $Path).Owner
    if ($owner -ne 'BUILTIN\Administrators') { throw "$Path is owned by $owner, not Administrators" }
    $map = @{}
    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
        if ($line -match '^([A-Z0-9_]+)=(.*)$') { $map[$Matches[1]] = $Matches[2] }
    }
    $map
}

# Random bytes from the OS CSPRNG. (RandomNumberGenerator.Fill does not exist in 5.1.)
function New-RandomBytes([int]$Count) {
    $b = New-Object byte[] $Count
    $rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
    try { $rng.GetBytes($b) } finally { $rng.Dispose() }
    $b
}
function New-Base64Key { [Convert]::ToBase64String((New-RandomBytes 32)) }
function New-HexPassword { -join ((New-RandomBytes 24) | ForEach-Object { $_.ToString('x2') }) }

# The environment both Node services and the purge share, built from the secrets.
function Get-AppEnv([hashtable]$S, [string]$Login) {
    $p = Get-TsvPaths
    $pw = @{ api = $S['TSV_DB_API_PASSWORD']; jobs = $S['TSV_DB_JOBS_PASSWORD'] }[$Login]
    $db = "postgres://tshepovet_${Login}:$pw@127.0.0.1:5432/$($p.Database)"
    [ordered]@{
        NODE_ENV             = 'production'
        HOST                 = '127.0.0.1'
        PORT                 = "$($p.ApiPort)"
        DATABASE_URL         = $db
        WORKER_DATABASE_URL  = $db
        REDIS_URL            = "redis://:$($S['TSV_REDIS_PASSWORD'])@127.0.0.1:$($p.RedisPort)/0"
        KEK_KEYS             = $S['TSV_KEK_KEYS']
        BLIND_INDEX_ROOT_KEY = $S['TSV_BLIND_INDEX_ROOT_KEY']
        API_KEY_PEPPER       = $S['TSV_API_KEY_PEPPER']
        # Sandbox only: in production mode live keys get no provider at all, so only the
        # tv_test_ keys' deterministic mock answers. See deploy/README.md.
        ENABLED_PROVIDERS    = 'mock'
    }
}

# The environment of one of the full app's services (deploy-app.ps1). Sandbox only: test keys
# reach the mock bureau, top-ups are pretend, mail is held for the staff console.
#   api     tshepovet-api: the tenant-scoped login, and the jobs login for the staff console
#   worker  tshepovet-worker: the jobs login (BYPASSRLS) for every job
#   web     tshepovet-web: no database and no keys; it calls the API on loopback
function Get-ServiceEnv([hashtable]$S, [string]$Role, [string]$Release) {
    $p = Get-TsvPaths
    $apiDb = "postgres://tshepovet_api:$($S['TSV_DB_API_PASSWORD'])@127.0.0.1:5432/$($p.Database)"
    $jobsDb = "postgres://tshepovet_jobs:$($S['TSV_DB_JOBS_PASSWORD'])@127.0.0.1:5432/$($p.Database)"
    if ($Role -eq 'web') {
        return [ordered]@{
            NODE_ENV                = 'production'
            HOSTNAME                = '127.0.0.1'
            PORT                    = "$($p.WebPort)"
            TSV_API_ORIGIN          = "http://127.0.0.1:$($p.ApiPort)"
            TSV_PUBLIC_ORIGIN       = "https://$($p.Host)"
            NEXT_TELEMETRY_DISABLED = '1'
        }
    }
    $e = [ordered]@{
        NODE_ENV             = 'production'
        HOST                 = '127.0.0.1'
        PORT                 = "$($p.ApiPort)"
        REDIS_URL            = "redis://:$($S['TSV_REDIS_PASSWORD'])@127.0.0.1:$($p.RedisPort)/0"
        KEK_KEYS             = $S['TSV_KEK_KEYS']
        BLIND_INDEX_ROOT_KEY = $S['TSV_BLIND_INDEX_ROOT_KEY']
        API_KEY_PEPPER       = $S['TSV_API_KEY_PEPPER']
        ENABLED_PROVIDERS    = 'mock'
        SANDBOX              = 'true'
        WEBHOOK_DENY_IPS     = $p.PublicIp
        APP_URL              = "https://$($p.Host)"
        DOCUMENT_STORE_DIR   = ($p.DocumentsDir -replace '\\', '/')
        TSV_RELEASE          = (Split-Path $Release -Leaf)
    }
    if ($Role -eq 'api') {
        $e['DATABASE_URL'] = $apiDb
        $e['STAFF_DATABASE_URL'] = $jobsDb
    } elseif ($Role -eq 'worker') {
        $e['DATABASE_URL'] = $jobsDb
        $e['WORKER_DATABASE_URL'] = $jobsDb
    } else { throw "unknown service role '$Role'" }
    # Who runs TshepoVet (the ECTA s43 footer and terms, tax invoices): public facts kept with the
    # box settings in secrets.env, passed on only when filled in (an empty value would fail the
    # API's configuration check; unset, the site shows the owner's bracketed placeholders).
    foreach ($k in 'SELLER_LEGAL_NAME', 'SELLER_TRADING_NAME', 'SELLER_REGISTRATION_NUMBER', 'SELLER_VAT_NUMBER', 'SELLER_ADDRESS',
        'SELLER_DIRECTORS', 'SELLER_EMAIL', 'SELLER_PHONE', 'SELLER_INFORMATION_OFFICER', 'SELLER_INFORMATION_REGULATOR_NUMBER') {
        if ($S.ContainsKey($k) -and "$($S[$k])".Trim()) { $e[$k] = "$($S[$k])".Trim() }
    }
    $e
}

# Runs a native command, returns @{ Code; Out }, never throws: for checks where failing is
# the expected answer (a refused login, a refused password-less PING).
function Test-Native([string]$Exe, [string[]]$Arguments = @()) {
    $ErrorActionPreference = 'Continue'
    $out = & $Exe @Arguments 2>&1 | ForEach-Object { "$_" }
    @{ Code = $LASTEXITCODE; Out = ($out -join '; ') }
}

function ConvertTo-EnvXml($Envs) {
    ($Envs.GetEnumerator() | ForEach-Object {
        "  <env name=`"$($_.Key)`" value=`"$([Security.SecurityElement]::Escape([string]$_.Value))`" />"
    }) -join "`r`n"
}

Export-ModuleMember -Function Get-TsvPaths, Get-WinSWSha256, Get-RedisFileHashes, Step, Ok, Note, Invoke-Native,
    Invoke-PgAdmin, Invoke-Icacls, Write-Utf8NoBom, Assert-NoLinks, Lock-Folder, Grant-Folder, Assert-SameHash,
    Read-SecretsFile, New-Base64Key, New-HexPassword, Get-AppEnv, Get-ServiceEnv, Test-Native, ConvertTo-EnvXml
