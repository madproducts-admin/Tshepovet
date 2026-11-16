# TshepoVet

TshepoVet is a low-cost B2B vendor onboarding, KYB and continuous-compliance platform for South Africa. A company legitimacy check (CIPC registration, active directors, VAT, SARS TCS) costs **R3.00** and a driving licence / PrDP check costs **R2.50**. Paid modules cover B-BBEE scorecards, conflict-of-interest and ghost-supplier detection, construction/logistics add-ons, and continuous expiry monitoring with an accounting payment lock. Each verified supplier gets a free, shareable **Verified Vendor Passport**.

This repository contains the architecture, the full PostgreSQL schema, the POPIA/SARS compliance design, the WhatsApp + AI OCR onboarding flow, and a working, tested TypeScript implementation of the MVP API.

| # | Deliverable | Where |
|---|---|---|
| 1 | System architecture and waterfall API engine (cost/uptime routing, POPIA-aware caching, unit economics) | [docs/01-architecture.md](docs/01-architecture.md) · `packages/core/src/waterfall/` · `packages/core/src/cache/` |
| 2 | Database schema: multi-tenant RLS, Vendor Passports, consent, audit chain, wallet ledger, expiry schedules | [db/migrations/](db/migrations/) · [docs/02-database-schema.md](docs/02-database-schema.md) |
| 3 | POPIA and SARS workflow: consent capture, TCS PIN handling, auto-purge | [docs/03-popia-sars-compliance.md](docs/03-popia-sars-compliance.md) · `packages/core/src/consent/` · `run_retention_purge()` |
| 4 | WhatsApp and AI OCR onboarding | [docs/04-whatsapp-ocr-onboarding.md](docs/04-whatsapp-ocr-onboarding.md) · `packages/core/src/whatsapp/` · `packages/core/src/ocr/` |
| 5 | OpenAPI spec and NestJS handlers for `POST /v1/verify/company` and `POST /v1/verify/driver-license` | [openapi/openapi.yaml](openapi/openapi.yaml) · [docs/05-api.md](docs/05-api.md) · `apps/api/src/http/v1.controller.ts` |

Designed HTML versions of this README and the docs are in [docs/pages/](docs/pages/), with links to the published pages.

## Quick start

Requirements: Node 20+, PostgreSQL 16, Redis 7.

```bash
npm install

# 1. Database roles: an owner that runs migrations, and an app login role WITHOUT
#    superuser/BYPASSRLS so row-level security is actually enforced.
psql -c "CREATE ROLE tshepovet_owner LOGIN SUPERUSER PASSWORD 'devpass';"
psql -c "CREATE DATABASE tshepovet_dev OWNER tshepovet_owner;"
export MIGRATION_DATABASE_URL=postgres://tshepovet_owner:devpass@localhost:5432/tshepovet_dev
npx tsx scripts/migrate.ts
psql "$MIGRATION_DATABASE_URL" -c "CREATE ROLE tshepovet_api LOGIN PASSWORD 'apipass' IN ROLE tshepovet_app;"

# 2. Secrets (dev only) and a demo tenant with R1,000 credit + live/test API keys
cp .env.example .env   # then fill the three 32-byte base64 keys:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
set -a; source .env; set +a
npx tsx scripts/seed-dev.ts      # prints tenant id and API keys

# 3. Run
npm run dev
curl -s localhost:8080/v1/verify/company \
  -H "Authorization: Bearer <tv_live_ key from seed>" -H 'Content-Type: application/json' \
  -d '{"registration_number":"CK2001/012345/23","vat_number":"4123456789","checks":["registration","directors","vat"]}'
```

With `ENABLED_PROVIDERS=mock` (the default outside production), live keys hit the deterministic mock bureau. Sandbox `tv_test_` keys always do, and are free. The magic test values are listed in the OpenAPI description.

## Tests

```bash
npm test            # 89 tests: unit + integration (needs PostgreSQL and Redis)
npm run typecheck
```

The integration suite rebuilds a real PostgreSQL database from `db/migrations/` and connects as the **non-superuser app role**, so every test runs under RLS. It exercises the HTTP API end to end: R3.00 wallet capture and ledger balance, cross-tenant cache sharing versus tenant-scoped TCS, idempotent replay, 402 with nothing created, bureau failover, no charge when all bureaus are down, consent enforcement, tenant isolation, signed webhook delivery, audit-chain integrity, and crypto-shredding by the retention purge.

## Repository layout

npm workspaces. [docs/PLAN.md](docs/PLAN.md) is the master plan for the complete application.

```
db/migrations/        0001 schema (RLS, ledger, audit chain, purge), 0002 reference data
openapi/openapi.yaml  OpenAPI 3.1 contract of the public /v1 API
packages/core/        the framework-free domain (@tshepovet/core)
  src/domain/sa/      CIPC numbers & statuses, SA ID (Luhn), SARS ids/TCS, licences/PrDP, B-BBEE rules
  src/waterfall/      router (expected-cost scoring, ceilings, deadlines) + Redis health/circuit breakers
  src/providers/      canonical capability model, mock bureau, generic HTTP bureau adapter
  src/cache/          tiered, encrypted, scope-by-data cache with single-flight
  src/services/       check resolver, company + driver services, verification lifecycle
  src/billing/        wallet holds over a double-entry ledger, price book
  src/consent/        lawful-basis/consent assertion and attestation recording
  src/webhooks/       transactional outbox, signing, dispatcher
  src/whatsapp/       inbound types + signature check, pure state machine, worker, Graph client
  src/ocr/            Claude structured extraction, deterministic post-validation
  src/auth/           API-key format and hashing
  test/               unit tests
packages/contracts/   request schemas shared by the API and the web app (@tshepovet/contracts)
apps/api/             NestJS (Express adapter): src/main.ts (HTTP), src/worker.ts (background jobs)
  src/http/           /v1 controller, WhatsApp webhook, health, middleware, problem+json errors
  test/integration/   the HTTP API end to end against PostgreSQL and Redis
docs/pages/           the design pages (HTML); also the source of the docs at /docs
deploy/site/          docs Worker: wrangler.toml + site-only files (404, robots.txt)
deploy/app/           the API on the box: setup, deploy, rollback, test runner
tools/                docs: build, assemble, deploy; tests/smoke has the Playwright suites
```

## Running on tshepovet.madproducts.ai

The API runs as a **sandbox** at https://tshepovet.madproducts.ai (mock bureaus, `tv_test_` keys only), with the design pages at `/docs`. Hosting, deploys and rollback are in [deploy/README.md](deploy/README.md). The complete application (portal, passports, staff console, background jobs) is planned in [docs/PLAN.md](docs/PLAN.md).

## Known gaps before production

These are tracked in docs/01 §1.9 and docs/04:

* Bureau adapters (`httpBureau.ts`) use **placeholder endpoints and field mappings**. Map them from each bureau's signed integration guide, and confirm which bureaus actually offer TCS and eNaTIS products.
* There is no public SARS TCS API. Choose a lawful fulfilment channel (docs/03 §3.8).
* Async verifications run in-process. Move them to a durable queue (SQS or BullMQ).
* `LocalKeyProvider` needs replacing with AWS KMS (af-south-1).
* Not yet built: the secure TCS link / WhatsApp Flow endpoint, the ClamAV scan, EXIF stripping and pHash, the ERP connectors, and the B-BBEE scorecard and COI radar workers. The schema supports all of them.
* Legal review is required for the notice wording, the roles matrix and the POPIA s57 assessment of the COI radar.
