# TshepoVet: master plan for the complete application

Owner decisions, 2026-11-16:

- **Scope:** build the whole product described in `docs/01`–`docs/05` and ship it once. That covers the buyer portal, public passports, supplier self-service, the staff console, monitoring and the WhatsApp worker.
- **Stack:** **Next.js** (web) + **NestJS** (API). It does not follow the madproducts.ai fleet look; it must be **"AAA grade"**.
- **Accounts:** TshepoVet's own email + password accounts, not fleet sign-on.
- **Integrations:** none are contracted yet. Build on the deterministic mock bureau and a sandbox stand-in for every external service. Each real integration plugs in later.
- **Hosting:** still the sandbox on the MADPRODUCTS box (2026-11-16). There is no real personal data until the app is hosted in South Africa (af-south-1) and the legal review is done.
- **URL layout:** https://tshepovet.madproducts.ai is the application. `/docs` stays on the Cloudflare Worker (`deploy/README.md`).

## 1. "AAA grade": the bars every screen and endpoint must meet

| Area | Bar | How it is checked |
|---|---|---|
| Accessibility | WCAG 2.2 **AAA** where the criteria apply to an app: 7:1 text contrast, 4.5:1 large text, no timing limits (except session expiry, with warning and extension), focus always visible and unobscured, 44px targets, reading level kept plain, help on every form. Everything else AA. | `@axe-core/playwright` with the AAA ruleset on every route; a keyboard-only Playwright pass of every flow; screen-reader landmarks and live regions reviewed |
| Design | A distinctive, consistent design system: tokens, type scale, density, motion and states (empty, loading, error, success) for every component. Dark mode, `prefers-reduced-motion`, 360px to 1920px. Brand continuity with the docs: Archivo for display, IBM Plex Sans and Mono, the ink and accent palette. | Component catalogue page; visual review of every route at three widths, both themes |
| Performance | Lighthouse ≥ 95 on public pages. Portal routes: first load JS ≤ 180 KB gzip, INP < 200 ms, CLS < 0.05. API p95 < 300 ms for reads (sandbox). | Lighthouse CI in the smoke suite; bundle analyzer budget check in the build |
| Security | argon2id passwords, TOTP MFA (required for owner and admin roles), lockout, httpOnly session cookies with CSRF protection, strict nonce-based CSP, RLS on every tenant table, RBAC from the role matrix, an audit-chain entry for every security event, no PII in logs, secrets only in the box's secrets file. | Unit and e2e tests per rule; a security review pass before ship (§7, M9) |
| Reliability | Durable jobs (BullMQ on Redis with AOF), idempotent handlers, a watchdog for stalled jobs, health and readiness endpoints, zero-downtime deploys with automatic rollback. | Integration tests; deploy script checks; the live smoke suites |
| Quality | TypeScript strict everywhere. Every module has unit tests, every endpoint e2e tests, every flow Playwright tests. The existing 82 tests keep passing. | CI and the deploy gate run all of it |

## 2. What exists today

**Built and live (sandbox):**
- **API:** `POST /v1/verify/company`, `POST /v1/verify/driver-license` and `GET /v1/verifications/{id}`, Express with API-key auth. The waterfall engine, mock bureau, tiered encrypted cache, wallet and ledger, consent recording, audit hash chain, idempotency and rate limits sit behind them.
- **Workers:** the webhook outbox dispatcher and the retention purge.
- **Schema:** all 56 tables.

**Code but not wired:**
- **WhatsApp:** the webhook receiver, the pure state machine, the Graph client and the conversation worker class. There is no process entry point and no Meta account.
- **OCR:** the extractor (Claude) and the deterministic post-validation.

**Missing entirely:**
- any user interface;
- user sign-in;
- the API behind most tables: vendors, passports, monitoring, top-ups, data-subject requests, the conflict-of-interest radar, B-BBEE;
- the monitoring scheduler;
- a durable queue;
- the staff tooling.

## 3. Architecture

