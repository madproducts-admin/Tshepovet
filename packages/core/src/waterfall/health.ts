import type { RedisClient } from '../lib/redis';
import type { Capability } from '../providers/types';

/**
 * Provider health, shared by every API instance through Redis.
 *
 *   window      last 50 outcomes per provider+capability (1 = ok, 0 = fail)
 *   latency     EWMA of successful-call latency (alpha 0.2)
 *   circuit     CLOSED -> OPEN when >= 5 consecutive failures, or >= 50%
 *               failures over the last 20 calls (min 10 samples).
 *               OPEN lasts `cooldown` (30s, doubling to 5 min on repeated
 *               trips). After cooldown, one probe request is let through
 *               (HALF-OPEN); success closes the circuit.
 *   upstream    if 2+ distinct providers fail on the same capability within a
 *               short window, the upstream registry itself (CIPC, eNaTIS,
 *               eFiling) is likely down. We flag the capability "degraded"
 *               so requests go straight to stale-if-error cache instead of
 *               burning through every bureau (and their per-call fees).
 *
 * Health data is advisory: small races between instances are acceptable.
 */
export interface HealthSnapshot {
  successRate: number; // 0..1, optimistic prior for cold providers
  latencyMs: number;
  samples: number;
  circuit: 'closed' | 'open' | 'half_open';
}

const WINDOW = 50;
const BREAKER_WINDOW = 20;
const BREAKER_MIN_SAMPLES = 10;
const CONSECUTIVE_TRIP = 5;
const BASE_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 300_000;
const UPSTREAM_WINDOW_MS = 60_000;

export class HealthTracker {
  constructor(
    private readonly redis: RedisClient,
    private readonly prefix = 'tv:health',
  ) {}

  private k(provider: string, cap: Capability, part: string) {
    return `${this.prefix}:${part}:${provider}:${cap}`;
  }

  async snapshot(provider: string, cap: Capability): Promise<HealthSnapshot> {
    const [win, lat, open, cooldown] = await Promise.all([
      this.redis.lrange(this.k(provider, cap, 'win'), 0, WINDOW - 1),
      this.redis.get(this.k(provider, cap, 'lat')),
      this.redis.pttl(this.k(provider, cap, 'open')),
      this.redis.get(this.k(provider, cap, 'cooldown')),
    ]);
    const samples = win.length;
    const ok = win.filter((x) => x === '1').length;
    // Beta(4,1) prior: a new provider starts at 80% assumed success.
    const successRate = (ok + 4) / (samples + 5);
    let circuit: HealthSnapshot['circuit'] = 'closed';
    if (open > 0) circuit = 'open';
    else if (cooldown !== null) circuit = 'half_open';
    return { successRate, latencyMs: lat ? Number(lat) : 1500, samples, circuit };
  }

  /** In HALF-OPEN, only one instance may send the probe. */
  async tryAcquireProbe(provider: string, cap: Capability): Promise<boolean> {
    const r = await this.redis.set(this.k(provider, cap, 'probe'), '1', 'PX', 10_000, 'NX');
    return r === 'OK';
  }

  async recordSuccess(provider: string, cap: Capability, latencyMs: number): Promise<void> {
    const latKey = this.k(provider, cap, 'lat');
    const prev = await this.redis.get(latKey);
    const ewma = prev === null ? latencyMs : Math.round(0.2 * latencyMs + 0.8 * Number(prev));
    await this.redis
      .multi()
      .lpush(this.k(provider, cap, 'win'), '1')
      .ltrim(this.k(provider, cap, 'win'), 0, WINDOW - 1)
      .set(latKey, String(ewma))
      .set(this.k(provider, cap, 'consec'), '0')
      .del(this.k(provider, cap, 'cooldown'))
      .del(this.k(provider, cap, 'probe'))
      .exec();
  }

  async recordFailure(provider: string, cap: Capability): Promise<void> {
    const winKey = this.k(provider, cap, 'win');
    const res = await this.redis
      .multi()
      .lpush(winKey, '0')
      .ltrim(winKey, 0, WINDOW - 1)
      .incr(this.k(provider, cap, 'consec'))
      .lrange(winKey, 0, BREAKER_WINDOW - 1)
      .exec();
    const consec = Number(res?.[2]?.[1] ?? 0);
    const recent = (res?.[3]?.[1] as string[] | undefined) ?? [];
    const failRatio = recent.length ? recent.filter((x) => x === '0').length / recent.length : 0;

    const wasHalfOpen = (await this.redis.get(this.k(provider, cap, 'cooldown'))) !== null;
    const trip = wasHalfOpen || consec >= CONSECUTIVE_TRIP || (recent.length >= BREAKER_MIN_SAMPLES && failRatio >= 0.5);
    if (trip) await this.open(provider, cap);
    await this.redis.del(this.k(provider, cap, 'probe'));
  }

  private async open(provider: string, cap: Capability): Promise<void> {
    const prev = Number((await this.redis.get(this.k(provider, cap, 'cooldown'))) ?? 0);
    const cooldown = prev ? Math.min(prev * 2, MAX_COOLDOWN_MS) : BASE_COOLDOWN_MS;
    await this.redis
      .multi()
      .set(this.k(provider, cap, 'open'), '1', 'PX', cooldown)
      // cooldown key outlives the open key: its presence after `open` expires = HALF-OPEN
      .set(this.k(provider, cap, 'cooldown'), String(cooldown), 'PX', cooldown * 4)
      .exec();
  }

  async noteUpstreamFailure(cap: Capability, provider: string): Promise<number> {
    const key = `${this.prefix}:upstream:${cap}`;
    const now = Date.now();
    await this.redis
      .multi()
      .zadd(key, now, provider)
      .zremrangebyscore(key, 0, now - UPSTREAM_WINDOW_MS)
      .pexpire(key, UPSTREAM_WINDOW_MS)
      .exec();
    return this.redis.zcard(key);
  }

  async markUpstreamDegraded(cap: Capability, ms = 60_000): Promise<void> {
    await this.redis.set(`${this.prefix}:degraded:${cap}`, '1', 'PX', ms);
  }

  async isUpstreamDegraded(cap: Capability): Promise<boolean> {
    return (await this.redis.exists(`${this.prefix}:degraded:${cap}`)) === 1;
  }

  async clearUpstreamDegraded(cap: Capability): Promise<void> {
    await this.redis.del(`${this.prefix}:degraded:${cap}`, `${this.prefix}:upstream:${cap}`);
  }

  /** Month-to-date call volume, used to pick the right volume-tier price. */
  async incrementVolume(provider: string, cap: Capability, now = new Date()): Promise<void> {
    const key = `${this.prefix}:vol:${provider}:${cap}:${now.toISOString().slice(0, 7)}`;
    await this.redis.multi().incr(key).expire(key, 40 * 86_400).exec();
  }

  async monthVolume(provider: string, cap: Capability, now = new Date()): Promise<number> {
    const v = await this.redis.get(`${this.prefix}:vol:${provider}:${cap}:${now.toISOString().slice(0, 7)}`);
    return v ? Number(v) : 0;
  }
}
