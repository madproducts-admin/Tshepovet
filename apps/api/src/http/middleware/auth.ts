import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import { API_KEY_HEADER, ApiError, Errors, hashApiKey, safeEqual } from '@tshepovet/core';

/**
 * API-key authentication for /v1 (key format and hashing: @tshepovet/core auth/apiKeys).
 * Lookup goes through the SECURITY DEFINER function authenticate_api_key(), because RLS
 * hides api_keys until the tenant is known.
 */
export function apiKeyAuth(pool: Pool, pepper: Buffer, requiredScope: string) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const header = req.header('authorization') ?? '';
      const m = API_KEY_HEADER.exec(header);
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
      // "Last used" for the Developers page (at most one write a minute per key). Recording it
      // is a convenience: a failure here must not fail the customer's request.
      await pool.query(`SELECT touch_api_key($1)`, [row.key_id]).catch(() => undefined);
      next();
    } catch (err) {
      next(err);
    }
  };
}
