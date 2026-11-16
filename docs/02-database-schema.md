# 2. Database schema (PostgreSQL 16)

The DDL is in [`db/migrations/0001_init.sql`](../db/migrations/0001_init.sql) and the reference data in [`0002_seed_reference_data.sql`](../db/migrations/0002_seed_reference_data.sql). The test suite rebuilds the database from these exact files on every run, as a non-superuser app role, so RLS is exercised for real.

## 2.1 Core entity relationships

```mermaid
erDiagram
  tenants ||--o{ api_keys : has
  tenants ||--|| wallets : has
  tenants ||--o{ tenant_vendors : "buys from"
  vendors ||--o{ tenant_vendors : "supplies"
  vendors ||--o{ vendor_passport_shares : "shares passport with"
  tenants ||--o{ vendor_passport_shares : "receives"
  vendors ||--o{ vendor_directors : ""
  vendors ||--o{ vendor_beneficial_owners : ""
  vendors ||--o{ vendor_bank_accounts : ""
  vendors ||--o{ vendor_bbbee_profiles : ""
  vendors ||--o{ vendor_documents : ""
  vendors ||--o{ vendor_credentials : "CIDB, COIDA, licences"
  vendors ||--o{ tax_compliance_pins : ""
  tenant_vendors ||--o{ expiry_schedules : ""
  tenant_vendors ||--o{ monitoring_enrolments : ""
  tenants ||--o{ verifications : ""
  verifications ||--o{ verification_checks : ""
  verifications ||--o{ provider_calls : "cost ledger"
  verifications }o--|| consent_records : "lawful basis"
  consent_records ||--o{ consent_purposes : "granular"
  consent_records }o--|| privacy_notices : "exact text"
  wallets ||--o{ wallet_holds : ""
  ledger_transactions ||--|{ ledger_entries : "sum = 0"
  tenants ||--o{ webhook_endpoints : ""
  webhook_events ||--o{ webhook_deliveries : ""
  tenants ||--o{ tenant_employees : "COI radar"
  tenants ||--o{ wa_conversations : ""
  tenants ||--o{ audit_log : "hash chain"
```

## 2.2 Table groups

