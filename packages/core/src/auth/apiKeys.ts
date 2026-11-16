import crypto from 'node:crypto';

/**
 * API keys look like:  tv_live_8f3k2m1q.<43-char base64url secret>
 *                      \_____prefix_____/ \________secret________/
 * The prefix is a public lookup handle; we store HMAC(pepper, full key).
 * Lookup goes through the SECURITY DEFINER function authenticate_api_key()
 * because RLS hides api_keys until the tenant is known.
 */
export const API_KEY_HEADER = /^Bearer\s+(tv_(live|test)_[a-z0-9]{8})\.([A-Za-z0-9_-]{20,})$/;

export function hashApiKey(pepper: Buffer, fullKey: string): Buffer {
  return crypto.createHmac('sha256', pepper).update(fullKey, 'utf8').digest();
}

export function generateApiKey(environment: 'live' | 'test'): { prefix: string; key: string } {
  const prefix = `tv_${environment}_${crypto.randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 8)}`;
  return { prefix, key: `${prefix}.${crypto.randomBytes(32).toString('base64url')}` };
}
