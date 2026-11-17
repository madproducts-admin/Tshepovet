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
- **Changed in M9:** promotion now copies, rather than moves, only what the passport and self-service need, and no buyer reads the shared rows; see the M9 decisions.
- **One bank account per onboarding,** and every step re-checks under the invitation's row lock that it was not already submitted (the tax step calls a bureau outside the lock).
- **Migration 0005** runs with the release (M10).
- **Passports:** `/passport/{id}` is rendered by the web server from the API (never indexed; the supplier shares the link). Withdrawn, the API answers 410 and the page says so with a 200 (the App Router has no 410 for pages). A paper copy carries a QR code to the page and a signed code that `/verify-passport` checks. Only staff lift a suspension (`vendor_set_passport` refuses a suspended passport).
- **Carried into M10:** the web service needs `TSV_PUBLIC_ORIGIN=https://tshepovet.madproducts.ai` (the passport QR code), and IIS must send `/` to the web app now that it is the landing page (the docs-only deploy redirected `/` to `/docs`).
- **Before live mode (not the sandbox):** a matched ID document is weak proof of being a director, since a photo of someone else's card would pass. Promotion in live mode needs a liveness or selfie match against the ID (or a DHA check) as well; until then the sandbox is the only mode, and its sample documents make the director path available to anyone by design.