```
apps/
  api/        NestJS 11 (Express adapter): /v1 (API keys), /api (portal sessions), /webhooks, /healthz, /readyz
  worker/     the same Nest code base, a worker entry point: BullMQ processors and repeatable jobs
  web/        Next.js (App Router, React 19, TypeScript strict), standalone output
packages/
  core/       today's src/ domain code, moved: sa-domain, waterfall, providers, cache, billing, consent,
              crypto, ocr, whatsapp state machine, webhooks signing (framework-free, unit-tested)
  contracts/  zod schemas shared by api and web; the OpenAPI 3.1 documents are generated from them
db/migrations/ 0001, 0002 unchanged; 0003+ add what the new features need (§5)
```

- **Workspaces:** npm workspaces with one lockfile. The existing tests move with the code they test.
- **The `/v1` API contract stays byte-compatible.** The current OpenAPI document is the regression oracle, and the 82 tests are ported first, before any feature work (M1).
- **The portal API (`/api/*`)** uses session cookies (Redis-backed, rolling 12 h, absolute 7 days) and a CSRF header. Every request runs in a transaction with `SET LOCAL app.tenant_id`, so RLS holds for portal users as it does for API keys.
- **The web app** talks to `/api` only, through typed clients generated from `packages/contracts`.
  - Server components for data-heavy pages, with streaming and Suspense.
  - The strict CSP gets its nonce from middleware.
  - Fonts are self-hosted via `next/font`, so no Google Fonts at runtime.
- **Jobs (BullMQ, queues `tv:*` on `tshepovet-redis`, AOF on):**
  - `verification` (async completion past the sync deadline, replacing in-process work);
  - `webhooks` (dispatcher);
  - `monitoring` (expiry reminders T-30/T-14/T-7, weekly re-checks, re-check before each payment run, the ERP lock webhook);
  - `whatsapp` (conversation worker, from the Redis stream);
  - `ocr`;
  - `email` (outbox sender);
  - `purge` (hourly; replaces the scheduled task);
  - `coi` (conflict-of-interest radar);
  - `bbbee` (scorecard).
  - A watchdog re-queues stalled jobs on start and every five minutes.
- **On the box:**
  - WinSW services: `tshepovet-api` (127.0.0.1:9131), `tshepovet-web` (127.0.0.1:9132) and `tshepovet-worker` (replacing `tshepovet-webhooks` and the purge task).
  - IIS routes `/v1`, `/api`, `/webhooks`, `/healthz` and `/readyz` to the API, and everything else to the web app.
  - `/docs*` and `/robots.txt` stay on the Worker.
  - The deploy script grows to build all three and switch them together, with rollback.

## 4. The product surface

**Public (anonymous)**
- `/`: the landing page. What TshepoVet does, how a check works, pricing from the price book, security and POPIA, a link to the docs, sign-up. A sandbox banner shows on every page while the environment is sandbox.
- `/pricing`, `/security`, `/legal/*` (privacy notice, terms, PAIA manual placeholder).
- `/passport/{token}`: the public **Verified Vendor Passport**.
  - It shows verification status badges and minimised verified facts: registration and status, active directors as initials only, VAT, TCS status (never the PIN), B-BBEE level and expiries.
  - It shows the "as of" dates, a QR code, and a server-side signature check.
  - The vendor controls what is shared. A revoked token gives 410.
- `/verify-passport`: scan or enter a code to confirm that a printed passport is genuine.

**Accounts**
- Sign-up creates the tenant, its wallet and the owner user, then sends an email verification.
- Sign-in has lockout after repeated failures and TOTP MFA; owners and admins must enrol.
- Password reset, team invitations with a role, a sessions list with "sign out elsewhere", and account deletion requests (feeding the DSR flow).

**Buyer portal (`/app`)**, gated by role as in `docs/03` §3.1:
- **Overview:** checks this month, verified rate, expiries due, the monitoring alerts, wallet balance, recent activity.
- **Suppliers:**
  - The list has search, filters and saved views, a status column and bulk invite.
  - The supplier record covers passport status, checks history with per-check results and warnings, directors, beneficial owners, bank accounts (masked), B-BBEE profile, credentials, documents, monitoring and the audit trail.
  - Add a supplier by registration number, or by an invite link (web onboarding or WhatsApp).
