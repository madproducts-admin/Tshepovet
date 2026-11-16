import type { Pool } from 'pg';
import { withTenantTx } from '../lib/db';
import type { Crypto } from '../lib/crypto';
import type { RedisClient } from '../lib/redis';
import type { Capability, OutputOf } from '../providers/types';

/**
 * Two-tier, POPIA-aware verification cache.
 *
 *   L1 Redis    hot, per-region, TTL = stale horizon
 *   L2 Postgres durable, survives Redis eviction, purged by retention job
 *
 * Scope is decided by the DATA, not the caller:
 *   global  public-register facts TshepoVet may reuse across buyers
 *           (CIPC registration & directors, VAT vendor status). This reuse is
 *           what makes R3.00/check viable: buyer #2 asking about the same
 *           supplier is a cache hit, not a bureau fee.
 *   tenant  facts disclosed to ONE buyer (TCS status via the vendor's PIN,
 *           a driver's licence record). Never served to another tenant; a
 *           vendor can choose to share via its Passport, which is a separate,
 *           consented flow.
 *
 * Everything is stored encrypted (AAD-bound to capability + scope + tenant),
 * so neither a Redis dump nor a DB snapshot exposes director ID numbers.
 *
 * Freshness:
 *   fresh_until  serve without contacting a bureau
 *   stale_until  serve ONLY when every provider failed (stale-if-error) and the
 *                response is flagged `stale: true`. TCS and licence data have
 *                no stale window: a stale "compliant" is worse than "unknown".
 *   not-found results are cached briefly (negative caching) so typos in bulk
 *   uploads don't trigger repeated paid lookups.
 */
export interface CachePolicy {
  scope: 'global' | 'tenant';
  freshSeconds: number;
  staleSeconds: number;
  notFoundSeconds: number;
}

export const CACHE_POLICIES: Record<Capability, CachePolicy> = {
  company_registration: { scope: 'global', freshSeconds: 7 * 86_400, staleSeconds: 30 * 86_400, notFoundSeconds: 6 * 3_600 },
  vat_status: { scope: 'global', freshSeconds: 7 * 86_400, staleSeconds: 30 * 86_400, notFoundSeconds: 6 * 3_600 },
  tax_compliance_status: { scope: 'tenant', freshSeconds: 86_400, staleSeconds: 0, notFoundSeconds: 3_600 },
  driver_licence: { scope: 'tenant', freshSeconds: 86_400, staleSeconds: 0, notFoundSeconds: 3_600 },
  id_verification: { scope: 'tenant', freshSeconds: 30 * 86_400, staleSeconds: 0, notFoundSeconds: 3_600 },
};

export interface CacheEntry<T> {
  kind: 'found' | 'not_found';
  data: T | null;
  provider: string;
  authoritative: boolean;
  fetchedAt: string;
  freshUntil: string;
  staleUntil: string;
}

export interface CacheLookup<T> {
  entry: CacheEntry<T>;
  source: 'cache:redis' | 'cache:pg';
  fresh: boolean;
  staleUsable: boolean;
}