**M7 decisions (the jobs).** The owner approved the idle query budget on 2026-11-17 (about 2 200 queries a day, all on the box's own PostgreSQL; `packages/core/src/jobs/runtime.ts` lists it).
- **Durable verifications.** Each verification keeps the input it needs to run again (with any tax PIN), encrypted, until it is final (`verifications.resume_enc`), and whoever runs it holds a claim (`claimed_until`). An async check goes to the `verification` queue; a sync check runs in the API and, if it outlasts the sync deadline, gets a delayed backup job. The watchdog (every 5 minutes, and at start) hands on any check still processing two minutes on with no live claim. Finalising locks the row and happens once, so a late second runner cannot double-charge or double-notify. A check that cannot be run (no stored input, or more than three failed worker runs) ends as failed with its hold released.
- **Wake on commit.** Triggers on the webhook and email outboxes `NOTIFY tv_jobs` (delivered only on commit); the worker listens on its own connection and catches up after a reconnect. Webhook retries wake by timer at their due time; a 60-second backstop covers anything missed. In the sandbox, email is marked `sandbox` (held for the staff console), never sent.
- **Monitoring sweep** (every 15 minutes): schedules B-BBEE evidence, documents with an expiry date and the CIPC annual return for monitored suppliers (tax PINs were already scheduled when checked; a new PIN retires the old schedule); reminders at 30, 14 and 7 days (webhook `document.expiring` and an email to the buyer's admins, once per threshold); on the day, `document.expired` and, with the accounting lock on, the payment lock (`vendor.payment_locked`, source `monitoring`); a weekly re-check of each monitored company at no charge (SKU `MONITORING_RECHECK`, R0), reporting a changed outcome as `vendor.compliance_changed`; the monthly monitoring fee per supplier, keyed per month in the ledger so it is charged once; module renewals. A charge the wallet cannot cover is retried each sweep, the admins are emailed once, and after 7 days monitoring of that supplier (or the module) ends.
- **WhatsApp** runs in the sandbox only: the conversation worker on the Redis stream with `SandboxGraphClient` (messages recorded in `wa_sandbox_messages` for the M8 simulator), `SandboxDocumentExtractor` (sample media `sample:<name>`) and documents encrypted on disk (`DOCUMENT_STORE_DIR`). Live WhatsApp waits for document reading through the Cloud gateway (no AI keys on the box) and a Meta account (§8). The watchdog reclaims stream messages a crashed worker never acknowledged.
- **Not in M7, on purpose:** the conflict-of-interest radar's import and matching (behind its flag until the s57 assessment, §8); a re-check before each payment run (there is no payment-run calendar setting yet; the weekly re-check covers it meanwhile); per-document reminder offsets and lock grace days from `ref_document_types` (the sweep uses 30/14/7 and locks on the day); a separate OCR queue (the sandbox extractor is instant, so it runs inside the conversation step).
- **Carried into M10:** migration 0006 runs with the release; the worker service needs `DOCUMENT_STORE_DIR` (and its folder) and runs as `tshepovet_jobs`; `tshepovet-redis` needs `maxmemory-policy noeviction` (BullMQ must never lose a queue key; sessions expire by their own TTL) as well as the AOF already planned; the old `tshepovet-webhooks` service and the hourly purge task go (the worker does both).

**M8 decisions (the staff console).**
- **A separate connection.** Staff work across tenants, so their reads and changes go through `STAFF_DATABASE_URL` (default `WORKER_DATABASE_URL`, the BYPASSRLS jobs login), used only by the staff controllers; the tenant-scoped API role never gains cross-tenant reach. Without it the console answers 503.
- **Roles per route** (support, reviewer, admin) are declared in the route table (`staffRoles`, `x-staff-roles` in OpenAPI) and the parity test compares them with the controllers, as it does portal permissions.
- **Everything a staff member does to a tenant is on the tenant's record:** decisions, suspensions, unlocks, chain checks, and every support view and every mail message read (a message may hold a sign-in link, so its text is shown only in the sandbox, where nothing is delivered; outside it the outbox shows delivery details only), as `tshepovet_staff` actions the tenant sees as "TshepoVet support". Platform changes (prices, bureau capabilities) go to the platform chain.
- **Prices change from a date, never in place:** the current row ends the day before and history is kept; a new price starts today or later.
- **The WhatsApp simulator** (sandbox only) starts a conversation with the invitation the bot would send, puts each staff message on the real inbound stream, and shows the bot's replies from the sandbox Graph client; the page refreshes the conversation every two seconds only while it is open. The web e2e runner now starts the worker too, so the simulator test gets real replies.
- **Review decisions** record the reviewer and a reason; accepting or rejecting B-BBEE evidence moves its profile with it. Documents now keep their post-validation flags (`review_flags`, migration 0007), so the queue says why each one waits.
- **Carried into M10:** migration 0007; the API service needs `STAFF_DATABASE_URL` (the jobs login) or inherits `WORKER_DATABASE_URL`; staff accounts are made on the box with `apps/api/scripts/create-staff.ts`.

**M9 decisions (hardening).**
- **Rate limit on `/api`,** a one-minute window after the session is known: 600 requests per signed-in session, 120 per anonymous address, and a shared 3 000 for the web server's own loopback calls (so a request mistaken for it is still bounded); `API_RATE_PER_MINUTE` and `API_ANON_RATE_PER_MINUTE` tune it. Over the limit: 429 with `Retry-After`. Sign-in and sign-up keep their stricter per-address limits.
- **Tax invoices:** `GET /api/wallet/topups/{id}/invoice.pdf` (pdf-lib 1.17.1) carries what the VAT Act s20(4) asks of a full tax invoice. In the sandbox it is overprinted as a specimen; outside it, it is refused until `SELLER_LEGAL_NAME`, `SELLER_ADDRESS` and `SELLER_VAT_NUMBER` are set, and is never issued with made-up details. A buyer's billing address is not collected yet (a tax invoice over R5 000 needs it): see §8.
- **Load test** (opt-in, `TSV_LOAD=1`, `apps/api/test/integration/load.test.ts`): 300 company checks at concurrency 10 through HTTP, PostgreSQL and Redis with the mock bureau: 38 a second, p50 239 ms, p95 340 ms, p99 805 ms, no errors (budget: p95 under 1.5 s on this box). The creating transaction now writes its audit entry last: the audit insert holds the tenant's chain-head lock until commit, and one tenant's concurrent checks queue on it. Client JavaScript is about 550 KB gzipped across the whole app; per-page loads are measured live in M10.
- **Independent security review** (2026-11-17; 1 critical, 1 high, 4 medium, 4 low). Fixed, each with a test (`hardening.test.ts`, `supplier.test.ts`):
  - Critical: test keys (the mock bureau) wrote the live verification cache and the shared supplier record, so in a live deployment a free account could pre-clear a shell company. The mock's answers now have their own cache namespace, and a test-environment check writes shared records only in the sandbox deployment (`sharedRecordsFromTest`).
  - High: a correct password cleared the count of wrong second factors, allowing unlimited code guessing four at a time. Only a complete sign-in clears it now, for buyers and staff.
  - Medium: `onboarding_promote()` could re-publish a passport staff had suspended; it publishes only from `none` or `revoked`.
  - Medium: an invitation could drain the buyer's wallet by repeating charged steps. The register lookup runs once per invitation (claimed under the row lock) and the tax PIN check three times.
  - Medium: any self-registered buyer could read a supplier's shared bank, B-BBEE and document details by adding the company. What a supplier gives a buyer now stays with that buyer; promotion copies only what the passport and self-service need (the contact, the identity and B-BBEE documents, the B-BBEE profile; never bank details) into shared rows no buyer reads. The monitoring sweep and the B-BBEE scorecard use the buyer's own evidence.
  - Low: idempotency keys now include the environment (a live call never replays a test answer); invitations are capped at 100 a day per buyer; the NOTIFY handler lookup uses `Object.hasOwn`; every staff console response is parsed through its strict contract, so a column added to a BYPASSRLS query later fails loudly instead of reaching a browser.
- **Open from the review, for live mode** (with the owner items in §8): identity proof beyond matching an ID number (DHA or liveness); a promoted supplier contact can withdraw any buyer's consents; `email_outbox` keeps link tokens in plain text (render at send time and clear after sending, once real mail exists); the API process holds the BYPASSRLS staff credential and the staff console shares the portal's origin (a separate staff process and origin, with a narrower role); the public passport's tax status comes from any buyer's latest real check.

**The design reference (owner, 2026-11-17).** The owner's project dashboard (kept out of git) has an editable Design system tab and a User interface tab with every page; the app follows them. The owner chose the app's own AAA system ("the specimen and the seal") over the dashboard's earlier Inter and blue tokens, and only the exported files go into git: `design/tokens.json` (colours in both themes, the contrast pairs that must pass, type, radii) and `design/pages.json` (the 44 pages and 7 shells). `tools/design-sync.mjs` pulls them from the dashboard (refusing any pair under its minimum), generates `apps/web/app/tokens.css`, pushes the repository's copy back, and `design:check` (run before the browser tests and the deploy) fails on drift: generated tokens, contrast, fonts, and pages added or removed without the map. See `apps/web/DESIGN.md`.
- **Dashboard v3 (owner, 2026-11-17: "work like" the ai-trading dashboard, "the best of both").** A full-page tabset: Task Management, Open Questions, Blockers & Risks, Open Decisions, Color Palette & Themes, Typography & Font Scaling, Layout & Structure, Brand Assets & Micro-interactions. Every design or layout edit is a requested change that waits for Claude (withdrawable until then; applied or declined with a reason afterwards). Uploaded files go to `temp/` next to the dashboard; Save to disk writes the file in place (File System Access API, Chrome or Edge); "Hand over to Claude" says what to do when finished. The design files moved to the dashboard's shape (version 2) and gained settings: the interface scale, the sidebar, rail and content widths, and the transition length and easing now reach the app through `tokens.css` as well (the sidebar, the main column and `Button` read them), next to the colours, type scale and radii. `design:pending`, `applied`, `declined` and `handled` carry a sync; `design/README.md` lists its steps.
- **Q1 (owner): a collapsible left sidebar,** built in 1cad1d1: a 6rem rail with each section's icon and name, remembered per browser; phones keep the Menu dialog. Live with the design reference v2 since 2026-11-17 12:02 UTC (release `20261117-135426-2d55c85`, the owner's Q5 approval); deploy/README.md's history has the checks.

**M10 decisions (the deploy).** The owner approved the box changes on 2026-11-17; going live asks again.
- **Three services** from one release folder: `tshepovet-api` (`apps\api\dist\main.js`, 9131, the tenant login plus the jobs login for the staff console), `tshepovet-worker` (`worker.js`, the jobs login), `tshepovet-web` (the Next standalone server, 9132, no database login or keys). IIS sends `/api`, `/v1`, `/webhooks`, `/healthz`, `/readyz` to the API and everything else to the web app, with `X-Forwarded-Host`/`-Proto`.
- **Headers:** IIS adds only HSTS and `X-Robots-Tag` (the whole sandbox stays unindexed). Its old `default-src 'none'` policy would have doubled the web app's nonce policy and blocked every page, so the API now sends its own security headers. `X-TshepoVet-Release` (API) and `X-TshepoVet-Build` (web, the Next build id) name the release, so a deploy can prove what answers.
- **Rehearsal before the switch:** `deploy-app.ps1 -StageOnly` stages the release and runs it from its folder on loopback against the test database; `-Release <name>` switches only to a rehearsed release. The switch backs up the live database (`pg_dump`) before migrating, writes the release's own `web.config` to the site only after the services answer, and goes back if they do not.
- **The first release stays reachable:** its `tshepovet-webhooks` service and hourly purge task are disabled, not removed (the worker does both), and `-Rollback` follows `history.txt`, so it can return to either layout with that release's routing. `run-purge.ps1` left the repository; the box keeps its copy for that rollback.
- **Redis** now keeps an append-only file (fsync each second) with `noeviction` (done 2026-11-17 by `install-box.ps1`; the live first release kept answering).
- **Rehearsed** release `20261117-124707-1eaed6a` (commit 1eaed6a): the full suite (191), the design check, the build, then the staged API, worker and web app on the test database.
- **Live** since 2026-11-17 10:57 UTC (the owner said "Yes, go live"): release `20261117-124707-1eaed6a` at https://tshepovet.madproducts.ai, the live database migrated from 0002 to 0007 after a `pg_dump`. Smoke 30/30 through Cloudflare (API 4, web 14, docs 12), the axe AAA suite 20/20 against the live site, no console errors in Chrome; deploy/README.md's history has the details and the rollback.
- **Still open for M10's "done when":** a Lighthouse run (not done: the agreed browser for checks, Claude in Chrome, cannot run it; the Performance API there measured the landing page at LCP 0.94 s warm, 3.7 s on the first cold hit, CLS 0) and the owner's own look at the app. The owner's staff account is made with `scripts/create-staff.ts` (deploy/README.md).

## 8. Blocked on the owner (none of it stops the build)

- **Bureau and payment contracts:** bureau contracts and credentials (XDS, CPB, SearchWorks, VerifyID), and confirmation of which bureaus offer TCS and eNaTIS; a payment provider for top-ups (the fleet default is Paddle via Cloud).
- **Messaging and accounting:** a Meta WhatsApp Business account and number; the SARS TCS fulfilment channel (`docs/03` §3.8); the Xero and Sage apps.
- **Production readiness:** hosting in South Africa (af-south-1), and the legal review of the privacy notice, the roles matrix and the s57 assessment of the conflict-of-interest radar (the radar ships behind a feature flag, off until then).
- **Email sending:** how mail should be sent (Cloud mail gateway or an SMTP account).
- **Tax invoices:** TshepoVet's registered name, address and VAT number (`SELLER_*`), and whether to collect buyers' billing addresses (needed on invoices over R5 000).

## 9. Risks

- **Size.** This is the largest piece of work in the repository. The milestones keep it reviewable: each one is its own commit series with its own tests.
- **Box resources.** Two more Node services on a shared, contended box. Each gets memory limits (`--max-old-space-size`), and the worker's concurrency is capped.
- **Next.js on Windows behind IIS.** The standalone output runs as a plain Node service; ARR proxies it like the API, and IIS serves static assets via `/_next/static` with immutable caching.
