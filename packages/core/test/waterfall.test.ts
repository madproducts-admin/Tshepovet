import Redis from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { logger } from '../src/lib/logger';
import { Capability, InputOf, OutputOf, ProviderAdapter, ProviderError, ProviderResult } from '../src/providers/types';
import { ProviderCapabilityConfig, StaticCapabilityConfig, WaterfallEngine } from '../src/waterfall/engine';
import { HealthTracker } from '../src/waterfall/health';

const redis = new Redis(process.env.TEST_REDIS_URL!);
afterAll(() => redis.quit());
beforeEach(() => redis.flushdb());

type Behaviour = 'ok' | 'not_found' | 'fail' | 'slow';

class FakeAdapter implements ProviderAdapter {
  calls = 0;
  constructor(readonly code: string, public behaviour: Behaviour) {}
  supports() {
    return true;
  }
  async call<C extends Capability>(_c: C, input: InputOf<C>, signal: AbortSignal): Promise<ProviderResult<OutputOf<C>>> {
    this.calls++;
    if (this.behaviour === 'fail') throw new ProviderError('error_5xx', 'boom', 502);
    if (this.behaviour === 'slow') {
      await new Promise((_, rej) => signal.addEventListener('abort', () => rej(new ProviderError('timeout', 'slow'))));
    }
    if (this.behaviour === 'not_found') return { kind: 'not_found' };
    return { kind: 'found', data: { from: this.code, input } as unknown as OutputOf<C> };
  }
}

const cfg = (code: string, cost: number, extra: Partial<ProviderCapabilityConfig> = {}): ProviderCapabilityConfig => ({
  providerCode: code,
  capability: 'company_registration',
  unitCostCents: cost,
  volumeTiers: [],
  prepaidRemaining: null,
  isLiveSource: true,
  timeoutMs: 500,
  enabled: true,
  ...extra,
});

function engine(adapters: FakeAdapter[], configs: ProviderCapabilityConfig[]) {
  return new WaterfallEngine(adapters, new StaticCapabilityConfig(configs), new HealthTracker(redis, 'test:h'), logger, () => 0.99);
}

const opts = (o: Partial<Parameters<WaterfallEngine['execute']>[2]> = {}) => ({ deadlineAt: Date.now() + 5000, costCeilingCents: 1000, ...o });
const q = { enterpriseNumber: '2019/123456/07' };

describe('waterfall routing', () => {
  it('uses the cheapest healthy provider', async () => {
    const a = new FakeAdapter('cheap', 'ok');
    const b = new FakeAdapter('pricey', 'ok');
    const r = await engine([a, b], [cfg('cheap', 100), cfg('pricey', 300)]).execute('company_registration', q, opts());
    expect(r.status).toBe('found');
    expect(r.status === 'found' && r.provider).toBe('cheap');
    expect(b.calls).toBe(0);
    expect(r.costCents).toBe(100);
  });

  it('prefers a prepaid bundle (zero marginal cost) over a cheaper list price', async () => {
    const a = new FakeAdapter('cheap', 'ok');
    const b = new FakeAdapter('prepaid', 'ok');
    const r = await engine([a, b], [cfg('cheap', 100), cfg('prepaid', 300, { prepaidRemaining: 5000 })]).execute('company_registration', q, opts());
    expect(r.status === 'found' && r.provider).toBe('prepaid');
  });

  it('applies volume tiers from month-to-date volume', async () => {
    const e = engine([new FakeAdapter('a', 'ok')], [cfg('a', 200, { volumeTiers: [{ from: 2, costCents: 50 }] })]);
    await e.execute('company_registration', q, opts());
    await e.execute('company_registration', q, opts());
    const r = await e.execute('company_registration', q, opts());
    expect(r.costCents).toBe(50);
  });

  it('fails over on provider error and records the attempt', async () => {
    const a = new FakeAdapter('cheap', 'fail');
    const b = new FakeAdapter('backup', 'ok');
    const r = await engine([a, b], [cfg('cheap', 100), cfg('backup', 200)]).execute('company_registration', q, opts());
    expect(r.status === 'found' && r.provider).toBe('backup');
    expect(r.attempts.map((x) => x.outcome)).toEqual(['error_5xx', 'success']);
    expect(r.costCents).toBe(200);
  });

  it('times out slow providers within the deadline and fails over', async () => {
    const a = new FakeAdapter('slow', 'slow');
    const b = new FakeAdapter('backup', 'ok');
    const r = await engine([a, b], [cfg('slow', 100, { timeoutMs: 100 }), cfg('backup', 200)]).execute('company_registration', q, opts());
    expect(r.attempts[0]!.outcome).toBe('timeout');
    expect(r.status).toBe('found');
  });

  it('opens the circuit after consecutive failures and stops calling the provider', async () => {
    const a = new FakeAdapter('flaky', 'fail');
    const b = new FakeAdapter('backup', 'ok');
    const e = engine([a, b], [cfg('flaky', 10), cfg('backup', 200)]);
    for (let i = 0; i < 5; i++) await e.execute('company_registration', q, opts());
    const callsBefore = a.calls;
    const r = await e.execute('company_registration', q, opts());
    expect(a.calls).toBe(callsBefore);
    expect(r.attempts[0]!.outcome).toBe('circuit_open');
    expect(r.status).toBe('found');
  });

  it('respects the per-request cost ceiling (protects the R3 margin)', async () => {
    const a = new FakeAdapter('fails', 'fail');
    const b = new FakeAdapter('expensive', 'ok');
    const r = await engine([a, b], [cfg('fails', 100), cfg('expensive', 400)]).execute('company_registration', q, opts({ costCeilingCents: 240 }));
    expect(r.status).toBe('unavailable');
    expect(r.status === 'unavailable' && r.reason).toBe('budget_exhausted');
    expect(b.calls).toBe(0);
  });

  it('confirms a cached-copy "not found" with a live source for new companies', async () => {
    const cached = new FakeAdapter('cached_copy', 'not_found');
    const live = new FakeAdapter('live', 'ok');
    const r = await engine([cached, live], [cfg('cached_copy', 50, { isLiveSource: false }), cfg('live', 200)]).execute(
      'company_registration',
      q,
      opts({ confirmNotFoundWithLiveSource: true }),
    );
    expect(r.status === 'found' && r.provider).toBe('live');
    expect(r.attempts.map((x) => x.outcome)).toEqual(['not_found', 'success']);
  });

  it('treats not-found from a live source as authoritative', async () => {
    const r = await engine([new FakeAdapter('live', 'not_found')], [cfg('live', 50)]).execute('company_registration', q, opts());
    expect(r).toMatchObject({ status: 'not_found', authoritative: true });
  });

  it('detects an upstream outage and short-circuits further requests', async () => {
    const a = new FakeAdapter('a', 'fail');
    const b = new FakeAdapter('b', 'fail');
    const e = engine([a, b], [cfg('a', 50), cfg('b', 60)]);
    const first = await e.execute('company_registration', q, opts());
    expect(first.status).toBe('unavailable');
    const calls = a.calls + b.calls;
    const second = await e.execute('company_registration', q, opts());
    expect(second.status === 'unavailable' && second.reason).toBe('upstream_degraded');
    expect(a.calls + b.calls).toBe(calls);
    // freshness=live callers bypass the short-circuit
    const third = await e.execute('company_registration', q, opts({ ignoreUpstreamDegraded: true }));
    expect(third.status === 'unavailable' && third.reason).toBe('all_failed');
  });
});
