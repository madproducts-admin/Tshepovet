import crypto from 'node:crypto';
import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { ApiError, generateApiKey, hashApiKey, parseDenyList, webhookUrlProblem } from '@tshepovet/core';
import { CreateApiKeySchema, CreateWebhookSchema, DeliveryQuerySchema, UpdateWebhookSchema } from '@tshepovet/contracts';
import { CONTAINER, type Container } from '../container';
import { PortalGuard, RequirePermission } from './guards';
import { auditBy, inTenant, me, notFound, pageOf, uuidParam } from './tenant';

const MAX_ACTIVE_KEYS = 20;
const MAX_ENDPOINTS = 10;
const ROTATION_OVERLAP_HOURS = 24;

const KEY_SELECT = `
  SELECT k.id, k.name, k.prefix, k.environment, k.scopes, u.full_name AS created_by, k.created_at, k.last_used_at, k.expires_at, k.revoked_at
    FROM api_keys k LEFT JOIN tenant_users u ON u.id = k.created_by`;
const ENDPOINT_COLUMNS = `id, url, description, events, status, consecutive_failures, disabled_at, created_at, secret_rotated_at,
  CASE WHEN previous_secret_expires_at > now() THEN previous_secret_expires_at END AS previous_secret_valid_until`;

const newWebhookSecret = () => `whsec_${crypto.randomBytes(32).toString('base64url')}`;

/**
 * Developers: API keys for /v1 and webhook endpoints. Secrets are shown once, at creation or
 * rotation, and stored only as an HMAC (keys) or envelope-encrypted (webhook secrets).
 */
