import crypto from 'node:crypto';
import { Controller, Get, Inject, NotFoundException, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { verifyMetaSignature, WA_STREAM, type WaWebhookBody } from '@tshepovet/core';
import { CONTAINER, type Container } from '../container';

/**
 * WhatsApp Cloud API webhook receiver (docs/04).
 *
 *   GET  ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...  -> echo challenge
 *   POST signed with X-Hub-Signature-256: sha256=HMAC(app_secret, raw body)
 *
 * It does the minimum synchronously - verify, de-duplicate, enqueue, 200 - because Meta
 * retries slow or failed deliveries (and duplicates are normal). The conversation worker
 * consumes the Redis stream. Nothing from the payload is logged except message ids and types.
 * Answers 404 until WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN are configured.
 */
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  private secrets() {
    const { WHATSAPP_APP_SECRET: appSecret, WHATSAPP_VERIFY_TOKEN: verifyToken } = this.c.config;
    if (!appSecret || !verifyToken) throw new NotFoundException();
    return { appSecret, verifyToken };
  }

  @Get()
  subscribe(@Req() req: Request, @Res() res: Response): void {
    const { verifyToken } = this.secrets();
    const token = String(req.query['hub.verify_token'] ?? '');
    const ok =
      req.query['hub.mode'] === 'subscribe' &&
      token.length === verifyToken.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(verifyToken));
    if (!ok) {
      res.sendStatus(403);
      return;
    }
    res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
  }

  @Post()
  async receive(@Req() req: Request, @Res() res: Response): Promise<void> {
    const { appSecret } = this.secrets();
    if (!req.rawBody || !verifyMetaSignature(req.rawBody, req.header('x-hub-signature-256'), appSecret)) {
      res.sendStatus(401);
      return;
    }
    const body = req.body as WaWebhookBody;
    const { redis, log } = this.c;
    try {
      for (const entry of body.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const v = change.value;
          for (const m of v.messages ?? []) {
            // Dedupe for 3 days (Meta retries for up to ~7 days on failure; the DB table
            // wa_inbound_messages is the durable second line).
            const fresh = await redis.set(`tv:wa:seen:${m.id}`, '1', 'EX', 3 * 86_400, 'NX');
            if (fresh !== 'OK') continue;
            await redis.xadd(WA_STREAM, 'MAXLEN', '~', '100000', '*', 'kind', 'message', 'phone_number_id', v.metadata.phone_number_id, 'payload', JSON.stringify(m));
            log.info({ wamid: m.id, type: m.type }, 'whatsapp message enqueued');
          }
          for (const s of v.statuses ?? []) {
            await redis.xadd(WA_STREAM, 'MAXLEN', '~', '100000', '*', 'kind', 'status', 'payload', JSON.stringify({ id: s.id, status: s.status }));
          }
        }
      }
      res.sendStatus(200);
    } catch (err) {
      log.error({ err }, 'failed to enqueue whatsapp webhook');
      // Non-2xx makes Meta retry - which is what we want if Redis is down.
      res.sendStatus(503);
    }
  }
}
