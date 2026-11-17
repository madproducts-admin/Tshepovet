import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiError, SANDBOX_SAMPLES, WA_STREAM, type WaInboundMessage } from '@tshepovet/core';
import { WaSendSchema, WaStartSchema } from '@tshepovet/contracts';
import { CONTAINER, type Container } from '../container';
import { StaffGuard } from '../portal/guards';
import { utcInstants, uuidParam } from '../portal/tenant';
import { inStaff, staffAudit } from './common';

const MSISDN_AAD = 'wa_msisdn';

/**
 * The WhatsApp simulator (sandbox only, docs/PLAN.md M8): staff play the supplier's phone.
 * Starting a conversation records the invitation the bot would send; each message staff send
 * goes onto the same Redis stream the Meta webhook feeds, so the real conversation worker
 * answers it, and its replies come back through the sandbox Graph client.
 */
@Controller('api/staff/whatsapp')
@UseGuards(StaffGuard)
export class StaffSimulatorController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  private sandboxOnly() {
    if (this.c.config.SANDBOX !== 'true') throw new ApiError(404, 'not_found', 'The WhatsApp simulator is only in the sandbox.');
  }

  private async number(enc: Buffer): Promise<string> {
    return this.c.crypto.decryptString(enc, MSISDN_AAD);
  }

  @Get()
  async list() {
    this.sandboxOnly();
    const rows = await inStaff(this.c, async (db) =>
      (
        await db.query<{ id: string; tenant: string; msisdn_enc: Buffer; state: string; updated_at: Date; expires_at: Date }>(
          `SELECT c.id, t.legal_name AS tenant, c.msisdn_enc, c.state, c.updated_at, c.expires_at
             FROM wa_conversations c JOIN tenants t ON t.id = c.tenant_id ORDER BY c.updated_at DESC LIMIT 100`,
        )
      ).rows,
    );
    return Promise.all(rows.map(async ({ msisdn_enc, ...r }) => ({ ...r, number: await this.number(msisdn_enc).catch(() => 'unknown') })));
  }

  @Get('tenants')
  async tenants() {
    this.sandboxOnly();
    return inStaff(this.c, async (db) => (await db.query(`SELECT id, legal_name FROM tenants WHERE status = 'active' ORDER BY legal_name LIMIT 500`)).rows);
  }

  @Post()
  @HttpCode(201)
  async start(@Req() req: Request, @Body() body: unknown) {
    this.sandboxOnly();
    const b = WaStartSchema.parse(body);
    const bidx = this.c.crypto.blindIndex('msisdn', b.number);
    const enc = await this.c.crypto.encrypt(b.number, MSISDN_AAD);
    return inStaff(this.c, async (db) => {
      const t = (await db.query<{ legal_name: string; status: string }>(`SELECT legal_name, status FROM tenants WHERE id = $1`, [b.tenant_id])).rows[0];
      if (!t) throw new ApiError(404, 'not_found', 'That tenant was not found.');
      if (t.status !== 'active') throw new ApiError(409, 'tenant_inactive', 'That tenant is suspended.');
      const busy = await db.query(`SELECT 1 FROM wa_conversations WHERE msisdn_bidx = $1 AND state NOT IN ('COMPLETED','ABANDONED','OPTED_OUT') AND expires_at > now()`, [bidx]);
      if (busy.rowCount) throw new ApiError(409, 'conversation_open', 'That number is already in an onboarding conversation.');
      const c = (
        await db.query<{ id: string; state: string; updated_at: Date; expires_at: Date }>(
          `INSERT INTO wa_conversations (tenant_id, msisdn_enc, msisdn_bidx) VALUES ($1, $2, $3) RETURNING id, state, updated_at, expires_at`,
          [b.tenant_id, enc, bidx],
        )
      ).rows[0]!;
      // The business-initiated invitation (an approved template on the real Graph API).
      const text = `${t.legal_name} uses TshepoVet to check its suppliers and asked you to complete onboarding here on WhatsApp. Reply Hi to start.`;
      await db.query(`INSERT INTO wa_sandbox_messages (msisdn_bidx, direction, kind, body) VALUES ($1, 'out', 'template', $2)`, [
        bidx,
        JSON.stringify({ name: 'supplier_invitation', params: [t.legal_name], text }),
      ]);
      await staffAudit(db, req, { tenantId: b.tenant_id, action: 'whatsapp.sandbox_started', entityType: 'wa_conversation', entityId: c.id });
      return utcInstants({ id: c.id, tenant: t.legal_name, number: b.number, state: c.state, updated_at: c.updated_at, expires_at: c.expires_at });
    });
  }

  @Get(':id/messages')
  async messages(@Param('id') raw: string) {
    this.sandboxOnly();
    const id = uuidParam(raw, 'That conversation');
    return inStaff(this.c, async (db) => {
      const c = (await db.query<{ msisdn_bidx: Buffer; created_at: Date }>(`SELECT msisdn_bidx, created_at FROM wa_conversations WHERE id = $1`, [id])).rows[0];
      if (!c) throw new ApiError(404, 'not_found', 'That conversation was not found.');
      return (
        await db.query(
          `SELECT id, direction, kind, body, created_at FROM wa_sandbox_messages
            WHERE msisdn_bidx = $1 AND created_at >= $2::timestamptz - interval '1 second' ORDER BY id LIMIT 500`,
          [c.msisdn_bidx, c.created_at],
        )
      ).rows;
    });
  }

  @Post(':id/messages')
  @HttpCode(202)
  async send(@Param('id') raw: string, @Body() body: unknown) {
    this.sandboxOnly();
    const id = uuidParam(raw, 'That conversation');
    const b = WaSendSchema.parse(body);
    if (b.sample && !(b.sample in SANDBOX_SAMPLES)) throw new ApiError(422, 'unknown_sample', 'Choose one of the sample documents.');
    const c = await inStaff(this.c, async (db) => {
      const r = (await db.query<{ msisdn_enc: Buffer; msisdn_bidx: Buffer; tenant_id: string }>(`SELECT msisdn_enc, msisdn_bidx, tenant_id FROM wa_conversations WHERE id = $1`, [id])).rows[0];
      if (!r) throw new ApiError(404, 'not_found', 'That conversation was not found.');
      const shown = b.text !== undefined ? { kind: 'text', body: { text: b.text } } : b.button ? { kind: 'text', body: { text: b.button.title, button: b.button.id } } : { kind: 'media', body: { sample: b.sample } };
      await db.query(`INSERT INTO wa_sandbox_messages (msisdn_bidx, direction, kind, body) VALUES ($1, 'in', $2, $3)`, [r.msisdn_bidx, shown.kind, JSON.stringify(shown.body)]);
      return r;
    });
    const from = await this.number(c.msisdn_enc);
    const base = { from, id: `wamid.sim.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)) };
    const m: WaInboundMessage =
      b.text !== undefined
        ? { ...base, type: 'text', text: { body: b.text } }
        : b.button
          ? { ...base, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: b.button.id, title: b.button.title } } }
          : { ...base, type: 'image', image: { id: `sample:${b.sample}`, mime_type: 'image/jpeg' } };
    // The same stream the Meta webhook writes: the real conversation worker answers.
    await this.c.redis.xadd(WA_STREAM, 'MAXLEN', '~', '100000', '*', 'kind', 'message', 'phone_number_id', 'sandbox', 'payload', JSON.stringify(m));
    return { ok: true };
  }
}