@Controller('api/developers')
@UseGuards(PortalGuard)
export class DevelopersController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  private async checkUrl(url: string) {
    const problem = await webhookUrlProblem(url, parseDenyList(this.c.config.WEBHOOK_DENY_IPS));
    if (problem) throw new ApiError(400, 'invalid_webhook_url', problem);
  }

  // --- API keys --------------------------------------------------------------------------
  @Get('keys')
  @RequirePermission('developers:manage')
  async keys(@Req() req: Request) {
    return inTenant(this.c, req, async (client) => (await client.query(`${KEY_SELECT} ORDER BY k.revoked_at NULLS FIRST, k.created_at DESC`)).rows);
  }

  @Post('keys')
  @HttpCode(201)
  @RequirePermission('developers:manage')
  async createKey(@Req() req: Request) {
    const b = CreateApiKeySchema.parse(req.body);
    if (b.environment === 'live' && this.c.config.SANDBOX === 'true') {
      throw new ApiError(409, 'live_keys_unavailable', 'This is the sandbox: only test keys (tv_test_) can be made here. Live keys open when TshepoVet goes live.');
    }
    const u = me(req);
    return inTenant(this.c, req, async (client) => {
      const n = await client.query<{ n: number }>(`SELECT count(*) AS n FROM api_keys WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`);
      if (n.rows[0]!.n >= MAX_ACTIVE_KEYS) throw new ApiError(409, 'too_many_keys', `You have ${MAX_ACTIVE_KEYS} active keys. Revoke one you no longer use first.`);
      const k = generateApiKey(b.environment);
      const ins = await client.query<{ id: string }>(
        `INSERT INTO api_keys (tenant_id, prefix, secret_hash, environment, scopes, name, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8::int IS NULL THEN NULL ELSE now() + make_interval(days => $8::int) END) RETURNING id`,
        [u.tenantId, k.prefix, hashApiKey(Buffer.from(this.c.config.API_KEY_PEPPER, 'base64'), k.key), b.environment, b.scopes, b.name, u.userId, b.expires_in_days ?? null],
      );
      const id = ins.rows[0]!.id;
      await auditBy(client, req, { action: 'api_key.created', entityType: 'api_key', entityId: id, details: { prefix: k.prefix, environment: b.environment, scopes: b.scopes } });
      return { api_key: (await client.query(`${KEY_SELECT} WHERE k.id = $1`, [id])).rows[0], secret: k.key };
    });
  }

  @Delete('keys/:id')
  @HttpCode(204)
  @RequirePermission('developers:manage')
  async revokeKey(@Req() req: Request, @Param('id') raw: string) {
    const id = uuidParam(raw, 'That key');
    await inTenant(this.c, req, async (client) => {
      const r = await client.query<{ prefix: string }>(`UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING prefix`, [id]);
      if (!r.rows[0]) throw notFound('An active key with that id');
      await auditBy(client, req, { action: 'api_key.revoked', entityType: 'api_key', entityId: id, details: { prefix: r.rows[0].prefix } });
    });
  }

  // --- Webhooks --------------------------------------------------------------------------
  @Get('webhooks')
  @RequirePermission('developers:manage')
  async webhooks(@Req() req: Request) {
    return inTenant(this.c, req, async (client) => (await client.query(`SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints ORDER BY created_at`)).rows);
  }

  @Post('webhooks')
  @HttpCode(201)
  @RequirePermission('developers:manage')
  async createWebhook(@Req() req: Request) {
    const b = CreateWebhookSchema.parse(req.body);
    await this.checkUrl(b.url);
    const u = me(req);
    const secret = newWebhookSecret();
    const secretEnc = await this.c.crypto.encrypt(secret, `webhook_secret:${u.tenantId}`);
    return inTenant(this.c, req, async (client) => {
      const n = await client.query<{ n: number }>(`SELECT count(*) AS n FROM webhook_endpoints`);
      if (n.rows[0]!.n >= MAX_ENDPOINTS) throw new ApiError(409, 'too_many_endpoints', `You can have up to ${MAX_ENDPOINTS} endpoints. Remove one you no longer use first.`);
      const r = await client.query(
        `INSERT INTO webhook_endpoints (tenant_id, url, secret_enc, events, description, created_by) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${ENDPOINT_COLUMNS}`,
        [u.tenantId, b.url, secretEnc, b.events, b.description ?? null, u.userId],
      );
      await auditBy(client, req, { action: 'webhook.created', entityType: 'webhook_endpoint', entityId: r.rows[0].id, details: { url: b.url, events: b.events } });
      return { endpoint: r.rows[0], secret };
    });
  }

  @Patch('webhooks/:id')
  @RequirePermission('developers:manage')
  async updateWebhook(@Req() req: Request, @Param('id') raw: string) {
    const id = uuidParam(raw, 'That endpoint');
    const b = UpdateWebhookSchema.parse(req.body);
    if (b.url) await this.checkUrl(b.url);
    return inTenant(this.c, req, async (client) => {
      const sets: string[] = [];
      const params: unknown[] = [id];
      if (b.url !== undefined) sets.push(`url = $${params.push(b.url)}`);
      if (b.events !== undefined) sets.push(`events = $${params.push(b.events)}`);
      if (b.description !== undefined) sets.push(`description = $${params.push(b.description)}`);
      if (b.status === 'active') sets.push(`status = 'active', disabled_at = NULL, consecutive_failures = 0`);
      if (b.status === 'disabled') sets.push(`status = 'disabled', disabled_at = now()`);
      const r = await client.query(`UPDATE webhook_endpoints SET ${sets.join(', ')} WHERE id = $1 RETURNING ${ENDPOINT_COLUMNS}`, params);
      if (!r.rows[0]) throw notFound('That endpoint');
      await auditBy(client, req, { action: 'webhook.updated', entityType: 'webhook_endpoint', entityId: id, details: { fields: Object.keys(b), ...(b.status ? { status: b.status } : {}) } });
      return r.rows[0];
    });
  }

  @Post('webhooks/:id/rotate-secret')
  @HttpCode(200)
  @RequirePermission('developers:manage')
  async rotate(@Req() req: Request, @Param('id') raw: string) {
    const id = uuidParam(raw, 'That endpoint');
    const secret = newWebhookSecret();
    const secretEnc = await this.c.crypto.encrypt(secret, `webhook_secret:${me(req).tenantId}`);
    return inTenant(this.c, req, async (client) => {
      const r = await client.query(
        `UPDATE webhook_endpoints
            SET previous_secret_enc = secret_enc,
                previous_secret_expires_at = now() + make_interval(hours => $3::int),
                secret_enc = $2, secret_rotated_at = now()
          WHERE id = $1 RETURNING ${ENDPOINT_COLUMNS}`,
        [id, secretEnc, ROTATION_OVERLAP_HOURS],
      );
      if (!r.rows[0]) throw notFound('That endpoint');
      await auditBy(client, req, { action: 'webhook.secret_rotated', entityType: 'webhook_endpoint', entityId: id, details: { overlap_hours: ROTATION_OVERLAP_HOURS } });
      return { endpoint: r.rows[0], secret };
    });
  }

  @Get('webhooks/:id/deliveries')
  @RequirePermission('developers:manage')
  async deliveries(@Req() req: Request, @Param('id') raw: string) {
    const id = uuidParam(raw, 'That endpoint');
    const q = DeliveryQuerySchema.parse(req.query);
    return inTenant(this.c, req, async (client) => {
      await this.endpoint(client, id);
      const { limit, offset } = pageOf(q);
      const total = await client.query<{ n: number }>(`SELECT count(*) AS n FROM webhook_deliveries WHERE endpoint_id = $1`, [id]);
      const rows = await client.query(
        `SELECT d.id, d.event_id, e.event_type, d.status, d.attempts, d.last_http_status, d.last_error, d.next_attempt_at, d.delivered_at, e.created_at AS event_created_at
           FROM webhook_deliveries d JOIN webhook_events e ON e.id = d.event_id
          WHERE d.endpoint_id = $1 ORDER BY d.id DESC LIMIT $2 OFFSET $3`,
        [id, limit, offset],
      );
      return { items: rows.rows, total: total.rows[0]!.n, page: q.page, page_size: q.page_size };
    });
  }

  @Post('webhooks/:id/deliveries/:deliveryId/replay')
  @HttpCode(202)
  @RequirePermission('developers:manage')
  async replay(@Req() req: Request, @Param('id') raw: string, @Param('deliveryId') rawDelivery: string) {
    const id = uuidParam(raw, 'That endpoint');
    const deliveryId = uuidParam(rawDelivery, 'That delivery');
    return inTenant(this.c, req, async (client) => {
      const ep = await this.endpoint(client, id);
      if (ep.status !== 'active') throw new ApiError(409, 'endpoint_disabled', 'Resume the endpoint before sending deliveries to it.');
      const r = await client.query(
        `UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
          WHERE id = $1 AND endpoint_id = $2 AND status IN ('succeeded','failed','dead') RETURNING id`,
        [deliveryId, id],
      );
      if (!r.rowCount) {
        const exists = await client.query(`SELECT 1 FROM webhook_deliveries WHERE id = $1 AND endpoint_id = $2`, [deliveryId, id]);
        if (!exists.rowCount) throw notFound('That delivery');
        throw new ApiError(409, 'delivery_in_progress', 'That delivery is already queued.');
      }
      await auditBy(client, req, { action: 'webhook.delivery_replayed', entityType: 'webhook_delivery', entityId: deliveryId, details: { endpoint_id: id } });
      return { ok: true as const };
    });
  }

  private async endpoint(client: PoolClient, id: string) {
    const r = await client.query<{ status: string }>(`SELECT status FROM webhook_endpoints WHERE id = $1`, [id]);
    if (!r.rows[0]) throw notFound('That endpoint');
    return r.rows[0];
  }
}
