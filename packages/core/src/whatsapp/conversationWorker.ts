import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { parseEnterpriseNumber } from '../domain/sa/cipc';
import { audit } from '../audit/audit';
import { ConsentService } from '../consent/consentService';
import { sha256, type Crypto } from '../lib/crypto';
import type { Logger } from '../lib/logger';
import type { RedisClient } from '../lib/redis';
import type { DocumentExtractor, ExpectedKind } from '../ocr/extractor';
import { postValidate } from '../ocr/postValidate';
import type { CheckResolver } from '../services/checkResolver';
import type { CompanyVerificationService } from '../services/companyVerification';
import type { GraphClient } from './graphClient';
import { render } from './messages';
import { Action, ConversationData, Event, Requirements, Snapshot, State, transition } from './stateMachine';
import type { WaInboundMessage } from './inbound';
import { WA_STREAM } from './inbound';

/** Encrypted object storage (S3 af-south-1 + SSE-KMS in production). */
export interface ObjectStore {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface WorkerDeps {
  pool: Pool; // tshepovet_worker role (BYPASSRLS): conversations span tenants until resolved
  redis: RedisClient;
  crypto: Crypto;
  log: Logger;
  graph: GraphClient;
  store: ObjectStore;
  extractor: Pick<DocumentExtractor, 'extract'>;
  resolver: CheckResolver;
  company: CompanyVerificationService;
  consent: ConsentService;
  passportBaseUrl: string;
  secureLinkBaseUrl: string;
}

interface ConversationRow {
  id: string;
  tenant_id: string;
  tenant_vendor_id: string | null;
  vendor_id: string | null;
  msisdn_enc: Buffer;
  state: State;
  state_data: ConversationData;
  consent_id: string | null;
  last_inbound_at: Date | null;
  version: number;
  buyer_name: string;
  settings: { whatsapp_requirements?: Partial<Requirements>; whatsapp_api_key_id?: string; monitor_on_onboarding?: boolean };
}

const DOC_TYPE_FOR: Record<ExpectedKind, string> = { identity: 'sa_smart_id_card', driver_licence: 'driver_licence_card', bbbee: 'bbbee_eme_affidavit' };

export function toEvent(m: WaInboundMessage): Event | null {
  switch (m.type) {
    case 'text':
      return m.text ? { type: 'text', text: m.text.body, messageId: m.id } : null;
    case 'interactive':
      if (m.interactive?.type === 'button_reply') return { type: 'button', id: m.interactive.button_reply.id, messageId: m.id };
      if (m.interactive?.type === 'list_reply') return { type: 'button', id: m.interactive.list_reply.id, messageId: m.id };
      return null;
    case 'button':
      return m.button ? { type: 'button', id: m.button.payload, messageId: m.id } : null;
    case 'image':
      return m.image ? { type: 'media', mediaId: m.image.id, mimeType: m.image.mime_type, messageId: m.id } : null;
    case 'document':
      return m.document ? { type: 'media', mediaId: m.document.id, mimeType: m.document.mime_type, messageId: m.id } : null;
    default:
      return { type: 'media', mediaId: '', mimeType: 'unsupported', messageId: m.id };
  }
}

const GROUP = 'conversation-workers';

export class ConversationWorker {
  constructor(private readonly d: WorkerDeps) {}

  /**
   * Consume the inbound stream with a consumer group (at-least-once; handlers are idempotent
   * per wamid). `redis` must be a connection of its own: XREADGROUP BLOCK holds it.
   */
  async run(consumer: string, signal: AbortSignal, redis = this.d.redis) {
    await redis.xgroup('CREATE', WA_STREAM, GROUP, '0', 'MKSTREAM').catch(() => undefined);
    while (!signal.aborted) {
      const res = (await redis.xreadgroup('GROUP', GROUP, consumer, 'COUNT', 20, 'BLOCK', 2000, 'STREAMS', WA_STREAM, '>')) as
        | Array<[string, Array<[string, string[]]>]>
        | null;
      for (const [, entries] of res ?? []) await this.handleEntries(entries);
    }
  }

  /** Messages a worker took but never acknowledged (it crashed): the watchdog hands them on. */
  async reclaimStale(consumer: string, minIdleMs = 5 * 60_000): Promise<number> {
    await this.d.redis.xgroup('CREATE', WA_STREAM, GROUP, '0', 'MKSTREAM').catch(() => undefined);
    const r = (await this.d.redis.xautoclaim(WA_STREAM, GROUP, consumer, minIdleMs, '0-0', 'COUNT', 50)) as [string, Array<[string, string[]] | null>];
    const entries = (r?.[1] ?? []).filter((e): e is [string, string[]] => Array.isArray(e));
    await this.handleEntries(entries);
    return entries.length;
  }

