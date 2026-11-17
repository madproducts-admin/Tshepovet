import crypto from 'node:crypto';

/**
 * WhatsApp Cloud API inbound types, the signature check and the Redis stream the
 * webhook receiver (apps/api) writes and the conversation worker reads. Framework-free.
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

/** X-Hub-Signature-256: sha256=HMAC(app_secret, raw body), compared in constant time. */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex'));
  const got = Buffer.from(header.slice(7));
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

export const WA_STREAM = 'tv:wa:inbound';
