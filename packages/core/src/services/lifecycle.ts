import type { Pool, PoolClient } from 'pg';
import { audit } from '../audit/audit';
import { capture, priceFor, release, reserve } from '../billing/wallet';
import { withTenantTx } from '../lib/db';
import type { Crypto } from '../lib/crypto';
import type { Capability } from '../providers/types';
import type { Attempt } from '../waterfall/engine';
import { enqueueWebhook } from '../webhooks/outbox';

export interface AuthContext {
  tenantId: string;
  /** The API key behind a /v1 request; null when a signed-in portal user asked. */
  apiKeyId: string | null;
  /** The portal user behind an /api request. */
  userId?: string | null;
  /** Which providers answer: the 'live' bureaus or the deterministic 'test' mock. */
  environment: 'live' | 'test';
  /**
   * Charge the price book although the 'test' providers answer. Set by the sandbox portal,
   * where the bureau is the mock but the wallet, holds and ledger run for real on sandbox
   * credit. tv_test_ API keys leave it unset: their checks are free.
   */
  chargeTestChecks?: boolean;
  scopes: string[];
}

export type CheckStatus = 'passed' | 'failed' | 'warning' | 'not_found' | 'pending' | 'error' | 'skipped';
export type Outcome = 'verified' | 'verified_with_warnings' | 'failed_checks' | 'not_found' | 'unable_to_verify';

export interface CheckRecord {
  checkType: 'registration' | 'directors' | 'vat' | 'tcs' | 'licence' | 'prdp' | 'id_match';
  status: CheckStatus;
  source: string;
  dataAsOf: string | null;
  stale: boolean;
  result: Record<string, unknown> | null;
  errorCode?: string;
  warnings?: string[];
}

export interface CreateArgs {
  auth: AuthContext;
  requestId: string;
  type: 'company' | 'driver_licence';
  sku: string;
  subjectFingerprint: Buffer;
  subjectDisplay: string;
  checksRequested: string[];
  vendorId: string | null;
  tenantVendorId: string | null;
  consentId: string | null;
}

/** Inside the caller's tenant transaction: price, insert verification, reserve funds. */
export async function createVerification(client: PoolClient, a: CreateArgs): Promise<{ verificationId: string; holdId: string | null; priceCents: number }> {
  const priceCents = await priceFor(client, a.auth.tenantId, a.sku, a.auth.chargeTestChecks ? 'live' : a.auth.environment);
  const v = await client.query<{ id: string }>(
    `INSERT INTO verifications (tenant_id, verification_type, tenant_vendor_id, vendor_id, subject_fingerprint, subject_display,
                                consent_id, checks_requested, sku, price_cents, requested_by_api_key, requested_by_user, request_id, purge_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now() + interval '5 years') RETURNING id`,
    [
      a.auth.tenantId,
      a.type,
      a.tenantVendorId,
      a.vendorId,
      a.subjectFingerprint,
      a.subjectDisplay,
      a.consentId,
      a.checksRequested,
      a.sku,
      priceCents,
      a.auth.apiKeyId,
      a.auth.userId ?? null,
      a.requestId,
    ],
  );
  const verificationId = v.rows[0]!.id;
  const hold = await reserve(client, { tenantId: a.auth.tenantId, amountCents: priceCents, sku: a.sku, referenceType: 'verification', referenceId: verificationId });
  if (hold) await client.query(`UPDATE verifications SET wallet_hold_id = $2 WHERE id = $1`, [verificationId, hold.id]);
  await audit(client, {
    tenantId: a.auth.tenantId,
    actorType: a.auth.userId ? 'user' : 'api_key',
    actorId: a.auth.userId ?? a.auth.apiKeyId,
    action: 'verification.created',
    entityType: 'verification',
    entityId: verificationId,
    requestId: a.requestId,
    details: { type: a.type, sku: a.sku, checks: a.checksRequested, price_cents: priceCents, consent_id: a.consentId },
  });
  return { verificationId, holdId: hold?.id ?? null, priceCents };
}

export interface FinalizeArgs {
  tenantId: string;
  verificationId: string;
  holdId: string | null;
  requestId: string;
  billable: boolean;
  outcome: Outcome;
  status: 'completed' | 'failed';
  checks: CheckRecord[];
  riskFlags: string[];
  attempts: Array<Attempt & { capability: Capability }>;
  subjectFingerprint: Buffer;
  webhookData: Record<string, unknown>;
  persist?: (client: PoolClient) => Promise<void>;
}

/**
 * Single transaction: results + provider-call ledger + capture/release +
 * webhook outbox + audit. Either all of it happens or none of it does.
 */
