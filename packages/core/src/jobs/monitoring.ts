import type { Pool, PoolClient } from 'pg';
import { audit } from '../audit/audit';
import { priceFor } from '../billing/wallet';
import { ApiError } from '../lib/errors';
import type { Logger } from '../lib/logger';
import { enqueueMail, type MailTemplate, type MailVars } from '../mail/outbox';
import type { CompanyVerificationService } from '../services/companyVerification';
import { loadVerification } from '../services/lifecycle';
import { enqueueWebhook } from '../webhooks/outbox';

/**
 * Continuous monitoring (docs/PLAN.md §3, M7), run every 15 minutes by the worker. Each pass:
 *   1. schedules what expires for every monitored supplier: the tax PIN (scheduled when it is
 *      checked), B-BBEE evidence, documents with an expiry date, the CIPC annual return;
 *   2. acts on what is due: reminders at 30, 14 and 7 days (a webhook and an email to the
 *      buyer's admins), and on the day it expires the expiry itself, which locks payments
 *      when the buyer turned the accounting-system lock on;
 *   3. queues a weekly re-check of each monitored company (covered by the monthly fee);
 *   4. charges each supplier's monitoring month from the wallet, once per month;
 *   5. renews modules at the end of their month.
 * A charge the wallet cannot cover is retried every pass for a week, then the service ends.
 * Every write runs in its own transaction with its audit entry, webhook and mail.
 */
const THRESHOLDS = [30, 14, 7] as const;
const GRACE_DAYS = 7;

const SUBJECT_LABEL: Record<string, string> = {
  tcs_pin: 'the tax compliance PIN',
  bbbee: 'the B-BBEE evidence',
  cipc_annual_return: 'the CIPC annual return',
  document: 'a document',
  credential: 'a licence or permit',
};
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const dayFmt = new Intl.DateTimeFormat('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' });
const formatDay = (iso: string) => dayFmt.format(new Date(`${iso}T12:00:00+02:00`));
const rands = (cents: number) => `R${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;

export interface SweepResult {
  scheduled: number;
  reminded: number;
  expired: number;
  locked: number;
  rechecksQueued: number;
  charged: number;
  unpaid: number;
  renewed: number;
  endedUnpaid: number;
}

export interface MonitoringDeps {
  pool: Pool; // BYPASSRLS (tshepovet_worker): the sweep spans tenants; every query names its tenant
  log: Logger;
  appUrl: string;
  company: Pick<CompanyVerificationService, 'start'>;
  /** Which bureaus re-checks use: the mock in the sandbox. */
  environment: 'live' | 'test';
  /** Queues a re-check (the monitoring queue); called by the sweep. */
  queueRecheck: (tenantId: string, tenantVendorId: string) => Promise<void>;
}

async function inTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

async function mailAdmins(c: PoolClient, tenantId: string, template: MailTemplate, vars: Omit<MailVars, 'appUrl'> & { appUrl: string }) {
  const admins = await c.query<{ email: string; full_name: string }>(
    `SELECT email::text AS email, full_name FROM tenant_users WHERE tenant_id = $1 AND role IN ('owner','admin','procurement') AND disabled_at IS NULL`,
    [tenantId],
  );
  for (const a of admins.rows) await enqueueMail(c, { tenantId, to: a.email, template, vars: { ...vars, name: a.full_name } });
}

const system = (tenantId: string, action: string, entityType: string, entityId: string, details: Record<string, unknown> = {}) => ({
  tenantId,
  actorType: 'system' as const,
  actorId: 'monitoring',
  action,
  entityType,
  entityId,
  details,
});

/** Debits the wallet and books the revenue; false when the wallet cannot cover it. */
async function charge(
  c: PoolClient,
  a: { tenantId: string; cents: number; kind: 'monitoring_charge' | 'subscription_charge'; revenue: string; referenceType: string; referenceId: string; key: string; memo: string },
): Promise<boolean> {
  if (a.cents <= 0) return true;
  const w = await c.query<{ ledger_account_id: string }>(
    `UPDATE wallets SET balance_cents = balance_cents - $2, updated_at = now()
      WHERE tenant_id = $1 AND status = 'active' AND balance_cents - held_cents + credit_limit_cents >= $2
      RETURNING ledger_account_id`,
    [a.tenantId, a.cents],
  );
  if (!w.rows[0]) return false;
  const revenue = await c.query<{ id: string }>(`SELECT id FROM ledger_accounts WHERE tenant_id IS NULL AND code = $1`, [a.revenue]);
  const tx = await c.query<{ id: string }>(
    `INSERT INTO ledger_transactions (tenant_id, kind, reference_type, reference_id, idempotency_key, memo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [a.tenantId, a.kind, a.referenceType, a.referenceId, a.key, a.memo],
  );
  await c.query(`INSERT INTO ledger_entries (transaction_id, account_id, tenant_id, amount_cents) VALUES ($1, $2, $4, $5), ($1, $3, $4, -$5)`, [
    tx.rows[0]!.id,
    w.rows[0].ledger_account_id,
    revenue.rows[0]!.id,
    a.tenantId,
    a.cents,
  ]);
  return true;
}