- **Run a check:** company, live refresh or driver/PrDP.
  - The form captures consent per `docs/03` §3.3A and shows the price and the wallet balance up front.
  - The result streams in; the async case shows progress and lands without a page reload.
- **Monitoring:** enrolments, an expiry calendar, alerts, and the ERP lock state per supplier.
- **Modules:** B-BBEE spend and scorecard calculator; the conflict-of-interest and ghost-supplier radar (needs the s57 note, §8); industry add-ons.
- **Wallet:**
  - the balance, active holds and the ledger with filters and export;
  - top-ups through the **sandbox payment stand-in**, credited at once and clearly marked as sandbox; the real provider via the Cloud gateway comes later;
  - invoices (PDF).
- **Developers:**
  - API keys (create live or test, see once, revoke, last used);
  - webhook endpoints (create, rotate the signing secret, delivery log, replay);
  - an interactive sandbox console with the magic values.
- **Team:** users, roles, invitations and MFA status.
- **Compliance:** consent records, privacy notices, data-subject requests (30-day clock), and the audit log viewer with the "verify chain" action.
- **Settings:** organisation profile, modules and plan, notification preferences.

**Supplier experience**
- **Web onboarding** (`/onboard/{invite}`): the same states as the WhatsApp flow (`docs/04` §4.2).
  - It covers consent, entity type, registration-number lookup and confirmation, ID document upload, B-BBEE, the TCS PIN on a secure single-use page, review and submit.
  - Upload goes through the OCR stand-in (§6) and post-validation.
  - It works on a phone, at AAA.
- **Supplier self-service** (`/vendor`, magic link to a verified contact email or mobile): my passport, who it is shared with (grant or revoke), corrections and data-subject requests, consent withdrawal, documents.
- **WhatsApp:** the conversation worker is wired to the Redis stream, and the Graph client gets a sandbox stand-in.

**Staff console (`/staff`, separate staff accounts, MFA required)**
- **Review queue:** OCR `needs_review`, human handoffs, possible fraud signals such as a pHash match.
- **Platform records:** tenants and users (suspend, unlock, support view audited as a staff action), DSR queue, purge runs, and the audit-chain verification per tenant.
- **Bureau operations:** provider health and circuit states, waterfall and capability config, and the price book.
- **The WhatsApp simulator:** a phone-style UI that drives the real bot in sandbox.
- **Mail outbox:** the sandbox's sent mail, since there is no external mail yet.

## 5. Data model additions (migration 0003 onward, same RLS discipline)

- **`tenant_users`:** adds `email` (citext, unique), `password_hash` (argon2id), `email_verified_at`, `mfa_secret_enc` (envelope-encrypted), `mfa_enrolled_at`, `failed_logins`, `locked_until` and `last_login_at`.
- **New tables:** `staff_users` (same columns, no tenant); `auth_tokens` (email verify, reset, invite and magic link: hashed, single-use, expiring); `user_recovery_codes`; `email_outbox`; `passport_public_tokens` (signed, revocable, scoped field set) if `vendor_passport_shares` cannot carry it; `jobs_audit` if BullMQ's own records are not enough.
- **Retention:** every new table gets an entry, and `run_retention_purge()` is extended for it.

## 6. Sandbox stand-ins (each behind an interface the real integration implements)