export class VerificationCache {
  private inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly pool: Pool,
    private readonly redis: RedisClient,
    private readonly crypto: Crypto,
    private readonly policies: Record<Capability, CachePolicy> = CACHE_POLICIES,
  ) {}

  private key(capability: Capability, subject: string, tenantId: string) {
    const policy = this.policies[capability];
    const scopeTenant = policy.scope === 'tenant' ? tenantId : null;
    const cacheKey = this.crypto.blindIndex('cache_key', `${capability}|${subject}`, scopeTenant ?? 'global');
    const hex = cacheKey.toString('hex');
    return {
      policy,
      scopeTenant,
      cacheKey,
      redisKey: `tv:vc:${policy.scope}:${scopeTenant ?? 'g'}:${hex}`,
      lockKey: `tv:vc:lock:${hex}`,
      aad: `cache:${capability}:${policy.scope}:${scopeTenant ?? 'g'}`,
    };
  }

  private evaluate<T>(entry: CacheEntry<T>, maxAgeSeconds: number | undefined, now: number) {
    const fetched = Date.parse(entry.fetchedAt);
    const withinMaxAge = maxAgeSeconds === undefined || now - fetched <= maxAgeSeconds * 1000;
    return {
      fresh: withinMaxAge && now < Date.parse(entry.freshUntil),
      staleUsable: now < Date.parse(entry.staleUntil),
    };
  }

  async get<C extends Capability>(
    capability: C,
    subject: string,
    tenantId: string,
    opts: { maxAgeSeconds?: number } = {},
  ): Promise<CacheLookup<OutputOf<C>> | null> {
    const k = this.key(capability, subject, tenantId);
    const now = Date.now();

    const l1 = await this.redis.getBuffer(k.redisKey).catch(() => null);
    if (l1) {
      const entry = JSON.parse(await this.crypto.decryptString(l1, k.aad)) as CacheEntry<OutputOf<C>>;
      return { entry, source: 'cache:redis', ...this.evaluate(entry, opts.maxAgeSeconds, now) };
    }

    const row = await withTenantTx(this.pool, tenantId, async (c) => {
      const r = await c.query<{ payload_enc: Buffer; stale_until: Date }>(
        `SELECT payload_enc, stale_until FROM verification_cache
          WHERE cache_key = $1 AND tenant_id IS NOT DISTINCT FROM $2 AND stale_until > now()`,
        [k.cacheKey, k.scopeTenant],
      );
      return r.rows[0];
    });
    if (!row) return null;
    const entry = JSON.parse(await this.crypto.decryptString(row.payload_enc, k.aad)) as CacheEntry<OutputOf<C>>;
    // Re-warm L1 for the remaining stale horizon.
    const ttl = Date.parse(entry.staleUntil) - now;
    if (ttl > 0) await this.redis.set(k.redisKey, row.payload_enc, 'PX', ttl).catch(() => undefined);
    return { entry, source: 'cache:pg', ...this.evaluate(entry, opts.maxAgeSeconds, now) };
  }

  async put<C extends Capability>(
    capability: C,
    subject: string,
    tenantId: string,
    result: { kind: 'found' | 'not_found'; data: OutputOf<C> | null; provider: string; authoritative: boolean },
  ): Promise<CacheEntry<OutputOf<C>>> {
    const k = this.key(capability, subject, tenantId);
    const now = Date.now();
    const freshMs = (result.kind === 'found' ? k.policy.freshSeconds : k.policy.notFoundSeconds) * 1000;
    const staleMs = result.kind === 'found' ? k.policy.staleSeconds * 1000 : 0;
    const entry: CacheEntry<OutputOf<C>> = {
      ...result,
      fetchedAt: new Date(now).toISOString(),
      freshUntil: new Date(now + freshMs).toISOString(),
      staleUntil: new Date(now + freshMs + staleMs).toISOString(),
    };
    const blob = await this.crypto.encrypt(JSON.stringify(entry), k.aad);

    await withTenantTx(this.pool, tenantId, (c) =>
      c.query(
        `INSERT INTO verification_cache (cache_key, scope, tenant_id, capability, payload, payload_enc, source_provider,
                                         fetched_at, fresh_until, stale_until, purge_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
         ON CONFLICT (cache_key, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid))
         DO UPDATE SET payload = EXCLUDED.payload, payload_enc = EXCLUDED.payload_enc, source_provider = EXCLUDED.source_provider,
                       fetched_at = EXCLUDED.fetched_at, fresh_until = EXCLUDED.fresh_until,
                       stale_until = EXCLUDED.stale_until, purge_after = EXCLUDED.purge_after`,
        [
          k.cacheKey,
          k.policy.scope,
          k.scopeTenant,
          capability,
          JSON.stringify({ kind: result.kind, provider: result.provider }),
          blob,
          result.provider,
          entry.fetchedAt,
          entry.freshUntil,
          entry.staleUntil,
        ],
      ),
    );
    await this.redis.set(k.redisKey, blob, 'PX', freshMs + staleMs).catch(() => undefined);
    return entry;
  }

  /**
   * Request coalescing ("single-flight"). Bulk vendor uploads often contain
   * the same supplier many times; concurrent identical lookups must cost one
   * bureau fee, not N. In-process: share the promise. Cross-instance: a Redis
   * lock; losers poll L1 briefly, then fall back to doing the work themselves
   * (correctness beats savings).
   */
  async coalesce<C extends Capability, R>(
    capability: C,
    subject: string,
    tenantId: string,
    work: () => Promise<R>,
    opts: { waitMs?: number } = {},
  ): Promise<{ result: R | null; coalesced: boolean }> {
    const k = this.key(capability, subject, tenantId);
    const existing = this.inflight.get(k.redisKey);
    if (existing) return { result: (await existing) as R, coalesced: true };

    const gotLock = (await this.redis.set(k.lockKey, '1', 'PX', 15_000, 'NX').catch(() => 'OK')) === 'OK';
    if (!gotLock) {
      const deadline = Date.now() + (opts.waitMs ?? 3_000);
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        if ((await this.redis.exists(k.redisKey).catch(() => 0)) === 1) return { result: null, coalesced: true };
      }
    }

    const p = work();
    this.inflight.set(k.redisKey, p);
    try {
      return { result: await p, coalesced: false };
    } finally {
      this.inflight.delete(k.redisKey);
      if (gotLock) await this.redis.del(k.lockKey).catch(() => undefined);
    }
  }
}
