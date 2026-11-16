# TshepoVet on tshepovet.madproducts.ai

One host, two parts:

| Path | Served by | Deploy |
|---|---|---|
| `/docs*`, `/robots.txt` | Cloudflare Worker `tshepovet-site`: the five design pages from `docs/pages/`, static, on Worker **routes** | `npm run deploy` (tools/deploy.mjs) |
| everything else | IIS site `tshepovet` on the MADPRODUCTS box, which proxies to the Windows service `tshepovet-api` (Express, `127.0.0.1:9131`). `/` redirects to `/docs/`. | `deploy\app\deploy-app.ps1` |

**The API is a sandbox.** The owner chose this on 2026-11-16, for three reasons:

- This box is outside South Africa, and TshepoVet's own design keeps personal information in af-south-1.
- The bureau adapters are placeholders.
- There is no SARS TCS channel yet.

So the services run with `NODE_ENV=production` and `ENABLED_PROVIDERS=mock`. In that mode live (`tv_live_`) keys get no provider at all, and only sandbox (`tv_test_`) keys work, against the deterministic mock bureau. WhatsApp and OCR are off: no WhatsApp secrets are set, and there is no AI key; under the fleet rule, apps reach AI through the Cloud gateway. **Do not send real personal information to it.**

Search engines are kept out of both parts:

- every response carries `X-Robots-Tag: noindex, nofollow`;
- the docs pages also have a robots meta tag;
- `/robots.txt` disallows everything.

## The docs (`/docs`, Cloudflare Worker)

| | |
|---|---|
| Worker | `tshepovet-site`: assets only, with no `main`, no bindings and no crons |
| Routes | `tshepovet.madproducts.ai/docs*` and `/robots.txt` on the `madproducts.ai` zone. Plain routes, never a custom domain (see the quirks) |
| Account | the one that holds the `madproducts.ai` zone and Mia's Crowns (`mias-crowns-site`) |
| Config | [`deploy/site/wrangler.toml`](site/wrangler.toml); page map, routes and CSP origins in [`tools/lib/site.json`](../tools/lib/site.json) |

```bash
npm run site:build         # build/site/ + deploy/dist/ (with _headers)
npm run site:smoke:local   # docs smoke suite against `wrangler dev` on deploy/dist
npm run deploy:dry         # gates + build + checks, stops before wrangler
npm run deploy             # the real thing
npm run site:smoke         # docs smoke suite against the live site
```

`npm run deploy` runs these steps in order:

0. **Pre-checks.** The working tree must be clean: the deploy builds the working tree, not HEAD. Cloudflare credentials must be usable. The route pre-flight must pass: no custom domain on the host, and no other Worker on our routes.
1. **Gates.** `npm run typecheck` and `npm run test:unit:no-services`: 52 tests, the ones that need no Redis or PostgreSQL.
2. **Build.** `tools/build-site.mjs` builds the site (see "What the docs build does").
3. **Assemble.** `tools/assemble-deploy.mjs` writes `deploy/dist` and its `_headers` file.
4. **Upload.** `npx wrangler@4 deploy` from `deploy/site/`.
5. **Wait.** It polls `/docs/` until the `<meta name="build-id">` is the new git SHA.
6. **Smoke.** It runs `tests/smoke/site.smoke.ts` against the live host.

It prints the Worker version id at the end.

**Rollback:** `cd deploy/site && npx wrangler@4 rollback --name tshepovet-site`.

### Cloudflare credentials (this machine)

- **Token.** Use wrangler's OAuth login. The `CLOUDFLARE_API_TOKEN` in Mia's Crowns' `old/v1/.env` is dead.
  1. With `CLOUDFLARE_API_TOKEN` unset, run any wrangler command (`npx wrangler@4 whoami`) to refresh the login.
  2. The deploy script then reads `oauth_token` from `%APPDATA%\xdg.config\.wrangler\config\default.toml` itself, and never prints it.
- **Expiry.** The token lasts an hour, and running wrangler doesn't renew it while it's still valid. The script refuses a token with less than 15 minutes left. Wait for it to expire, refresh it, then deploy.
- **Account id.** It comes from `CLOUDFLARE_ACCOUNT_ID`, or else from that same `old/v1/.env`. Only that line is read. `TSV_CF_ENV` overrides the file.

## The API (everything else, on the box)

