import crypto from 'node:crypto';

/**
 * Webhook signatures (Stripe-style, so buyers' developers recognise them):
 *
 *   TshepoVet-Signature: t=1731600000,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * Consumers must verify against the RAW body and reject timestamps older than
 * the tolerance (replay protection). During secret rotation we send one v1
 * per active secret.
 */
export function signWebhook(secrets: string[], rawBody: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const sigs = secrets.map((s) => `v1=${crypto.createHmac('sha256', s).update(`${timestamp}.${rawBody}`).digest('hex')}`);
  return [`t=${timestamp}`, ...sigs].join(',');
}

export function verifyWebhook(header: string, rawBody: string, secret: string, toleranceSeconds = 300, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const parts = header.split(',').map((p) => p.trim().split('=') as [string, string]);
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  return parts
    .filter(([k]) => k === 'v1')
    .some(([, v]) => {
      const got = Buffer.from(v ?? '');
      return got.length === expected.length && crypto.timingSafeEqual(got, expected);
    });
}
