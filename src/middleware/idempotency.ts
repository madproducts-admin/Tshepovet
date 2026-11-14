import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import { withTenantTx } from '../lib/db';
import { sha256 } from '../lib/crypto';
import { ApiError, Errors } from '../lib/errors';

/**
 * Idempotency-Key support (required for any client that retries on network
 * errors - otherwise a retry is a second R3.00 charge).
 *
 *   new key            -> claim it (in_progress, 60s lease), run handler, store response
 *   same key, same body, completed   -> replay stored response (Idempotent-Replayed: true)
 *   same key, same body, in progress -> 409 (retry later)
 *   same key, different body         -> 422
 *   lease expired (instance crashed) -> take over
 *
 * Bodies are compared by SHA-256; secrets in the body (TCS PIN) are never stored.
 */
export function idempotency(pool: Pool) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.header('idempotency-key');
    if (!key || !req.auth) return next();
    if (key.length < 8 || key.length > 255) return next(new ApiError(400, 'invalid_idempotency_key', 'Idempotency-Key must be 8-255 characters'));
    const tenantId = req.auth.tenantId;
    const requestHash = sha256(`${req.method} ${req.path}\n${JSON.stringify(req.body ?? {})}`);

    try {
      const claim = await withTenantTx(pool, tenantId, async (c) => {
        const ins = await c.query(
          `INSERT INTO idempotency_keys (tenant_id, key, request_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING key`,
          [tenantId, key, requestHash],
        );
        if (ins.rowCount) return { kind: 'claimed' as const };
        const row = (
          await c.query<{ request_hash: Buffer; status: string; response_status: number | null; response_body: unknown; lease_expired: boolean }>(
            `SELECT request_hash, status, response_status, response_body, locked_until < now() AS lease_expired
               FROM idempotency_keys WHERE tenant_id = $1 AND key = $2 FOR UPDATE`,
            [tenantId, key],
          )
        ).rows[0]!;
        if (!row.request_hash.equals(requestHash)) return { kind: 'mismatch' as const };
        if (row.status === 'completed') return { kind: 'replay' as const, status: row.response_status!, body: row.response_body };
        if (!row.lease_expired) return { kind: 'busy' as const };
        await c.query(`UPDATE idempotency_keys SET locked_until = now() + interval '60 seconds' WHERE tenant_id = $1 AND key = $2`, [tenantId, key]);
        return { kind: 'claimed' as const };
      });

      if (claim.kind === 'mismatch') return next(Errors.idempotencyMismatch());
      if (claim.kind === 'busy') return next(Errors.idempotencyConflict());
      if (claim.kind === 'replay') {
        res.setHeader('idempotent-replayed', 'true');
        return res.status(claim.status).json(claim.body);
      }

      const originalJson = res.json.bind(res);
      res.json = (body: unknown) => {
        const status = res.statusCode;
        const persist =
          status < 500
            ? withTenantTx(pool, tenantId, (c) =>
                c.query(
                  `UPDATE idempotency_keys SET status = 'completed', response_status = $3, response_body = $4 WHERE tenant_id = $1 AND key = $2`,
                  [tenantId, key, status, JSON.stringify(body)],
                ),
              )
            : withTenantTx(pool, tenantId, (c) => c.query(`DELETE FROM idempotency_keys WHERE tenant_id = $1 AND key = $2`, [tenantId, key]));
        persist.catch(() => undefined).finally(() => originalJson(body));
        return res;
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}