export class MonitoringScheduler {
  constructor(private readonly d: MonitoringDeps) {}

  async sweep(): Promise<SweepResult> {
    const r: SweepResult = { scheduled: 0, reminded: 0, expired: 0, locked: 0, rechecksQueued: 0, charged: 0, unpaid: 0, renewed: 0, endedUnpaid: 0 };
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        this.d.log.error({ err, step: name }, 'monitoring sweep step failed');
      }
    };
    await step('schedule', async () => {
      r.scheduled = await this.schedule();
    });
    await step('due', () => this.due(r));
    await step('rechecks', async () => {
      r.rechecksQueued = await this.queueRechecks();
    });
    await step('charges', () => this.chargeMonitoring(r));
    await step('modules', () => this.renewModules(r));
    if (Object.values(r).some(Boolean)) this.d.log.info(r, 'monitoring sweep');
    return r;
  }

  // --- 1. What expires ----------------------------------------------------------------------
  private async schedule(): Promise<number> {
    const p = this.d.pool;
    const at = (col: string) => `GREATEST(now(), ((${col} - 30) + time '06:00') AT TIME ZONE 'Africa/Johannesburg')`;
    let n = 0;
    // B-BBEE: the newest accepted evidence the supplier gave the monitoring buyer.
    n += (
      await p.query(
        `INSERT INTO expiry_schedules (tenant_id, tenant_vendor_id, subject_type, subject_id, expires_on, next_action_at, next_action)
         SELECT DISTINCT ON (m.tenant_vendor_id) m.tenant_id, m.tenant_vendor_id, 'bbbee', b.id, b.valid_until, ${at('b.valid_until')}, 'remind'
           FROM monitoring_enrolments m
           JOIN tenant_vendors tv ON tv.id = m.tenant_vendor_id
           JOIN vendor_bbbee_profiles b ON b.vendor_id = tv.vendor_id AND b.status = 'accepted' AND b.tenant_id = m.tenant_id
          WHERE m.period @> now()
          ORDER BY m.tenant_vendor_id, b.valid_until DESC
         ON CONFLICT (tenant_vendor_id, subject_type, subject_id) DO NOTHING`,
      )
    ).rowCount!;
    // Older evidence, once newer evidence is scheduled, no longer needs reminders.
    await p.query(
      `UPDATE expiry_schedules e SET state = 'renewed', next_action_at = NULL, updated_at = now()
         FROM expiry_schedules newer
        WHERE e.subject_type = 'bbbee' AND newer.subject_type = 'bbbee' AND newer.tenant_vendor_id = e.tenant_vendor_id
          AND newer.expires_on > e.expires_on AND newer.state = 'scheduled' AND e.state IN ('scheduled', 'expired')`,
    );
    // Documents with an expiry date (B-BBEE documents are covered by their profile above).
    n += (
      await p.query(
        `INSERT INTO expiry_schedules (tenant_id, tenant_vendor_id, subject_type, subject_id, expires_on, next_action_at, next_action)
         SELECT m.tenant_id, m.tenant_vendor_id, 'document', d.id, d.expires_on, ${at('d.expires_on')}, 'remind'
           FROM monitoring_enrolments m
           JOIN tenant_vendors tv ON tv.id = m.tenant_vendor_id
           JOIN vendor_documents d ON d.vendor_id = tv.vendor_id AND d.tenant_id = m.tenant_id
          WHERE m.period @> now() AND d.expires_on IS NOT NULL AND d.superseded_by IS NULL AND d.purged_at IS NULL
            AND d.review_status <> 'rejected' AND d.document_type NOT LIKE 'bbbee%'
         ON CONFLICT (tenant_vendor_id, subject_type, subject_id) DO NOTHING`,
      )
    ).rowCount!;
    // The annual return: one schedule per supplier, moved on when CIPC shows the next due date.
    n += (
      await p.query(
        `INSERT INTO expiry_schedules (tenant_id, tenant_vendor_id, subject_type, subject_id, expires_on, next_action_at, next_action)
         SELECT m.tenant_id, m.tenant_vendor_id, 'cipc_annual_return', v.id, v.annual_return_due_date, ${at('v.annual_return_due_date')}, 'remind'
           FROM monitoring_enrolments m
           JOIN tenant_vendors tv ON tv.id = m.tenant_vendor_id
           JOIN vendors v ON v.id = tv.vendor_id
          WHERE m.period @> now() AND v.annual_return_due_date IS NOT NULL
         ON CONFLICT (tenant_vendor_id, subject_type, subject_id) DO UPDATE
            SET expires_on = EXCLUDED.expires_on, next_action_at = EXCLUDED.next_action_at, next_action = 'remind',
                reminders_sent = '{}', state = 'scheduled', updated_at = now()
          WHERE expiry_schedules.expires_on <> EXCLUDED.expires_on`,
      )
    ).rowCount!;
    return n;
  }

  // --- 2. Reminders, expiry and the payment lock ---------------------------------------------
  private async due(r: SweepResult): Promise<void> {
    const due = await this.d.pool.query<{ id: string }>(
      `SELECT e.id FROM expiry_schedules e
         JOIN monitoring_enrolments m ON m.tenant_vendor_id = e.tenant_vendor_id AND m.period @> now()
        WHERE e.state = 'scheduled' AND e.next_action_at <= now()
        ORDER BY e.next_action_at LIMIT 200`,
    );
    for (const { id } of due.rows) {
      try {
        const out = await inTx(this.d.pool, (c) => this.act(c, id));
        if (out === 'reminded') r.reminded++;
        if (out === 'expired' || out === 'locked') r.expired++;
        if (out === 'locked') r.locked++;
      } catch (err) {
        this.d.log.error({ err, scheduleId: id }, 'monitoring action failed');
      }
    }
  }

  private async act(c: PoolClient, id: string): Promise<'reminded' | 'expired' | 'locked' | 'skipped'> {
    const s = (
      await c.query<{
        tenant_id: string;
        tenant_vendor_id: string;
        subject_type: string;
        subject_id: string;
        expires_on: string;
        days: number;
        reminders_sent: number[];
        state: string;
        vendor_id: string;
        external_ref: string | null;
        payment_lock_status: string;
        legal_name: string;
        erp_lock_enabled: boolean;
        doc_name: string | null;
      }>(
        `SELECT e.tenant_id, e.tenant_vendor_id, e.subject_type, e.subject_id, e.expires_on, (e.expires_on - current_date) AS days,
                e.reminders_sent, e.state, tv.vendor_id, tv.external_ref, tv.payment_lock_status, v.legal_name, m.erp_lock_enabled,
                (SELECT t.name FROM vendor_documents d JOIN ref_document_types t ON t.code = d.document_type WHERE d.id = e.subject_id) AS doc_name
           FROM expiry_schedules e
           JOIN tenant_vendors tv ON tv.id = e.tenant_vendor_id
           JOIN vendors v ON v.id = tv.vendor_id
           JOIN monitoring_enrolments m ON m.tenant_vendor_id = e.tenant_vendor_id AND m.period @> now()
          WHERE e.id = $1 AND e.state = 'scheduled' AND e.next_action_at <= now()
          FOR UPDATE OF e SKIP LOCKED`,
        [id],
      )
    ).rows[0];
    if (!s) return 'skipped';
    const what = s.subject_type === 'document' && s.doc_name ? `the ${s.doc_name}` : (SUBJECT_LABEL[s.subject_type] ?? 'a document');
    const link = `${this.d.appUrl}/app/suppliers/${s.tenant_vendor_id}`;
    const ref = { supplier_id: s.tenant_vendor_id, vendor_id: s.vendor_id, external_ref: s.external_ref, subject_type: s.subject_type, expires_on: s.expires_on };

    if (s.days > 0) {
      const pending = THRESHOLDS.filter((t) => t >= s.days && !s.reminders_sent.includes(t));
      const next = THRESHOLDS.filter((t) => t < s.days)[0];
      if (pending.length) {
        await enqueueWebhook(c, s.tenant_id, 'document.expiring', s.subject_id, { ...ref, days_left: s.days });
        await mailAdmins(c, s.tenant_id, 'expiry_reminder', { appUrl: this.d.appUrl, supplier: s.legal_name, what: capital(what), day: formatDay(s.expires_on), link });
        await audit(c, system(s.tenant_id, 'monitoring.reminder_sent', 'expiry_schedule', id, { subject_type: s.subject_type, days_left: s.days }));
      }
      // Next: the following reminder, or the expiry itself (06:00 SAST on the day).
      await c.query(
        `UPDATE expiry_schedules SET reminders_sent = reminders_sent || $2::integer[], next_action = $3,
                next_action_at = ((expires_on - $4::integer) + time '06:00') AT TIME ZONE 'Africa/Johannesburg', updated_at = now()
          WHERE id = $1`,
        [id, pending, next ? 'remind' : 'expire', next ?? 0],
      );
      return pending.length ? 'reminded' : 'skipped';
    }

    // It expired today (or earlier, if monitoring started late).
    let locked = false;
    if (s.erp_lock_enabled && s.payment_lock_status === 'unlocked') {
      const reason = `${capital(what)} expired on ${formatDay(s.expires_on)}.`;
      await c.query(`UPDATE tenant_vendors SET payment_lock_status = 'locked', payment_lock_reason = $2 WHERE id = $1`, [s.tenant_vendor_id, reason]);
      await enqueueWebhook(c, s.tenant_id, 'vendor.payment_locked', s.tenant_vendor_id, { ...ref, reason, source: 'monitoring' });
      await audit(c, system(s.tenant_id, 'payments.locked', 'tenant_vendor', s.tenant_vendor_id, { from: 'unlocked', reason, source: 'monitoring' }));
      locked = true;
    }
    await c.query(`UPDATE expiry_schedules SET state = $2, next_action = NULL, next_action_at = NULL, updated_at = now() WHERE id = $1`, [id, locked ? 'locked' : 'expired']);
    await enqueueWebhook(c, s.tenant_id, 'document.expired', s.subject_id, ref);
    await mailAdmins(c, s.tenant_id, 'expired', {
      appUrl: this.d.appUrl,
      supplier: s.legal_name,
      what: capital(what),
      day: formatDay(s.expires_on),
      link,
      change: locked ? 'Payments to the supplier are locked in your accounting system until it is renewed.' : null,
    });
    await audit(c, system(s.tenant_id, 'monitoring.expired', 'expiry_schedule', id, { subject_type: s.subject_type, payments_locked: locked }));
    return locked ? 'locked' : 'expired';
  }

  // --- 3. Weekly re-checks ------------------------------------------------------------------
  private async queueRechecks(): Promise<number> {
    const r = await this.d.pool.query<{ tenant_id: string; tenant_vendor_id: string }>(
      `SELECT m.tenant_id, m.tenant_vendor_id
         FROM monitoring_enrolments m
         JOIN tenant_vendors tv ON tv.id = m.tenant_vendor_id
         JOIN vendors v ON v.id = tv.vendor_id
        WHERE m.period @> now() AND v.cipc_enterprise_number IS NOT NULL AND tv.status NOT IN ('rejected', 'offboarded')
          AND NOT EXISTS (SELECT 1 FROM verifications x WHERE x.tenant_vendor_id = m.tenant_vendor_id AND x.verification_type = 'company'
                                                          AND x.requested_at > now() - interval '7 days')
        LIMIT 100`,
    );
    for (const x of r.rows) await this.d.queueRecheck(x.tenant_id, x.tenant_vendor_id);
    return r.rows.length;
  }

  /** One re-check (the monitoring queue): the register again; a changed result is reported. */
  async recheck(tenantId: string, tenantVendorId: string): Promise<'checked' | 'changed' | 'skipped'> {
    const cur = (
      await this.d.pool.query<{ reg: string | null; previous: string | null; legal_name: string; vendor_id: string; external_ref: string | null }>(
        `SELECT v.cipc_enterprise_number AS reg, v.legal_name, v.id AS vendor_id, tv.external_ref,
                (SELECT x.outcome FROM verifications x WHERE x.tenant_vendor_id = tv.id AND x.verification_type = 'company' AND x.status = 'completed'
                  ORDER BY x.completed_at DESC LIMIT 1) AS previous
           FROM tenant_vendors tv JOIN vendors v ON v.id = tv.vendor_id
          WHERE tv.id = $1 AND tv.tenant_id = $2
            AND EXISTS (SELECT 1 FROM monitoring_enrolments m WHERE m.tenant_vendor_id = tv.id AND m.period @> now())`,
        [tenantVendorId, tenantId],
      )
    ).rows[0];
    if (!cur?.reg) return 'skipped';
    let started: { verificationId: string; done: boolean };
    try {
      started = await this.d.company.start(
        { tenantId, apiKeyId: null, userId: null, environment: this.d.environment, scopes: [] },
        {
          registrationNumber: cur.reg,
          vatNumber: null,
          taxReferenceNumber: null,
          tcsPin: null,
          checks: ['registration', 'directors'],
          externalRef: null,
          consentId: null,
          consentAttestation: null,
          freshness: 'live',
          maxAgeSeconds: null,
          mode: 'sync',
          monitor: false,
          sku: 'MONITORING_RECHECK',
        },
        `monitoring-${tenantVendorId}`,
      );
    } catch (err) {
      // A buyer that requires recorded consent for every check, without it: nothing to do here.
      if (err instanceof ApiError && err.code === 'consent_required') return 'skipped';
      throw err;
    }
    if (!started.done) return 'checked';
    const v = await loadVerification(this.d.pool, tenantId, started.verificationId);
    if (!cur.previous || !v?.outcome || v.outcome === cur.previous) return 'checked';
    await inTx(this.d.pool, async (c) => {
      const data = { supplier_id: tenantVendorId, vendor_id: cur.vendor_id, external_ref: cur.external_ref, previous_outcome: cur.previous, outcome: v.outcome, verification_id: started.verificationId };
      await enqueueWebhook(c, tenantId, 'vendor.compliance_changed', tenantVendorId, data);
      await mailAdmins(c, tenantId, 'compliance_changed', {
        appUrl: this.d.appUrl,
        supplier: cur.legal_name,
        change: `The result was "${String(cur.previous).replace(/_/g, ' ')}" and is now "${String(v.outcome).replace(/_/g, ' ')}".`,
        link: `${this.d.appUrl}/app/checks/${started.verificationId}`,
      });
      await audit(c, system(tenantId, 'monitoring.compliance_changed', 'tenant_vendor', tenantVendorId, { previous: cur.previous, outcome: v.outcome }));
    });
    return 'changed';
  }

  // --- 4. The monthly monitoring fee ----------------------------------------------------------
  private async chargeMonitoring(r: SweepResult): Promise<void> {
    // Each enrolment pays per month from the day it started; the month's ledger key makes it once.
    const due = await this.d.pool.query<{ id: string; tenant_id: string; tenant_vendor_id: string; unpaid_since: string | null; legal_name: string; period_start: string }>(
      `WITH m AS (
         SELECT m.id, m.tenant_id, m.tenant_vendor_id, m.unpaid_since, v.legal_name,
                (lower(m.period) + make_interval(months => (extract(year FROM age(now(), lower(m.period))) * 12
                                                          + extract(month FROM age(now(), lower(m.period))))::integer))::date AS period_start
           FROM monitoring_enrolments m JOIN tenant_vendors tv ON tv.id = m.tenant_vendor_id JOIN vendors v ON v.id = tv.vendor_id
          WHERE m.period @> now())
       SELECT * FROM m WHERE NOT EXISTS (SELECT 1 FROM ledger_transactions t WHERE t.idempotency_key = 'monitoring:' || m.id || ':' || m.period_start)
       LIMIT 500`,
    );
    for (const m of due.rows) {
      try {
        await inTx(this.d.pool, async (c) => {
          const cents = await priceFor(c, m.tenant_id, 'MONITORING_PER_VENDOR', 'live');
          const paid = await charge(c, {
            tenantId: m.tenant_id,
            cents,
            kind: 'monitoring_charge',
            revenue: 'revenue_monitoring',
            referenceType: 'monitoring_enrolment',
            referenceId: m.id,
            key: `monitoring:${m.id}:${m.period_start}`,
            memo: `Monitoring ${m.legal_name}, month from ${m.period_start}`,
          });
          if (paid) {
            await c.query(`UPDATE monitoring_enrolments SET unpaid_since = NULL WHERE id = $1`, [m.id]);
            await audit(c, system(m.tenant_id, 'monitoring.charged', 'tenant_vendor', m.tenant_vendor_id, { cents, month_from: m.period_start }));
            r.charged++;
            return;
          }
          r.unpaid++;
          const since = (await c.query<{ since: string; first: boolean }>(
            `UPDATE monitoring_enrolments SET unpaid_since = coalesce(unpaid_since, current_date) WHERE id = $1
             RETURNING unpaid_since::text AS since, $2::date IS NULL AS first`,
            [m.id, m.unpaid_since],
          )).rows[0]!;
          if (since.first) {
            const until = (await c.query<{ d: string }>(`SELECT (current_date + $1::integer)::text AS d`, [GRACE_DAYS])).rows[0]!.d;
            await mailAdmins(c, m.tenant_id, 'monitoring_unpaid', { appUrl: this.d.appUrl, supplier: m.legal_name, amount: rands(cents), day: formatDay(until) });
            await audit(c, system(m.tenant_id, 'monitoring.unpaid', 'tenant_vendor', m.tenant_vendor_id, { cents }));
          } else if (since.since <= (await c.query<{ d: string }>(`SELECT (current_date - $1::integer)::text AS d`, [GRACE_DAYS])).rows[0]!.d) {
            await c.query(`UPDATE monitoring_enrolments SET period = tstzrange(lower(period), now()) WHERE id = $1`, [m.id]);
            await audit(c, system(m.tenant_id, 'monitoring.ended_unpaid', 'tenant_vendor', m.tenant_vendor_id, { unpaid_since: since.since }));
            r.endedUnpaid++;
          }
        });
      } catch (err) {
        this.d.log.error({ err, enrolmentId: m.id }, 'monitoring charge failed');
      }
    }
  }

  // --- 5. Module renewals ---------------------------------------------------------------------
  private async renewModules(r: SweepResult): Promise<void> {
    const due = await this.d.pool.query<{ id: string }>(
      `SELECT id FROM subscriptions WHERE status IN ('active', 'past_due') AND current_period_end <= current_date LIMIT 500`,
    );
    for (const { id } of due.rows) {
      try {
        await inTx(this.d.pool, async (c) => {
          const s = (
            await c.query<{ tenant_id: string; sku: string; status: string; current_period_end: string; cancel_at: string | null; past_due_since: string | null; name: string; renew_from: string; today: string }>(
              `SELECT s.tenant_id, s.sku, s.status, s.current_period_end::text, s.cancel_at::text, s.past_due_since::text,
                      coalesce((SELECT p.description FROM price_book p WHERE p.sku = s.sku ORDER BY p.effective_from DESC LIMIT 1), s.sku) AS name,
                      GREATEST(s.current_period_end, current_date)::text AS renew_from, current_date::text AS today
                 FROM subscriptions s WHERE s.id = $1 AND s.status IN ('active', 'past_due') AND s.current_period_end <= current_date
                 FOR UPDATE SKIP LOCKED`,
              [id],
            )
          ).rows[0];
          if (!s) return;
          if (s.cancel_at && s.cancel_at <= s.current_period_end) {
            await c.query(`UPDATE subscriptions SET status = 'cancelled' WHERE id = $1`, [id]);
            await audit(c, system(s.tenant_id, 'module.ended', 'subscription', id, { sku: s.sku }));
            return;
          }
          const cents = await priceFor(c, s.tenant_id, s.sku, 'live');
          const paid = await charge(c, {
            tenantId: s.tenant_id,
            cents,
            kind: 'subscription_charge',
            revenue: 'revenue_subscription',
            referenceType: 'subscription',
            referenceId: id,
            key: `subscription:${id}:${s.renew_from}`,
            memo: `${s.sku} from ${s.renew_from}`,
          });
          if (paid) {
            await c.query(
              `UPDATE subscriptions SET status = 'active', unit_price_cents = $2, current_period_start = $3::date,
                      current_period_end = ($3::date + interval '1 month')::date, past_due_since = NULL WHERE id = $1`,
              [id, cents, s.renew_from],
            );
            await audit(c, system(s.tenant_id, 'module.renewed', 'subscription', id, { sku: s.sku, cents }));
            r.renewed++;
            return;
          }
          r.unpaid++;
          if (!s.past_due_since) {
            await c.query(`UPDATE subscriptions SET status = 'past_due', past_due_since = current_date WHERE id = $1`, [id]);
            const until = (await c.query<{ d: string }>(`SELECT (current_date + $1::integer)::text AS d`, [GRACE_DAYS])).rows[0]!.d;
            await mailAdmins(c, s.tenant_id, 'module_unpaid', { appUrl: this.d.appUrl, what: s.name, amount: rands(cents), day: formatDay(until) });
            await audit(c, system(s.tenant_id, 'module.past_due', 'subscription', id, { sku: s.sku, cents }));
          } else if (s.past_due_since <= (await c.query<{ d: string }>(`SELECT (current_date - $1::integer)::text AS d`, [GRACE_DAYS])).rows[0]!.d) {
            await c.query(`UPDATE subscriptions SET status = 'cancelled' WHERE id = $1`, [id]);
            await audit(c, system(s.tenant_id, 'module.ended_unpaid', 'subscription', id, { sku: s.sku, past_due_since: s.past_due_since }));
            r.endedUnpaid++;
          }
        });
      } catch (err) {
        this.d.log.error({ err, subscriptionId: id }, 'module renewal failed');
      }
    }
  }
}
