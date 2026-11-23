import { describe, expect, it, vi } from 'vitest';
import { Readiness, type ReadinessProbes } from '../src/http/readiness';

/** GET /readyz's checker without services: probes are stand-ins, the clock is ours. */
function setup(probes: Partial<ReadinessProbes> = {}, o: { cacheMs?: number; timeoutMs?: number } = {}) {
  let clock = 1_000_000;
  const database = vi.fn(probes.database ?? (async () => ({ rows: [{ '?column?': 1 }] })));
  const redis = vi.fn(probes.redis ?? (async () => 'PONG'));
  const log = { warn: vi.fn() };
  const r = new Readiness({ database, redis }, log as never, { now: () => clock, ...o });
  return { r, database, redis, log, advance: (ms: number) => (clock += ms) };
}

describe('Readiness (GET /readyz)', () => {
  it('is ready when PostgreSQL and Redis both answer', async () => {
    const { r, database, redis, log } = setup();
    expect(await r.check()).toBe(true);
    expect(database).toHaveBeenCalledTimes(1);
    expect(redis).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('is not ready when the database fails, and logs which dependency', async () => {
    const { r, log } = setup({ database: async () => Promise.reject(new Error('connect ECONNREFUSED')) });
    expect(await r.check()).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toEqual({ dependency: 'database', reason: 'connect ECONNREFUSED' });
  });

  it('is not ready when Redis fails', async () => {
    const { r, log } = setup({ redis: async () => Promise.reject(new Error('Connection is closed.')) });
    expect(await r.check()).toBe(false);
    expect(log.warn.mock.calls[0]![0]).toMatchObject({ dependency: 'redis' });
  });

  it('is not ready when a dependency does not answer in time', async () => {
    const { r, log } = setup({ database: () => new Promise(() => {}) }, { timeoutMs: 25 });
    const started = Date.now();
    expect(await r.check()).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(log.warn.mock.calls[0]![0]).toEqual({ dependency: 'database', reason: 'no answer within 25 ms' });
  });

  it('reuses one result for cacheMs, then checks again', async () => {
    const { r, database, redis, advance } = setup({}, { cacheMs: 5_000 });
    await r.check();
    advance(4_999);
    expect(await r.check()).toBe(true);
    expect(database).toHaveBeenCalledTimes(1);
    expect(redis).toHaveBeenCalledTimes(1);
    advance(1);
    await r.check();
    expect(database).toHaveBeenCalledTimes(2);
    expect(redis).toHaveBeenCalledTimes(2);
  });

  it('lets callers who arrive during a check share it', async () => {
    let release!: () => void;
    const { r, database } = setup({ database: () => new Promise<void>((done) => (release = done)) });
    const all = Promise.all(Array.from({ length: 50 }, () => r.check()));
    release();
    expect(await all).toEqual(Array(50).fill(true));
    expect(database).toHaveBeenCalledTimes(1);
  });

  it('keeps a failure for cacheMs too, and recovers after it', async () => {
    let down = true;
    const { r, database, advance } = setup({ database: async () => (down ? Promise.reject(new Error('down')) : 1) }, { cacheMs: 5_000 });
    expect(await r.check()).toBe(false);
    down = false;
    expect(await r.check()).toBe(false);
    expect(database).toHaveBeenCalledTimes(1);
    advance(5_000);
    expect(await r.check()).toBe(true);
  });
});