| Group | Tables | Key decisions |
|---|---|---|
| **Reference** | `ref_cipc_entity_types`, `ref_bbbee_thresholds`, `ref_bbbee_recognition_levels`, `ref_document_types`, `ref_regulatory_grace_periods`, `ref_retention_policies`, `price_book`, `providers`, `provider_capabilities`, `privacy_notices`, `processing_activities` | Regulation is data, not code. Sector-code thresholds, gazetted licence grace periods, retention periods and prices change by gazette or contract, so the compliance team edits rows without a deploy. Rows that are not `verified` are never used for automatic decisions. |
| **Tenancy** | `tenants`, `tenant_users`, `api_keys` | `tenant_users.can_view_special_pi` gates B-BBEE ownership and biometric data. API keys are stored as `HMAC(pepper, key)`. |
| **Vendor Passport (global)** | `vendors`, `vendor_directors`, `vendor_beneficial_owners`, `vendor_contacts`, `vendor_bank_accounts`, `vendor_bbbee_profiles`, `vendor_documents`, `vendor_credentials` | There is one row per legal entity across all buyers. The natural key is the normalised CIPC number (`YYYY/NNNNNN/TT`, CHECK-constrained) or, for sole proprietors, the owner's SA ID blind index. CHECK constraints force companies to have a CIPC number and sole proprietors to have an owner ID. |
| **Relationships** | `tenant_vendors`, `vendor_passport_shares`, `monitoring_enrolments` | Visibility of a passport is derived: a tenant sees a vendor only through a relationship or an active, unexpired share (`tenant_can_see_vendor()`). Monitoring periods use a `tstzrange` with an exclusion constraint, so double-billing is impossible. |
| **POPIA** | `privacy_notices`, `consent_records`, `consent_purposes`, `processing_activities`, `data_subject_requests` | Notices are immutable and stored with a SHA-256 of the exact text shown. A consent record is one capture event, and each purpose can be withdrawn independently. Lawful basis is recorded per purpose, because consent is not the only basis. `data_subject_requests.due_at` defaults to 30 days (PAIA). |
| **SARS** | `tax_compliance_pins` | The PIN is a bearer credential: `pin_enc` is envelope-encrypted with AAD `tcs_pin:<tenant>:<vendor>`, deduplicated by `pin_fingerprint` (tenant-keyed HMAC), and `purge_after` is required (NOT NULL). It is kept only while monitoring is enabled and the PIN is active (doc 3). |
| **Documents & expiry** | `vendor_documents`, `vendor_credentials`, `expiry_schedules` | Images and extracted fields have separate retention: `image_purge_after` (30–90 days) versus `record_purge_after`. `perceptual_hash` catches the same ID photo being reused across vendors. `expiry_schedules.reminders_sent` makes reminders idempotent. |
| **Engine** | `provider_calls`, `verification_cache`, `verifications`, `verification_checks` | `provider_calls` is the per-attempt cost and health ledger, holding the bureau payload encrypted with 30-day retention. `verification_cache` enforces with a CHECK constraint that `global` rows have no tenant and `tenant` rows have one. `verifications.bureau_cost_cents` gives margin per check. |
| **Billing** | `price_book`, `tenant_price_overrides`, `ledger_accounts`, `wallets`, `wallet_holds`, `ledger_transactions`, `ledger_entries`, `wallet_topups`, `subscriptions` | See §2.3. |
| **Integration** | `idempotency_keys`, `webhook_endpoints`, `webhook_events`, `webhook_deliveries` | A transactional outbox: events are written in the same transaction as the state change. |
| **WhatsApp** | `wa_conversations`, `wa_inbound_messages`, `ocr_jobs` | `wa_inbound_messages.wa_message_id` is the primary key, used for dedupe because Meta retries deliveries. A partial unique index allows one active conversation per buyer and phone number. `version` gives optimistic concurrency. |
| **Audit** | `audit_log` (monthly partitions), `audit_chain_heads` | See §2.4. |

## 2.3 Billing invariants enforced by the database

| Invariant | Mechanism |
|---|---|
| A buyer can never spend credit they don't have, even under an application bug | `CONSTRAINT wallet_no_overspend CHECK (balance_cents - held_cents + credit_limit_cents >= 0)` |
| Every ledger transaction balances | `DEFERRABLE INITIALLY DEFERRED` constraint trigger `assert_ledger_balanced()` (sum of entries = 0 at commit) |
| The ledger is immutable | `forbid_mutation()` triggers + `REVOKE UPDATE, DELETE` |
| A hold is captured at most once | `wallet_holds.status` transition `active→captured` in a single `UPDATE ... WHERE status='active'`; ledger `idempotency_key = 'capture:<hold_id>'` is UNIQUE |
| Top-up VAT arithmetic | `CHECK (gross_cents = credit_cents + vat_cents)`. Credits are VAT-exclusive (15% VAT is invoiced on top-up); confirm the time-of-supply treatment of prepaid credits with your tax adviser. |
| One hold per verification | `UNIQUE (reference_type, reference_id)` |

The sign convention is debit positive, credit negative. The customer wallet is a **liability** (TshepoVet owes the buyer checks), so a top-up credits it and a usage capture debits it, with the opposite leg on `revenue_usage`. `wallets.balance_cents` is a projection of that account, and the integration test asserts that projection = ledger.

## 2.4 Audit hash chain

```
row_hash = sha256(prev_hash || chain_seq | tenant | actor | action | entity | request_id | details | occurred_at)
```

