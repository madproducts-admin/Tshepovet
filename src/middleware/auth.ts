import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import { safeEqual } from '../lib/crypto';
import { ApiError, Errors } from '../lib/errors';

/**
 * API keys look like:  tv_live_8f3k2m1q.<43-char base64url secret>
 *                      \_____prefix_____/ \________secret________/
 * The prefix is a public lookup handle; we store HMAC(pepper, full key).
 * Lookup goes through the SECURITY DEFINER function authenticate_api_key()
 * because RLS hides api_keys until the tenant is known.
 */
export function hashApiKey(pepper: Buffer, fullKey: string): Buffer {
  return crypto.createHmac('sha256', pepper).update(fullKey, 'utf8').digest();
}

export function generateApiKey(environment: 'live' | 'test'): { prefix: string; key: string } {
  const prefix = `tv_${environment}_${crypto.randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 8)}`;
  return { prefix, key: `${prefix}.${crypto.randomBytes(32).toString('base64url')}` };
}

export function apiKeyAuth(pool: Pool, pepper: Buffer, requiredScope: string) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const header = req.header('authorization') ?? '';
      const m = /^Bearer\s+(tv_(live|test)_[a-z0-9]{8})\.([A-Za-z0-9_-]{20,})$/.exec(header);
      if (!m) throw Errors.unauthorized();
      const fullKey = `${m[1]}.${m[3]}`;
      const r = await pool.query<{ key_id: string; tenant_id: string; secret_hash: Buffer; environment: 'live' | 'test'; scopes: string[]; tenant_status: string }>(
        `SELECT * FROM authenticate_api_key($1)`,
        [m[1]],
      );
      const row = r.rows[0];
      if (!row || !safeEqual(row.secret_hash, hashApiKey(pepper, fullKey))) throw Errors.unauthorized();
      if (row.tenant_status !== 'active') throw new ApiError(403, 'tenant_suspended', 'This account is suspended');
      if (!row.scopes.includes(requiredScope)) throw Errors.forbidden(requiredScope);
      req.auth = { tenantId: row.tenant_id, apiKeyId: row.key_id, environment: row.environment, scopes: row.scopes };
      next();
    } catch (err) {
      next(err);
    }
  };
}
