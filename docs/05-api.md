# 5. MVP API: guide and sample code

The machine-readable contract is [`openapi/openapi.yaml`](../openapi/openapi.yaml) (OpenAPI 3.1). `tests/unit/openapi-contract.test.ts` keeps it in sync with the route validators: the request fields must match the zod schemas, every `$ref` must resolve, and the examples must validate.

| Endpoint | Handler | Service |
|---|---|---|
| `POST /v1/verify/company` | `src/routes/verify.ts` | `src/services/companyVerification.ts` |
| `POST /v1/verify/driver-license` (alias `/driver-licence`) | `src/routes/verify.ts` | `src/services/driverLicenceVerification.ts` |
| `GET /v1/verifications/{id}` | `src/routes/verify.ts` | `src/services/lifecycle.ts` |

## 5.1 Company check

```bash
curl -s https://api.tshepovet.co.za/v1/verify/company \
  -H "Authorization: Bearer $TSHEPOVET_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: onboard-SUP-0001-v1" \
  -d '{
    "registration_number": "2019/123456/07",
    "vat_number": "4123456789",
    "tax_reference_number": "9123456789",
    "tcs_pin": "AB12CD34EF",
    "checks": ["registration", "directors", "vat", "tcs"],
    "external_ref": "SUP-0001",
    "monitor": true,
    "consent": {
      "notice_code": "company_verification",
      "subject_display": "ACME TRADING (PTY) LTD",
      "subject_role": "authorised_representative",
      "purposes": ["tax_compliance_verification", "continuous_monitoring"],
      "captured_at": "2026-11-14T08:00:00+02:00",
      "evidence_reference": "onboarding-form-8812",
      "attested_by": "procurement@buyer.example"
    }
  }'
```

How to read the response:

* `outcome` is one of `verified`, `verified_with_warnings`, `failed_checks`, `not_found`, `unable_to_verify`. It is decision support (POPIA s71); your team makes the onboarding decision.
* For each check, `checks.<name>.source` and `data_as_of` show whether the data came from cache, a bureau, or stale cache served during an outage (`stale: true`).
* `risk_flags` are stable codes to branch on, for example `cipc_status_deregistration_process`, `vat_number_registered_to_different_name`, `sars_non_compliant`, `tcs_pin_expired` and `director_appointed_within_30_days`.
* `billing.charged` and `billing.wallet_balance_cents` report the charge. If all providers fail you get `unable_to_verify` and `charged: false`.

## 5.2 Driver check

```bash
curl -s https://api.tshepovet.co.za/v1/verify/driver-license \
  -H "Authorization: Bearer $TSHEPOVET_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: driver-8001015009087-2026-11" \
  -d '{
    "id_number": "8001015009087",
    "licence_number": "400100001234",
    "surname": "Mokoena",
    "required_codes": ["C1"],
    "required_prdp": ["G"],
    "vendor_id": "01a1dc4f-3f43-7a5d-8b21-0fd5fadd8d77",
    "consent": {
      "notice_code": "driver_verification",
      "subject_display": "T. Mokoena",
      "subject_role": "driver",
      "on_behalf_of_subject": true,
      "purposes": ["driver_licence_verification"],
      "captured_at": "2026-11-14T08:00:00+02:00",
      "evidence_reference": "driver-consent-form-77",
      "attested_by": "fleet@logistics.example"
    }
  }'
```

`required_codes` uses the licence code hierarchy, so `EC1` satisfies a `C1` requirement but `EC1` does not satisfy `C`. PrDP categories must match exactly (configurable). Gazetted grace periods for card backlogs come back as `licence_in_gazetted_grace_period`, a warning rather than a failure.

## 5.3 Handler anatomy

`POST /v1/verify/company` runs through these stages:

```
requestContext      -> X-Request-Id
apiKeyAuth          -> authenticate_api_key(prefix) + constant-time HMAC compare + scope
rateLimit           -> Redis fixed window per key (50 rps)
idempotency         -> claim / replay / 409 / 422
zod parse           -> CompanyRequestSchema (.strict(): unknown fields rejected)
SA normalisation    -> VAT (4xxxxxxxxx), tax ref, TCS PIN
CompanyVerificationService.start()
  TX1: resolve vendor (definer fn) -> link -> consent -> insert verification -> RESERVE hold
  process(): parallel resolve(registration | vat | tcs) via cache -> waterfall
  TX2: persist vendor/directors/PIN -> checks -> provider_calls -> CAPTURE|RELEASE -> outbox -> audit
respond()           -> 200 (done) | 202 (still processing) + Location
errorHandler        -> RFC 9457 problem+json with stable `code`
```

The wallet deduction itself (`src/billing/wallet.ts`) is one atomic statement guarded by a DB constraint:

```sql
UPDATE wallets SET held_cents = held_cents + $2
 WHERE tenant_id = $1 AND status = 'active'
   AND balance_cents - held_cents + credit_limit_cents >= $2
RETURNING id;            -- no row => 402 insufficient_funds
```

The capture (`capture()`) moves the hold into the balance and posts two ledger entries (Dr customer_wallet, Cr revenue_usage) under the idempotency key `capture:<hold_id>`.

## 5.4 Receiving webhooks

Events are **thin**: ids, statuses and flags. Fetch details with `GET /v1/verifications/{id}`. Delivery is at least once, so deduplicate on `id`.

```ts
import crypto from 'node:crypto';
import express from 'express';

const app = express();
app.post('/tshepovet/webhooks', express.raw({ type: 'application/json' }), (req, res) => {
  const header = req.header('tshepovet-signature') ?? '';
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return res.sendStatus(400); // replay window
  const expected = Buffer.from(crypto.createHmac('sha256', process.env.TSHEPOVET_WEBHOOK_SECRET!).update(`${t}.${req.body}`).digest('hex'));
  const ok = header.split(',').some((p) => {
    const sig = Buffer.from(p.startsWith('v1=') ? p.slice(3) : '');
    return sig.length === expected.length && crypto.timingSafeEqual(sig, expected);
  });
  if (!ok) return res.sendStatus(401);
  const event = JSON.parse(req.body.toString('utf8'));
  // enqueue(event) - respond fast; process asynchronously, idempotently on event.id
  res.sendStatus(204);
});
```

`src/webhooks/signing.ts#verifyWebhook` is the reference implementation, and it supports multiple `v1` signatures during secret rotation.

## 5.5 Errors

| HTTP | `code` | When |
|---|---|---|
| 400 | `validation_error`, `invalid_registration_number`, `invalid_id_number`, `invalid_tcs_pin`, `vat_number_required`, `tcs_inputs_required`, `tcs_pin_is_tax_reference`, `consent_ambiguous` | Input problems. Nothing created, nothing charged. |
| 401 | `unauthorized` | Bad or missing key |
| 402 | `insufficient_funds` | `details.required_cents` and `available_cents` |
| 403 | `forbidden`, `tenant_suspended` | Scope or account |
| 404 | `not_found`, `vendor_not_found` | Includes other tenants' resources (no existence leak) |
| 409 | `idempotency_in_progress` | Retry after a moment |
| 422 | `consent_required`, `consent_not_found`, `consent_expired`, `consent_subject_mismatch`, `idempotency_key_reused`, `notice_not_found` | |
| 429 | `rate_limited` | Honour `Retry-After` |

## 5.6 Running locally

See the [README](../README.md#quick-start). Sandbox (`tv_test_`) keys are free and deterministic. The magic values are listed in the OpenAPI description.