* `audit_log_chain()` is a `SECURITY DEFINER` BEFORE INSERT trigger. It locks the tenant's `audit_chain_heads` row, assigns `chain_seq = last_seq + 1`, and links the row to the previous hash. Because the sequence is assigned under the lock, chain order equals `chain_seq` order even when transactions interleave.
* The app role has no access to `audit_chain_heads` and no `UPDATE`/`DELETE` on `audit_log`.
* `verify_audit_chain(tenant)` returns the first broken `chain_seq`, which detects both edits and deletions (gaps). The smoke tests confirm it catches a superuser rewrite. For external anchoring, publish the daily head hash per tenant (for example to the tenant's own webhook, or to an append-only bucket).
* Partition retention: drop monthly partitions older than seven years (`ref_retention_policies.audit_log`).

## 2.5 Row-level security matrix

| Policy type | Tables | Rule |
|---|---|---|
| `tenant_isolation` | 23 tenant-owned tables (verifications, wallets, holds, expiry schedules, PINs, webhooks, conversations, ...) | `tenant_id = current_tenant_id()` for read and write |
| `tenant_rw` | consent, ledger, provider_calls, DSRs | read own rows; may write platform rows (`tenant_id IS NULL`), e.g. ledger revenue legs |
| `platform_accounts_read` | `ledger_accounts` | the platform revenue/cash accounts are readable so captures can post to them |
| `cache_*` | `verification_cache` | `scope='global'` readable/writable by all tenants, `scope='tenant'` own rows only |
| `vendor_visible` / `vendor_child` | vendors and children | `tenant_can_see_vendor(vendor_id)`: relationship or active passport share |
| `doc_visible` | documents, credentials | own uploads, or passport-level rows (`tenant_id IS NULL`) the vendor shared |
| `audit_read` / `audit_insert` | `audit_log` | own chain only |

There is deliberately **no INSERT policy on `vendors`**. Tenants create passports only through `resolve_vendor_by_cipc()` and `resolve_vendor_sole_proprietor()`, which deduplicate on the natural key and return only an id, so a tenant can't probe which companies other buyers work with. API-key authentication uses `authenticate_api_key()`, because RLS hides `api_keys` until the tenant is known.

> **Operational requirement:** the schema-owner role must have `BYPASSRLS` (or be the RDS master user), because `FORCE ROW LEVEL SECURITY` also applies to table owners and the definer functions rely on that bypass. The API connects as a separate login role that is a member of `tshepovet_app` and has no `BYPASSRLS`. Workers that legitimately span tenants (dispatcher, purge, monitoring, WhatsApp routing) use `tshepovet_worker`.

## 2.6 Retention (POPIA s14) in the schema

Every table holding personal information has a `purge_after`-style column populated at write time from `ref_retention_policies`. `run_retention_purge(batch)` (worker-only `EXECUTE`) then:

| Data | Action |
|---|---|
| TCS PINs past expiry, revoked or invalid | `pin_enc := NULL` (crypto-shred), `status := 'purged'`; status history retained |
| Raw bureau payloads (30 d) | `response_enc := NULL` |
| Document images | worker deletes the S3 object (all versions) **then** `storage_key := NULL` |
| Document records past retention | `extracted_fields_enc := NULL`, `document_number_bidx := NULL` |
| Cache rows past `stale_until` | `DELETE` |
| Verification results past retention | `result := NULL`, `subject_display := '[purged]'`; billing skeleton kept for tax records |
| Director IDs past retention | `id_number_enc := NULL` |
| HR imports (30 d after last activity) | `DELETE` |
| WhatsApp message metadata (30 d), idempotency keys (24 h) | `DELETE` |

Each run writes a `purge_runs` row and a `retention.purged` audit event with counts, which is your evidence for the Information Regulator. Backups can't be rewritten, so deletion in backups relies on crypto-shredding: a purged row has no ciphertext left in live data, and backup ciphertexts become unrecoverable when the KEK version that wrapped them is retired at the end of the backup retention window.

## 2.7 Running migrations

```bash
MIGRATION_DATABASE_URL=postgres://owner:***@host:5432/tshepovet npx tsx scripts/migrate.ts
```

The migrator is forward-only and tracks applied files in `schema_migrations`. Each file is a single transaction (`BEGIN ... COMMIT`).