| Real service | Sandbox stand-in |
|---|---|
| Bureaus (XDS, CPB, SearchWorks, VerifyID) | the existing deterministic `MockProvider` with the magic values; NODE_ENV stays production, and live keys stay inert until a real adapter exists |
| Meta WhatsApp Cloud API | `SandboxGraphClient`: records outgoing messages, which the staff simulator shows and answers |
| OCR (Claude) | `SandboxExtractor`: deterministic results from fixture documents, through the same `postValidate`. The real extractor goes through the fleet Cloud AI gateway, never an `ANTHROPIC_API_KEY` on the box (fleet rule) |
| Payments (top-ups) | `SandboxPayments`: credits the wallet through the same ledger path, flagged sandbox. The real provider is via the Cloud billing gateway |
| Email | `email_outbox` table + the staff mail viewer. Real delivery comes later, via the Cloud mail gateway or SMTP |
| SARS TCS channel | the mock's TCS capability with the magic PIN prefixes (`docs/03` §3.8 decides the real channel) |
| Xero / Sage | the ERP-lock webhook to the buyer's own endpoint only; connectors later |
| S3 + KMS | documents encrypted on disk under `D:\madproducts-data\tshepovet\documents`, with keys from `LocalKeyProvider` |

## 7. Milestones (internal: nothing ships until M10)

| # | Milestone | Done when |
|---|---|---|
| M1 | Monorepo + NestJS port of the API | `/v1` behaves identically, all 82 existing tests pass under Nest, the OpenAPI diff is empty, and the worker entry point runs the dispatcher and purge |
| M2 | Auth and tenancy | sign-up, verify, sign-in, MFA, reset, lockout, invites, sessions, RBAC guard, staff accounts; e2e tests for each, including the lockout and enumeration-safe responses |
| M3 | Portal API | every `/api` module from §4 with contracts, RLS and RBAC; e2e tests; OpenAPI for `/api` |
| M4 | Design system + web shell | tokens, the type scale, about 30 accessible components (Radix primitives), layout, navigation, themes, the catalogue page; axe AAA passes on the catalogue |
| M5 | Buyer portal UI | every portal screen in §4, with Playwright flows and axe AAA on each |
| M6 | Supplier experience + public passport | web onboarding, self-service, the passport page and QR, verify-passport; flows and axe tests |
| M7 | Jobs | BullMQ queues and watchdog, async verifications, monitoring scheduler, WhatsApp worker + sandbox Graph client, the OCR and email stand-ins; integration tests |
| M8 | Staff console | every staff screen in §4, including the WhatsApp simulator; flows and axe tests |
| M9 | Hardening | security review (auth, CSRF, CSP, RLS, IDOR, injection, upload handling), accessibility audit, performance budgets, load test of the check path, docs updated |
| M10 | Ship | box: Redis AOF, the `tshepovet-web` and `tshepovet-worker` services, IIS routing, deploy script for all three with rollback. Live: all smoke suites pass, Lighthouse and axe pass, and the owner looks at it |

**Carried into M10 from M1.** `deploy/app/deploy-app.ps1` still stages the single-package layout, so it refuses to run on this branch. It needs:
- **Staging:** copy each workspace's `package.json` and `dist/` and run `npm ci --omit=dev`. When reusing the previous release's `node_modules`, skip the `@tshepovet/*` junctions (`robocopy /XJD`) and re-link them to the new release, or the old release's code would ship.
- **Services:** `tshepovet-api` runs `apps\api\dist\main.js`. A new `tshepovet-worker` runs `apps\api\dist\worker.js` and replaces both `tshepovet-webhooks` (stop, then uninstall) and the hourly purge task (unregister; `run-purge.ps1` goes).
- **Gates:** `deploy\app\run-tests.ps1` (the full suite on the box) instead of the inline test environment.

**Carried into M10 from M3.**
- **Environment:** the box's API and worker need `SANDBOX=true` (portal checks answered by the mock bureau but priced against the wallet, sandbox top-ups, no live keys) and `WEBHOOK_DENY_IPS=209.58.145.5` (the box's own public address, on top of every private and reserved range the webhook guard already refuses). `COI_RADAR_ENABLED` stays unset until the s57 assessment (§8).
- **Migration 0004** (`db/migrations/0004_portal.sql`) runs with the release.