export async function finalizeVerification(pool: Pool, crypto: Crypto, f: FinalizeArgs): Promise<{ charged: boolean; balanceCents: number | null }> {
  return withTenantTx(pool, f.tenantId, async (client) => {
    if (f.persist) await f.persist(client);

    for (const c of f.checks) {
      await client.query(
        `INSERT INTO verification_checks (verification_id, tenant_id, check_type, status, source, data_as_of, result, error_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [f.verificationId, f.tenantId, c.checkType, c.status, c.source, c.dataAsOf, c.result ? JSON.stringify(c.result) : null, c.errorCode ?? null],
      );
    }

    let bureauCost = 0;
    for (const a of f.attempts) {
      bureauCost += a.costCents;
      const rawEnc = a.raw === undefined ? null : await crypto.encrypt(JSON.stringify(a.raw), `provider_call:${f.tenantId}:${f.verificationId}`);
      await client.query(
        `INSERT INTO provider_calls (tenant_id, verification_id, provider_code, capability, attempt_no, outcome, http_status,
                                     duration_ms, cost_cents, request_fingerprint, response_enc, purge_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + interval '30 days')`,
        [f.tenantId, f.verificationId, a.provider, a.capability, a.attemptNo, a.outcome, a.httpStatus ?? null, a.durationMs, a.costCents, f.subjectFingerprint, rawEnc],
      );
    }

    let charged = false;
    let balanceCents: number | null = null;
    if (f.holdId) {
      if (f.billable) {
        const c = await capture(client, f.tenantId, f.holdId, `verification ${f.verificationId}`);
        charged = c.captured;
        balanceCents = c.balanceCents;
      } else {
        await release(client, f.holdId);
      }
    }

    const result = Object.fromEntries(f.checks.map((c) => [c.checkType, { status: c.status, source: c.source, data_as_of: c.dataAsOf, stale: c.stale, warnings: c.warnings ?? [], error_code: c.errorCode ?? null, result: c.result }]));
    await client.query(
      `UPDATE verifications SET status = $2, outcome = $3, result = $4, risk_flags = $5, bureau_cost_cents = $6,
                                charged = $7, completed_at = now()
        WHERE id = $1`,
      [f.verificationId, f.status, f.outcome, JSON.stringify(result), f.riskFlags, bureauCost, charged],
    );

    await enqueueWebhook(client, f.tenantId, f.status === 'completed' ? 'verification.completed' : 'verification.failed', f.verificationId, {
      verification_id: f.verificationId,
      status: f.status,
      outcome: f.outcome,
      risk_flags: f.riskFlags,
      charged,
      ...f.webhookData,
    });

    // Low-balance notification, at most once per 24h.
    const low = await client.query<{ balance_cents: string }>(
      `UPDATE wallets SET low_balance_notified_at = now()
        WHERE tenant_id = $1 AND balance_cents - held_cents < low_balance_threshold_cents
          AND (low_balance_notified_at IS NULL OR low_balance_notified_at < now() - interval '24 hours')
        RETURNING balance_cents`,
      [f.tenantId],
    );
    if (low.rows[0]) {
      await enqueueWebhook(client, f.tenantId, 'wallet.low_balance', f.tenantId, { balance_cents: Number(low.rows[0].balance_cents) });
    }

    await audit(client, {
      tenantId: f.tenantId,
      actorType: 'system',
      actorId: 'verification_engine',
      action: `verification.${f.status}`,
      entityType: 'verification',
      entityId: f.verificationId,
      requestId: f.requestId,
      details: { outcome: f.outcome, charged, bureau_cost_cents: bureauCost, providers: [...new Set(f.attempts.map((a) => a.provider))] },
    });
    return { charged, balanceCents };
  });
}

export function deriveOutcome(checks: CheckRecord[], primary: CheckRecord['checkType']): Outcome {
  const p = checks.find((c) => c.checkType === primary);
  if (!p || p.status === 'error' || p.status === 'pending') return 'unable_to_verify';
  if (p.status === 'not_found') return 'not_found';
  if (checks.some((c) => c.status === 'failed' || c.status === 'not_found')) return 'failed_checks';
  if (checks.some((c) => c.status === 'warning' || c.status === 'error' || c.stale)) return 'verified_with_warnings';
  return 'verified';
}

/** Shape a verifications row for the API. */
export function presentVerification(row: {
  id: string;
  verification_type: string;
  status: string;
  outcome: string | null;
  vendor_id: string | null;
  subject_display: string;
  result: Record<string, unknown> | null;
  risk_flags: string[];
  sku: string;
  price_cents: number;
  charged: boolean;
  requested_at: Date;
  completed_at: Date | null;
  external_ref?: string | null;
}, extras: { wallet_balance_cents?: number | null } = {}) {
  return {
    id: row.id,
    object: 'verification',
    type: row.verification_type,
    status: row.status,
    outcome: row.outcome,
    vendor_id: row.vendor_id,
    external_ref: row.external_ref ?? null,
    subject: row.subject_display,
    checks: row.result ?? {},
    risk_flags: row.risk_flags,
    billing: {
      sku: row.sku,
      price_cents: row.price_cents,
      currency: 'ZAR',
      vat_exclusive: true,
      charged: row.charged,
      ...(extras.wallet_balance_cents !== undefined && extras.wallet_balance_cents !== null ? { wallet_balance_cents: extras.wallet_balance_cents } : {}),
    },
    requested_at: row.requested_at.toISOString(),
    completed_at: row.completed_at ? row.completed_at.toISOString() : null,
  };
}

export async function loadVerification(pool: Pool, tenantId: string, id: string) {
  return withTenantTx(pool, tenantId, async (c) => {
    const r = await c.query(
      `SELECT v.*, tv.external_ref FROM verifications v LEFT JOIN tenant_vendors tv ON tv.id = v.tenant_vendor_id WHERE v.id = $1`,
      [id],
    );
    return r.rows[0];
  });
}