  private async handleEntries(entries: Array<[string, string[]]>) {
    for (const [id, fields] of entries) {
      const f = Object.fromEntries(fields.reduce<[string, string][]>((acc, v, i, a) => (i % 2 === 0 ? [...acc, [v, a[i + 1]!]] : acc), []));
      try {
        if (f.kind === 'message') await this.handleInbound(JSON.parse(f.payload!) as WaInboundMessage);
        await this.d.redis.xack(WA_STREAM, GROUP, id);
      } catch (err) {
        // Left un-acked: the watchdog reclaims it after the idle timeout (reclaimStale).
        this.d.log.error({ err, streamId: id }, 'conversation handler failed');
      }
    }
  }

  async handleInbound(m: WaInboundMessage) {
    const dedupe = await this.d.pool.query(`INSERT INTO wa_inbound_messages (wa_message_id, message_type, media_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [
      m.id,
      m.type,
      m.image?.id ?? m.document?.id ?? null,
    ]);
    if (!dedupe.rowCount) return;

    const msisdnBidx = this.d.crypto.blindIndex('msisdn', m.from);
    const conv = await this.load(msisdnBidx);
    if (!conv) {
      // Unknown number: TshepoVet only onboards vendors a buyer invited.
      await this.d.graph.sendText(m.from, 'Hi! This number is used by TshepoVet for supplier onboarding by invitation. Please ask the buyer to send you an invite link.');
      return;
    }
    await this.d.pool.query(`UPDATE wa_conversations SET last_inbound_at = now() WHERE id = $1`, [conv.id]);
    await this.d.pool.query(`UPDATE wa_inbound_messages SET conversation_id = $2 WHERE wa_message_id = $1`, [m.id, conv.id]);
    const event = toEvent(m);
    if (event) await this.apply(conv, m.from, event, true);
  }

  private async load(msisdnBidx: Buffer): Promise<ConversationRow | undefined> {
    const r = await this.d.pool.query<ConversationRow>(
      `SELECT c.*, t.legal_name AS buyer_name, t.settings
         FROM wa_conversations c JOIN tenants t ON t.id = c.tenant_id
        WHERE c.msisdn_bidx = $1 AND c.state NOT IN ('COMPLETED','ABANDONED','OPTED_OUT') AND c.expires_at > now()
        ORDER BY c.updated_at DESC LIMIT 1`,
      [msisdnBidx],
    );
    return r.rows[0];
  }

  private snapshot(c: ConversationRow, inboundNow: boolean): Snapshot {
    const req = c.settings.whatsapp_requirements ?? {};
    return {
      state: c.state,
      data: { ...c.state_data, retries: c.state_data.retries ?? 0 },
      requirements: { driverLicence: Boolean(req.driverLicence), bbbee: req.bbbee ?? true, tcs: req.tcs ?? true },
      buyerName: c.buyer_name,
      withinServiceWindow: inboundNow || (c.last_inbound_at !== null && Date.now() - c.last_inbound_at.getTime() < 24 * 3_600_000),
    };
  }

  /** Run one transition, persist it with optimistic locking, then execute its actions. */
  async apply(c: ConversationRow, to: string, event: Event, inboundNow = false): Promise<void> {
    const result = transition(this.snapshot(c, inboundNow), event);
    const upd = await this.d.pool.query(
      `UPDATE wa_conversations SET state = $2, state_data = $3, version = version + 1, updated_at = now()
        WHERE id = $1 AND version = $4`,
      [c.id, result.state, JSON.stringify(result.data), c.version],
    );
    if (!upd.rowCount) throw new Error('conversation modified concurrently; retry');
    const next: ConversationRow = { ...c, state: result.state, state_data: result.data, version: c.version + 1 };
    for (const a of result.actions) await this.execute(next, to, a);
  }

  private async execute(c: ConversationRow, to: string, a: Action): Promise<void> {
    const vars = { buyer: c.buyer_name, ...('vars' in a ? a.vars : {}) };
    switch (a.type) {
      case 'send_text':
        await this.d.graph.sendText(to, render(a.key, vars));
        return;
      case 'send_buttons':
        await this.d.graph.sendButtons(to, render(a.key, vars), a.buttons);
        return;
      case 'send_list':
        await this.d.graph.sendList(to, render(a.key, vars), a.button, a.rows);
        return;
      case 'send_template':
        await this.d.graph.sendTemplate(to, a.template, 'en', Object.values(a.vars));
        return;
      case 'send_secure_link': {
        // Single-use, 30-minute token; the web form posts PIN + tax reference
        // over TLS straight to the API, which emits a `tcs_captured` event.
        const token = randomBytes(24).toString('base64url');
        await this.d.redis.set(`tv:wa:link:${token}`, c.id, 'EX', 1800);
        await this.d.graph.sendText(to, `${this.d.secureLinkBaseUrl}/tcs/${token}`);
        return;
      }
      case 'record_consent':
        return this.recordConsent(c, to, a.messageId, a.purposes);
      case 'withdraw_consent':
        if (c.consent_id) await this.withTenant(c.tenant_id, (cl) => this.d.consent.withdraw(cl, c.consent_id!, 'all', 'whatsapp_stop'));
        return;
      case 'lookup_company':
        return this.lookupCompany(c, to, a.registrationNumber);
      case 'run_ocr':
        return this.runOcr(c, to, a.kind, a.mediaId);
      case 'store_tcs_pin':
        // Short-lived, encrypted, referenced by conversation id; consumed at submit.
        await this.d.redis.set(`tv:wa:tcs:${c.id}:pin`, await this.d.crypto.encrypt(a.pin, `wa_tcs:${c.id}`), 'EX', 14 * 86_400);
        return;
      case 'store_tax_reference':
        await this.d.redis.set(`tv:wa:tcs:${c.id}:ref`, await this.d.crypto.encrypt(a.taxReference, `wa_taxref:${c.id}`), 'EX', 14 * 86_400);
        return;
      case 'submit_verification':
        return this.submit(c, to);
      case 'handoff':
        await this.withTenant(c.tenant_id, (cl) =>
          audit(cl, { tenantId: c.tenant_id, actorType: 'system', actorId: 'whatsapp_bot', action: 'whatsapp.handoff', entityType: 'wa_conversation', entityId: c.id, details: { reason: a.reason, state: c.state } }),
        );
        return;
    }
  }

  private async withTenant<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.d.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const r = await fn(client);
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  private async recordConsent(c: ConversationRow, to: string, messageId: string, purposes: string[]) {
    const consentId = await this.withTenant(c.tenant_id, async (cl) => {
      const notice = await cl.query<{ id: string; body_sha256: Buffer }>(
        `SELECT id, body_sha256 FROM privacy_notices WHERE code = 'vendor_onboarding' AND channel = 'whatsapp' AND language = 'en' AND retired_at IS NULL ORDER BY version DESC LIMIT 1`,
      );
      const n = notice.rows[0]!;
      const evidence = { wa_message_id: messageId, button_id: 'consent_yes', msisdn_masked: `*******${to.slice(-4)}`, captured_at: new Date().toISOString(), purposes };
      const r = await cl.query<{ id: string }>(
        `INSERT INTO consent_records (tenant_id, vendor_id, subject_type, subject_role, subject_display, notice_id, capture_method, evidence, evidence_sha256, purge_after)
         VALUES ($1, $2, 'natural_person', 'authorised_representative', $3, $4, 'whatsapp_button', $5, $6, now() + interval '5 years') RETURNING id`,
        [c.tenant_id, c.vendor_id, evidence.msisdn_masked, n.id, JSON.stringify(evidence), sha256(Buffer.concat([Buffer.from(JSON.stringify(evidence)), n.body_sha256]))],
      );
      for (const p of purposes) {
        await cl.query(`INSERT INTO consent_purposes (consent_id, tenant_id, purpose, lawful_basis, special_pi_basis) VALUES ($1, $2, $3, 'consent', $4)`, [
          r.rows[0]!.id,
          c.tenant_id,
          p,
          p === 'bbbee_verification' ? 's29_bbbee_redress' : null,
        ]);
      }
      return r.rows[0]!.id;
    });
    await this.d.pool.query(`UPDATE wa_conversations SET consent_id = $2 WHERE id = $1`, [c.id, consentId]);
    c.consent_id = consentId;
  }

  private async lookupCompany(c: ConversationRow, to: string, registrationNumber: string) {
    const r = await this.d.resolver.resolve('company_registration', registrationNumber, { enterpriseNumber: registrationNumber }, {
      tenantId: c.tenant_id,
      freshness: 'cached_ok',
      deadlineAt: Date.now() + 8000,
      costCeilingCents: 240,
    });
    if (r.status === 'found' && r.data) {
      const p = parseEnterpriseNumber(registrationNumber);
      await this.linkVendor(c, (
        await this.d.pool.query<{ id: string }>(`SELECT resolve_vendor_by_cipc($1, $2, $3, $4) AS id`, [p.normalised, p.typeName ? p.typeCode : null, p.entityKind, r.data.legalName])
      ).rows[0]!.id);
    }
    const fresh = await this.reload(c.id);
    await this.apply(fresh, to, {
      type: 'company_lookup_result',
      found: r.status === 'found',
      legalName: r.data?.legalName,
      statusLabel: r.data?.statusRaw,
    });
  }

  private async runOcr(c: ConversationRow, to: string, kind: ExpectedKind, mediaId: string) {
    const { bytes, mimeType } = await this.d.graph.downloadMedia(mediaId);
    const sha = sha256(bytes);
    const storageKey = `tenants/${c.tenant_id}/wa/${c.id}/${sha.toString('hex')}`;
    await this.d.store.put(storageKey, bytes, mimeType);

    const extraction = await this.d.extractor.extract(bytes, kind);
    let outcome: Extract<Event, { type: 'ocr_result' }>['outcome'] = 'needs_review';
    let detail = '';
    let idLast4: string | undefined;
    let isListedDirector: boolean | undefined;
    let bbbeeDecision: 'accept' | 'reject' | 'manual_review' | undefined;
    let extractedEnc: Buffer | null = null;
    // Why a person should look at it (the staff review queue shows these).
    let reviewFlags: string[] = [];

    if (extraction.status === 'rejected_input') {
      outcome = 'retake';
      detail = extraction.reason.replace(/_/g, ' ');
    } else if (extraction.status === 'ok') {
      const thresholds = await this.d.pool.query(
        `SELECT sector_code, eme_max_turnover_cents, qse_max_turnover_cents, verified FROM ref_bbbee_thresholds
          WHERE sector_code = 'generic' AND effective_from <= current_date AND (effective_to IS NULL OR effective_to >= current_date)
          ORDER BY effective_from DESC LIMIT 1`,
      );
      const t = thresholds.rows[0];
      const v = postValidate(extraction.extraction, kind, {
        bbbeeThresholds: t ? { sectorCode: t.sector_code, emeMaxTurnoverCents: Number(t.eme_max_turnover_cents), qseMaxTurnoverCents: Number(t.qse_max_turnover_cents), verified: t.verified } : null,
      });
      outcome = v.outcome;
      detail = v.detail;
      reviewFlags = v.flags;
      if (v.identity) {
        idLast4 = v.identity.idNumber.slice(-4);
        if (!c.vendor_id && c.state_data.entityKind === 'sole_proprietor') {
          // Sole proprietors: the owner's SA ID is the vendor's anchor identifier.
          const name = [v.identity.forenames, v.identity.surname].filter(Boolean).join(' ') || 'SOLE PROPRIETOR';
          const vid = await this.d.pool.query<{ id: string }>(`SELECT resolve_vendor_sole_proprietor($1, $2, $3) AS id`, [
            this.d.crypto.blindIndex('sa_id', v.identity.idNumber),
            await this.d.crypto.encrypt(v.identity.idNumber, 'sole_prop_owner_id'),
            name,
          ]);
          await this.linkVendor(c, vid.rows[0]!.id);
        }
        if (c.vendor_id) {
          const bidx = this.d.crypto.blindIndex('sa_id', v.identity.idNumber);
          const dir = await this.d.pool.query(`SELECT 1 FROM vendor_directors WHERE vendor_id = $1 AND id_number_bidx = $2 AND status = 'active'`, [c.vendor_id, bidx]);
          isListedDirector = Boolean(dir.rowCount);
        }
      }
      bbbeeDecision = v.bbbee?.decision;
      extractedEnc = await this.d.crypto.encrypt(JSON.stringify({ extraction: extraction.extraction, validation: { flags: v.flags, outcome: v.outcome } }), `doc_fields:${c.tenant_id}`);
    }

    const doc = await this.withTenant(c.tenant_id, async (cl) => {
      if (!c.vendor_id) return null;
      const r = await cl.query<{ id: string }>(
        `INSERT INTO vendor_documents (vendor_id, tenant_id, document_type, storage_key, sha256, mime_type, size_bytes, source_channel,
                                       extracted_fields_enc, extraction_model, review_status, review_flags, image_purge_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'whatsapp', $8, $9, $10, $11,
                 now() + make_interval(days => (SELECT image_retention_days FROM ref_document_types WHERE code = $3)))
         RETURNING id`,
        [
          c.vendor_id,
          c.tenant_id,
          DOC_TYPE_FOR[kind],
          storageKey,
          sha,
          mimeType,
          bytes.length,
          extractedEnc,
          extraction.status === 'ok' ? extraction.model : null,
          outcome === 'ok' ? 'auto_accepted' : outcome === 'needs_review' ? 'needs_review' : 'rejected',
          reviewFlags,
        ],
      );
      return r.rows[0]!.id;
    });

    const fresh = await this.reload(c.id);
    // needs_review does not block the vendor: the buyer's team reviews in the portal.
    await this.apply(fresh, to, {
      type: 'ocr_result',
      kind,
      documentId: doc ?? '',
      outcome: outcome === 'needs_review' ? 'ok' : outcome,
      detail,
      idNumberLast4: idLast4,
      isListedDirector,
      bbbeeDecision,
    });
  }

  private async submit(c: ConversationRow, to: string) {
    const keyId = c.settings.whatsapp_api_key_id;
    if (!keyId || !c.state_data.registrationNumber) {
      await this.execute(c, to, { type: 'handoff', reason: keyId ? 'no_registration_number' : 'tenant_missing_channel_key' });
      return;
    }
    const pinBlob = await this.d.redis.getBuffer(`tv:wa:tcs:${c.id}:pin`);
    const refBlob = await this.d.redis.getBuffer(`tv:wa:tcs:${c.id}:ref`);
    const pin = pinBlob ? await this.d.crypto.decryptString(pinBlob, `wa_tcs:${c.id}`) : null;
    const ref = refBlob ? await this.d.crypto.decryptString(refBlob, `wa_taxref:${c.id}`) : null;

    const { verificationId, done } = await this.d.company.start(
      { tenantId: c.tenant_id, apiKeyId: keyId, environment: 'live', scopes: ['verify:write'] },
      {
        registrationNumber: c.state_data.registrationNumber,
        vatNumber: null,
        taxReferenceNumber: ref,
        tcsPin: pin,
        checks: pin && ref ? ['registration', 'directors', 'tcs'] : ['registration', 'directors'],
        externalRef: null,
        consentId: c.consent_id,
        consentAttestation: null,
        freshness: 'cached_ok',
        maxAgeSeconds: null,
        mode: 'sync',
        monitor: Boolean(c.settings.monitor_on_onboarding),
      },
      `wa_${c.id}`,
    );
    await this.d.redis.del(`tv:wa:tcs:${c.id}:pin`, `tv:wa:tcs:${c.id}:ref`);

    const v = await this.d.pool.query<{ outcome: string | null; passport_public_id: string }>(
      `SELECT v.outcome, vd.passport_public_id FROM verifications v JOIN vendors vd ON vd.id = v.vendor_id WHERE v.id = $1`,
      [verificationId],
    );
    if (done && v.rows[0]) {
      const fresh = await this.reload(c.id);
      await this.apply(fresh, to, {
        type: 'verification_result',
        outcome: (v.rows[0].outcome ?? 'processing').replace(/_/g, ' '),
        passportUrl: `${this.d.passportBaseUrl}/${v.rows[0].passport_public_id}`,
      });
    }
    // If not done, the verification.completed outbox event is fanned out to an
    // internal subscriber that calls apply() with the result.
  }

  private async linkVendor(c: ConversationRow, vendorId: string) {
    const tv = await this.d.pool.query<{ id: string }>(
      `INSERT INTO tenant_vendors (tenant_id, vendor_id, onboarding_channel, status) VALUES ($1, $2, 'whatsapp', 'onboarding')
       ON CONFLICT (tenant_id, vendor_id) DO UPDATE SET status = tenant_vendors.status RETURNING id`,
      [c.tenant_id, vendorId],
    );
    await this.d.pool.query(`UPDATE wa_conversations SET vendor_id = $2, tenant_vendor_id = $3 WHERE id = $1`, [c.id, vendorId, tv.rows[0]!.id]);
    await this.d.pool.query(`UPDATE consent_records SET vendor_id = $2 WHERE id = $1 AND vendor_id IS NULL`, [c.consent_id, vendorId]);
    c.vendor_id = vendorId;
    c.tenant_vendor_id = tv.rows[0]!.id;
  }

  private async reload(id: string): Promise<ConversationRow> {
    const r = await this.d.pool.query<ConversationRow>(
      `SELECT c.*, t.legal_name AS buyer_name, t.settings FROM wa_conversations c JOIN tenants t ON t.id = c.tenant_id WHERE c.id = $1`,
      [id],
    );
    return r.rows[0]!;
  }
}
