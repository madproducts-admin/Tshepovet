import crypto from 'node:crypto';
import { Router } from 'express';
import type { Logger } from '../lib/logger';
import type { RedisClient } from '../lib/redis';

/**
 * WhatsApp Cloud API webhook receiver.
 *
 *   GET  ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...  -> echo challenge
 *   POST signed with X-Hub-Signature-256: sha256=HMAC(app_secret, raw body)
 *
 * The receiver does the minimum synchronously - verify, de-duplicate, enqueue,
 * 200 - because Meta retries slow or failed deliveries (and duplicates are
 * normal). The conversation worker consumes the Redis stream, runs the state
 * machine, OCR and verification calls.
 *
 * Nothing from the payload is logged except message ids and types.
 */
export interface WaInboundMessage {
  from: string; // E.164 without '+', e.g. 27821234567
  id: string; // wamid...
  timestamp: string;
  type: 'text' | 'image' | 'document' | 'interactive' | 'button' | 'audio' | 'video' | 'sticker' | 'location' | 'contacts' | 'unsupported';
  text?: { body: string };
  image?: { id: string; mime_type: string; sha256?: string; caption?: string };
  document?: { id: string; mime_type: string; sha256?: string; filename?: string; caption?: string };
  interactive?:
    | { type: 'button_reply'; button_reply: { id: string; title: string } }
    | { type: 'list_reply'; list_reply: { id: string; title: string } }
    | { type: 'nfm_reply'; nfm_reply: { response_json: string; name?: string } };
  button?: { payload: string; text: string };
}

export interface WaWebhookBody {
  object: 'whatsapp_business_account';
  entry: Array<{
    id: string;
    changes: Array<{
      field: 'messages';
      value: {
        messaging_product: 'whatsapp';
        metadata: { display_phone_number: string; phone_number_id: string };
        contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
        messages?: WaInboundMessage[];
        statuses?: Array<{ id: string; status: 'sent' | 'delivered' | 'read' | 'failed'; recipient_id: string; errors?: unknown[] }>;
      };
    }>;
  }>;
}

export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex'));
  const got = Buffer.from(header.slice(7));
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

export const WA_STREAM = 'tv:wa:inbound';

export function whatsappRouter(o: { appSecret: string; verifyToken: string; redis: RedisClient; log: Logger }) {
  const r = Router();

  r.get('/', (req, res) => {
    const token = String(req.query['hub.verify_token'] ?? '');
    const ok =
      req.query['hub.mode'] === 'subscribe' &&
      token.length === o.verifyToken.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(o.verifyToken));
    if (!ok) return res.sendStatus(403);
    res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
  });

  r.post('/', async (req, res) => {
    if (!req.rawBody || !verifyMetaSignature(req.rawBody, req.header('x-hub-signature-256'), o.appSecret)) {
      return res.sendStatus(401);
    }
    const body = req.body as WaWebhookBody;
    try {
      for (const entry of body.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const v = change.value;
          for (const m of v.messages ?? []) {
            // Dedupe for 3 days (Meta retries for up to ~7 days on failure; the
            // DB table wa_inbound_messages is the durable second line).
            const fresh = await o.redis.set(`tv:wa:seen:${m.id}`, '1', 'EX', 3 * 86_400, 'NX');
            if (fresh !== 'OK') continue;
            await o.redis.xadd(WA_STREAM, 'MAXLEN', '~', '100000', '*', 'kind', 'message', 'phone_number_id', v.metadata.phone_number_id, 'payload', JSON.stringify(m));
            o.log.info({ wamid: m.id, type: m.type }, 'whatsapp message enqueued');
          }
          for (const s of v.statuses ?? []) {
            await o.redis.xadd(WA_STREAM, 'MAXLEN', '~', '100000', '*', 'kind', 'status', 'payload', JSON.stringify({ id: s.id, status: s.status }));
          }
        }
      }
      res.sendStatus(200);
    } catch (err) {
      o.log.error({ err }, 'failed to enqueue whatsapp webhook');
      // Non-2xx makes Meta retry - which is what we want if Redis is down.
      res.sendStatus(503);
    }
  });
  return r;
}