**M3 decisions (the portal API).**
- **One route table.** `packages/contracts/src/api/routes.ts` lists every `/api` route with its permission and zod request/response schemas. It generates the OpenAPI 3.1 document (served at `/api/openapi.json`), and a test checks it against the routes and `@RequirePermission` the controllers actually register, both ways. That test found two check endpoints with no permission before they shipped.
- **Strict responses.** The integration tests parse every response with its strict schema, so an undeclared field (an internal id, an encrypted column) fails a test instead of reaching a browser.
- **Portal checks** reuse the `/v1` services with the user as requester (`verifications.requested_by_user`, consent `captured_by_user`, capture method `web_checkbox` against the web-channel notices).
- **Webhook targets** must be https on the public internet: checked when an endpoint is saved and again at connect time, against the address actually dialled (DNS rebinding). Signing secrets rotate with a 24-hour overlap (two `v1=` signatures).
- **Type parsing:** `date` columns stay `YYYY-MM-DD` strings and `bigint` becomes a number (range-checked), for every pool.
- **Still to come:** invoice PDFs (M5 with the wallet screens), the conflict-of-interest radar's import and matching (M7, behind the flag), a general per-session rate limit on `/api` (M9).

**M6 decisions (the supplier's side).**
- **Trust boundary.** Anyone can sign up as a buyer, add any company and invite an address they control. So what an invitation's onboarding enters (contact, documents, bank account, B-BBEE profile) belongs to the inviting buyer only (`tenant_id` set) and is invisible to other buyers. It becomes the supplier's shared record (`tenant_id` NULL), which can publish the passport and sign in to self-service, only through `onboarding_promote()` at submit, and only when the identity document matched an active director on the register. The API role cannot write shared rows at all (split RLS policies in migration 0005). A security review of the first M6 commit found the gap; a test now plays the second buyer.
- **One bank account per onboarding,** and every step re-checks under the invitation's row lock that it was not already submitted (the tax step calls a bureau outside the lock).
- **Migration 0005** runs with the release (M10).
- **Passports:** `/passport/{id}` is rendered by the web server from the API (never indexed; the supplier shares the link). Withdrawn, the API answers 410 and the page says so with a 200 (the App Router has no 410 for pages). A paper copy carries a QR code to the page and a signed code that `/verify-passport` checks. Only staff lift a suspension (`vendor_set_passport` refuses a suspended passport).
- **Carried into M10:** the web service needs `TSV_PUBLIC_ORIGIN=https://tshepovet.madproducts.ai` (the passport QR code), and IIS must send `/` to the web app now that it is the landing page (the docs-only deploy redirected `/` to `/docs`).
- **Before live mode (not the sandbox):** a matched ID document is weak proof of being a director, since a photo of someone else's card would pass. Promotion in live mode needs a liveness or selfie match against the ID (or a DHA check) as well; until then the sandbox is the only mode, and its sample documents make the director path available to anyone by design.

## 8. Blocked on the owner (none of it stops the build)

- **Bureau and payment contracts:** bureau contracts and credentials (XDS, CPB, SearchWorks, VerifyID), and confirmation of which bureaus offer TCS and eNaTIS; a payment provider for top-ups (the fleet default is Paddle via Cloud).
- **Messaging and accounting:** a Meta WhatsApp Business account and number; the SARS TCS fulfilment channel (`docs/03` §3.8); the Xero and Sage apps.
- **Production readiness:** hosting in South Africa (af-south-1), and the legal review of the privacy notice, the roles matrix and the s57 assessment of the conflict-of-interest radar (the radar ships behind a feature flag, off until then).
- **Email sending:** how mail should be sent (Cloud mail gateway or an SMTP account).

## 9. Risks

- **Size.** This is the largest piece of work in the repository. The milestones keep it reviewable: each one is its own commit series with its own tests.
- **Box resources.** Two more Node services on a shared, contended box. Each gets memory limits (`--max-old-space-size`), and the worker's concurrency is capped.
- **Next.js on Windows behind IIS.** The standalone output runs as a plain Node service; ARR proxies it like the API, and IIS serves static assets via `/_next/static` with immutable caching.
