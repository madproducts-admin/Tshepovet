# Docs site deploy: tshepovet.madproducts.ai

The five design pages in `docs/pages/` are published as a static site at
**https://tshepovet.madproducts.ai**, with the same pattern as Mia's Crowns
(miascrowns.com): one Cloudflare Worker serving static files through `[assets]`,
attached to its host as a custom domain. Only the docs ship. The API is not
deployed: its bureau adapters are placeholders and there is no lawful SARS TCS
channel yet, and it needs PostgreSQL 16 + Redis, which do not fit a Worker.

The site is public but kept out of search engines: every response carries
`X-Robots-Tag: noindex, nofollow`, every page has a robots meta tag, and
`robots.txt` disallows everything. (With `Disallow: /` compliant crawlers never
fetch the pages, so they never read the noindex either. A page linked from
elsewhere can still be listed as a bare URL, without its content.)

| | |
|---|---|
| Worker | `tshepovet-site` (assets only: no `main`, no bindings, no crons) |
| Host | `tshepovet.madproducts.ai`, custom domain on the `madproducts.ai` zone |
| Account | the Cloudflare account that holds the `madproducts.ai` zone and Mia's Crowns (`mias-crowns-site`) |
| Config | [`deploy/site/wrangler.toml`](site/wrangler.toml) |
| Page map, CSP origins | [`tools/lib/site.json`](../tools/lib/site.json) |

## Commands

```bash
npm run site:build         # build/site/ + deploy/dist/ (with _headers)
npm run site:smoke:local   # smoke suite against `wrangler dev` on deploy/dist
npm run deploy:dry         # gates + build + checks, stops before wrangler
npm run deploy             # the real thing (see below)
npm run site:smoke         # smoke suite against the live site
```

`npm run deploy` (tools/deploy.mjs), in order:

0. The working tree must be clean: the deploy builds the working tree, not HEAD.
   Cloudflare credentials must be usable, and the custom-domain pre-flight must pass.
1. `npm run typecheck`, plus `npm run test:unit:no-services` (52 of the 82 tests:
   the ones that need no Redis or PostgreSQL). The waterfall and integration
   tests run in GitHub CI, which has both.
2. `tools/build-site.mjs` builds `build/site/` (see "What the build does").
3. `tools/assemble-deploy.mjs` copies it to `deploy/dist/` and writes `_headers`.
4. `npx wrangler@4 deploy` from `deploy/site/`.
5. It polls `https://tshepovet.madproducts.ai/?cb=…` until the
   `<meta name="build-id">` is the new build (the git SHA). The edge takes a
   few seconds to switch.
6. It runs the Playwright smoke suite (`tests/smoke/`) against the live URL.

It prints the Worker version id at the end. If the smoke suite fails, the
deploy is already live, and the script prints what to do.

**Rollback:** `cd deploy/site && npx wrangler@4 rollback --name tshepovet-site`.
Before the second deploy there is nothing to roll back to. To take the site
down then, `npx wrangler@4 delete --name tshepovet-site` removes the Worker and
its custom domain. Ask the owner first.

## Credentials (this machine)

- **Token.** Use wrangler's OAuth login. The `CLOUDFLARE_API_TOKEN` in Mia's
  Crowns' `old/v1/.env` is dead. With `CLOUDFLARE_API_TOKEN` unset, run any
  wrangler command (`npx wrangler@4 whoami`) to refresh the login. The deploy
  script then reads `oauth_token` from
  `%APPDATA%\xdg.config\.wrangler\config\default.toml` itself and never prints it.
- **Expiry.** The token lasts an hour, and running wrangler does not renew it
  while it is still valid. The script refuses a token with less than 15 minutes
  left. Wait for it to expire, refresh it, then deploy.
- **Account id.** It comes from `CLOUDFLARE_ACCOUNT_ID`, else from the same
  `old/v1/.env`. Only that line is read. Override the file with `TSV_CF_ENV`.

## Quirks worth knowing

- **Run wrangler from PowerShell.** From Git Bash it hangs.
- **DNS records get replaced without a prompt.** When stdout is not a
  terminal, wrangler 4 attaches a custom domain over an existing DNS record of
  the same name, silently. `publishCustomDomains` sets
  `override_existing_dns_record` and `override_existing_origin` in that case,
  and `tools/deploy.mjs` runs it without a terminal.
  - The deploy script therefore runs a read-only pre-flight first. If the host
    is already this Worker's custom domain, it carries on. If another Worker
    owns it, it stops.
  - On the first attach, it needs proof that the host has no DNS record of its
    own. wrangler's OAuth token cannot read DNS (403), so a person checks
    DNS > Records in the dashboard. If there's no record, run the deploy with
    `TSV_DNS_CHECKED=tshepovet.madproducts.ai`.
  - The zone's proxied `*.madproducts.ai` wildcard is a different record and is
    not touched. Through that wildcard the host answered Cloudflare 526 before
    the first deploy.