| Piece | Where |
|---|---|
| IIS site | `tshepovet`, binding `https/*:443:tshepovet.madproducts.ai` (SNI), `*.madproducts.ai` Let's Encrypt certificate, no `:80` binding, folder `D:\sites\tshepovet` (only [`deploy/app/web.config`](app/web.config), proxy-only via ARR) |
| API | Windows service `tshepovet-api` (WinSW), `NT SERVICE\tshepovet-api`, `127.0.0.1:9131`. It runs `D:\releases\tshepovet\<stamp>-<sha>\dist\server.js`. Config `C:\madproducts\services\tshepovet-api\tshepovet-api.xml`, logs `D:\madproducts-data\tshepovet\api\logs` |
| Webhook dispatcher | service `tshepovet-webhooks` (WinSW), `NT SERVICE\tshepovet-webhooks`, no port. It runs `dist\workers\webhookDispatcher.js`. Logs `D:\madproducts-data\tshepovet\webhooks\logs` |
| Retention purge | scheduled task `MADProducts tshepovet retention purge`, hourly at :17, SYSTEM. It runs `dist\workers\retentionPurge.js` from the live release. Log `D:\madproducts-data\tshepovet\purge\purge.log` |
| Database | PostgreSQL 18 service `postgresql-x64-18` (multisciple-new's instance), database `tshepovet`. Logins: `tshepovet_owner` runs migrations (BYPASSRLS, not superuser); `tshepovet_api` is the API, in `tshepovet_app`, under RLS; `tshepovet_jobs` runs the dispatcher and purge (BYPASSRLS, in `tshepovet_worker`). The test database `tshepovet_test` has its own `tshepovet_test_owner` and `tshepovet_test_api`. A delimited `pg_hba.conf` block keeps every one of them out of all other databases |
| Redis | service `tshepovet-redis` (WinSW), `NT SERVICE\tshepovet-redis`, `127.0.0.1:6391`, Redis 8.10.2. It uses its own hash-checked copy of the binaries in `C:\madproducts\bin\tshepovet-redis-8.10.2`, with a password and no persistence (cache, locks, rate limits). Data in `D:\madproducts-data\tshepovet\redis` |
| Secrets | `C:\ProgramData\MADProducts\tshepovet\secrets.env` (Administrators and SYSTEM only): database and Redis passwords, plus `TSV_KEK_KEYS`, `TSV_BLIND_INDEX_ROOT_KEY` and `TSV_API_KEY_PEPPER`. **Never regenerate the last three:** data encrypted or blind-indexed under them would become unreadable. The sandbox tenant's keys are in `sandbox-tenant.json` next to it. The service XML files carry the connection strings; only Administrators, SYSTEM and that service's account can read each one |

PostgreSQL admin work runs as `postgres` over SSPI: `pg_ident.conf` maps the Windows `Administrator` to `postgres`, so no superuser password exists on disk.

### Commands (elevated Windows PowerShell 5.1)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\app\install-box.ps1             # box setup; safe to re-run
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\app\deploy-app.ps1              # deploy
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\app\deploy-app.ps1 -Rollback    # previous release
```

`deploy-app.ps1` runs these steps in order. Nothing live changes before step 6.

1. **Clean tree.** It refuses uncommitted changes.
2. **Gates.** Typecheck, then the **full** 82-test suite against `tshepovet_test` and Redis db 15, as the test logins.
3. **Build and stage.** It builds, then stages `D:\releases\tshepovet\<stamp>-<sha>`. Production `node_modules` is copied from the live release when `package-lock.json` is unchanged, and `npm ci --omit=dev` runs otherwise.
4. **Migrate.** Forward-only migrations, as `tshepovet_owner`.
5. **Seed (`-SeedSandbox`, once).** The sandbox tenant.
6. **Switch.** Both services move to the new release. If `/healthz` isn't up within 60 seconds, both go back.
7. **Through Cloudflare.** It checks `https://tshepovet.madproducts.ai/healthz`, then runs `tests/smoke/api.smoke.ts` there, including a real sandbox company check with the sandbox key.
8. **Prune.** It keeps the newest three releases.

`-SkipTests` skips step 2. `-SkipEdgeCheck` skips step 7.

Migrations are forward-only. A rollback runs the older code against the newer schema.

### Checks

```powershell
curl.exe -s https://tshepovet.madproducts.ai/healthz                          # {"ok":true}, through Cloudflare
curl.exe -s --resolve tshepovet.madproducts.ai:443:127.0.0.1 https://tshepovet.madproducts.ai/healthz   # at the origin
curl.exe -s http://127.0.0.1:9131/healthz                                     # the service itself
Get-Service tshepovet-api, tshepovet-webhooks, tshepovet-redis
```

From the repo, a sandbox call:
- **Bash:** `curl -s https://tshepovet.madproducts.ai/v1/verify/company -H "Authorization: Bearer <tv_test_ key>" -H "Idempotency-Key: <8+ chars>" -H 'Content-Type: application/json' -d @body.json`.
- **PowerShell 5.1:** it strips the quotes from inline JSON, so always put the body in a file.

## Cutover (2026-11-16, one time)

Until then the docs Worker held the host as a **custom domain**, which takes the whole host. The cutover had three steps:

1. Run `install-box.ps1`, then `deploy-app.ps1 -SeedSandbox -SkipEdgeCheck`. The API was up at the origin and still unreachable through Cloudflare.
2. Detach the Worker's custom domain: `DELETE /accounts/:account/workers/domains/:id`. That also deletes the custom domain's own DNS record, so the host falls back to the zone's proxied `*.madproducts.ai` A record, which points at this box. No DNS record was created or edited by hand.
3. `npm run deploy`, which put the Worker on the `/docs*` and `/robots.txt` routes. Then `deploy-app.ps1 -SkipTests` ran the checks through Cloudflare.

## Quirks worth knowing

- **Run wrangler and the box scripts from PowerShell.** Wrangler hangs from Git Bash.
  - Run each box script in its own `powershell -File` process.
  - In PowerShell 5.1, a native command's redirected stderr becomes an error record, and `Stop` turns that into a throw. The helpers in `TsvBox.psm1` therefore take the program and its arguments, not a scriptblock: a caller's scriptblock runs under the caller's `Stop`.
- **Never give this host a Workers custom domain.**
  - It would hide the API: a custom domain takes the whole host.
  - When wrangler 4 has no terminal (as `deploy.mjs` runs it), it attaches a custom domain over an existing DNS record of the same name *without asking*: `publishCustomDomains` sets `override_existing_dns_record` and `override_existing_origin`.
  - The route pre-flight in `tools/deploy.mjs` refuses to deploy while a custom domain is on the host.
- **The zone injects two scripts into every HTML page**, so only the live smoke run sees them; `wrangler dev` never does.
  - **Cloudflare Web Analytics** (`static.cloudflareinsights.com`, reporting to `cloudflareinsights.com`). The docs CSP allows both; the owner chose this on 2026-11-16, as Mia's Crowns does.
  - **The bot "JavaScript detections" inline script.** It carries a per-request ray id, so no CSP hash can allow it, and the CSP blocks it. The docs smoke suite tolerates exactly that violation, recognised by the sample that `'report-sample'` provides.
- **`_headers` joins repeated headers.** When two rules set the same header, Cloudflare joins the values. So `Cache-Control` is set per page and on `/docs/assets/*`, never on `/*`.
- **This Windows Redis build is msys.** It reads an argument like `D:/x/redis.conf` as a path *under the working directory*. The service passes `redis.conf` relative to the working directory instead. The `dir` directive inside the file accepts `D:/...`.
- **The Redis binaries are copied, not shared.** multisciple-new's `C:\madproducts\bin\redis-8.10.2` admits only its own service account, and its install script rejects any extra permission. So TshepoVet keeps its own hash-checked copy.
- **The npm installs are slow.** On this box `npm ci` took 13 minutes. `@playwright/test` is pinned to 1.63.0 because its Chromium (build 1243) is already in `%LOCALAPPDATA%\ms-playwright`, shared with Mia's Crowns.
- **`pg_hba.conf` is shared with multisciple-new.**
  - `install-box.ps1` keeps its rules between `# >>> tshepovet` and `# <<< tshepovet`, ahead of the catch-all `host all all` rule.
  - Before reloading, it backs the file up and checks `pg_hba_file_rules`; if that view reports an error, it restores the backup and doesn't reload.

## Not done yet (phase 2)

- **Authenticated Origin Pulls**, as multisciple-new has. Until then the origin also answers requests that bypass Cloudflare. Every API call still needs an API key.
- **Nightly encrypted database backups**, and a certificate-check task. win-acme already renews the wildcard and rebinds it.
- **Production.** It needs af-south-1 hosting, real bureau adapters, KMS instead of `LocalKeyProvider`, a SARS TCS channel, and legal review.

## Deploy history

| Date (UTC) | Part | Build | Version | Notes |
|---|---|---|---|---|
| 2026-11-16 16:06 | docs | `cacb9cd` | `040de47a-5148-4c86-bdf2-7c08541c4c73` | First deploy, on a custom domain covering the whole host. A person checked DNS: only the `*.madproducts.ai` wildcard, no `tshepovet` record. The smoke gate failed: the CSP blocked the zone's Web Analytics beacon. |
| 2026-11-16 16:17 | docs | `19e6049` | `fdc86957-11c3-4513-a34a-319dc02476ad` | The CSP allows Web Analytics. 12/12 smoke tests passed live. |

## What the docs build does (tools/build-site.mjs)

The pages in `docs/pages/` are also the source of the private claude.ai copies, so they keep their claude.ai links and mermaid source. The build adapts a copy of each page:

- **Paths.** `readme.html` becomes `/docs/`, and the other pages get clean paths (`/docs/database-schema`). Cloudflare redirects `*.html` to the clean path. `deploy/site/static/404.html` answers any unknown `/docs` path, with status 404.
- **Links.** Links to the claude.ai pages become root-relative `/docs/...` paths. The build fails on any link outside `/docs/`, because the API answers those.
- **Diagrams.** Mermaid diagrams are rendered to inline SVG in headless Chromium, inside the page's own CSS with its Google Fonts loaded.
  - The build stops if the fonts don't load.
  - ER diagrams get `direction LR`.
  - No diagram shrinks below 70% of its natural size.
  - Diagrams sit on a light canvas in dark mode.
- **Scripts.** Inline scripts move to content-hashed `/docs/assets/*.js` files, so `script-src` is `'self' 'report-sample'` plus Web Analytics, with no `'unsafe-inline'`.
- **Stamps.** Each page gets `<meta name="build-id">` (the git SHA, with `-dirty` if the tree isn't clean) and a robots meta tag.
- **Validation.** It fails on any claude.ai URL left, a diagram not rendered, an inline script or `on*` handler, a script or stylesheet the CSP would block, or an internal link or `#fragment` with no target.