- **The zone injects Cloudflare Web Analytics.** `madproducts.ai` has Web
  Analytics on, so every HTML page gets the beacon
  `https://static.cloudflareinsights.com/beacon.min.js/…`, which reports to
  `https://cloudflareinsights.com`.
  - The CSP allows both origins (`script-src` and `connect-src`), as Mia's
    Crowns' CSP does. The owner chose this on 2026-11-16 after the first
    deploy's smoke gate failed on the blocked beacon.
  - The origins live in `tools/lib/site.json` under `csp`. The smoke suite
    checks the live header against that file.
  - The beacon is injected at the edge, so it never appears in `build/site`
    or under `wrangler dev`.
- **The zone injects Cloudflare's bot "JavaScript detections".** They arrive
  as an inline `<script>` with a per-request ray id, so no CSP hash can allow
  them, and `script-src 'self'` blocks them. The site loses a bot signal and
  nothing else. The smoke suite tolerates exactly that violation, recognised by
  the sample that `'report-sample'` provides, and fails on any other.
- **`_headers` joins repeated headers.** When two rules set the same header,
  Cloudflare joins the values, so `Cache-Control` is set per page and on
  `/assets/*`, never on `/*`.
- **The npm installs are slow.** On this box `npm ci` took 13 minutes.
  `@playwright/test` is pinned to 1.63.0 because its Chromium (build 1243) is
  already in `%LOCALAPPDATA%\ms-playwright`, shared with Mia's Crowns. A newer
  version would download another browser.

## Deploy history

| Date (UTC) | Build | Worker version | Notes |
|---|---|---|---|
| 2026-11-16 16:06 | `cacb9cd` | `040de47a-5148-4c86-bdf2-7c08541c4c73` | First deploy. A person checked DNS (`TSV_DNS_CHECKED`): only the `*.madproducts.ai` wildcard, no `tshepovet` record. The live site, headers and TLS checked out, but the smoke gate failed: the CSP blocked the zone-injected Web Analytics beacon. |
| 2026-11-16 16:17 | `19e6049` | `fdc86957-11c3-4513-a34a-319dc02476ad` | The CSP allows Cloudflare Web Analytics. The smoke suite passed 12/12 against the live site, TLS included. |

## What the build does (tools/build-site.mjs)

The pages in `docs/pages/` are also the source of the private claude.ai copies,
so they keep their claude.ai links and mermaid source. The build adapts a copy
of each page:

- **Paths.** `readme.html` becomes `/`, and the other pages get clean paths
  (`/database-schema`). Cloudflare redirects `*.html` to the clean path.
  `deploy/site/static/404.html` is served with status 404 for any unknown path.
- **Links.** Links to the claude.ai pages become root-relative paths. They are
  root-relative because the 404 page is served at any depth.
- **Diagrams.** Mermaid diagrams are rendered to inline SVG in headless
  Chromium, inside the page's own CSS with its Google Fonts loaded, so labels
  are measured as they will be shown.
  - The build stops if the fonts don't load. `TSV_ALLOW_FALLBACK_FONTS=1` is
    for an offline look only.
  - ER diagrams get `direction LR`. Top-to-bottom put the schema's 28
    relationships in a single 5,600px row.
  - No diagram shrinks below 70% of its natural size. Wider ones scroll inside
    their frame.
  - The SVGs use one light palette and sit on a light canvas in dark mode too.
- **Scripts.** Inline scripts move to content-hashed `/assets/*.js` files, so
  the CSP is `script-src 'self' 'report-sample'` plus Cloudflare Web Analytics
  (see the quirks), with no `'unsafe-inline'` and no hashes. Styles keep `'unsafe-inline'`: the pages carry their CSS in
  `<style>`, and the SVGs use style attributes.
- **Stamps.** Each page gets `<meta name="build-id">` (the git SHA, with
  `-dirty` if the tree is not clean) and a robots meta tag.
- **Validation.** It fails on any claude.ai URL left, a diagram not rendered,
  an inline script or `on*` handler, a script or stylesheet the CSP would
  block, or an internal link or `#fragment` with no target.
