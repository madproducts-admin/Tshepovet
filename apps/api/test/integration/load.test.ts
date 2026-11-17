import Redis from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, createTenant, ownerPool, resetDatabase } from './harness';

/**
 * A load test of the check path (docs/PLAN.md M9), opt-in: TSV_LOAD=1. Company checks through
 * the real HTTP stack, database and Redis, answered by the mock bureau, at a fixed concurrency.
 * The budget: no server errors, and 95% of checks answered within 1.5 s on this shared box.
 */
const RUN = Boolean(process.env.TSV_LOAD);
const TOTAL = Number(process.env.TSV_LOAD_TOTAL ?? 300);
const CONCURRENCY = Number(process.env.TSV_LOAD_CONCURRENCY ?? 10);

let t: Awaited<ReturnType<typeof buildTestApp>>;
let owner: Pool;
let key = '';

describe.skipIf(!RUN)('the check path under load', () => {
  beforeAll(async () => {
    await resetDatabase();
    const r = new Redis(process.env.TEST_REDIS_URL!);
    await r.flushdb();
    await r.quit();
    owner = ownerPool();
    t = await buildTestApp();
    key = (await createTenant(owner, 'Load Test Buyers (Pty) Ltd', 0)).keys.test;
  }, 120_000);
  afterAll(async () => {
    await t?.close();
    await owner?.end();
  });

  it(`answers ${TOTAL} company checks at concurrency ${CONCURRENCY} within budget`, async () => {
    const times: number[] = [];
    const statuses = new Map<number, number>();
    let next = 0;
    // Distinct companies, so the cache does not answer them all; the mock's registry is any number.
    const reg = (i: number) => `20${String(10 + (i % 15)).padStart(2, '0')}/${String(100000 + i).padStart(6, '0')}/07`;
    const worker = async () => {
      while (next < TOTAL) {
        const i = next++;
        const start = performance.now();
        const res = await request(t.app).post('/v1/verify/company').set('authorization', `Bearer ${key}`).send({ registration_number: reg(i) });
        times.push(performance.now() - start);
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      }
    };
    const began = performance.now();
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    const wall = (performance.now() - began) / 1000;
    times.sort((a, b) => a - b);
    const p = (q: number) => Math.round(times[Math.min(times.length - 1, Math.floor(q * times.length))]!);
    const report = { total: TOTAL, concurrency: CONCURRENCY, seconds: Number(wall.toFixed(1)), per_second: Number((TOTAL / wall).toFixed(1)), p50_ms: p(0.5), p95_ms: p(0.95), p99_ms: p(0.99), statuses: Object.fromEntries(statuses) };
    console.log('LOAD', JSON.stringify(report));
    expect([...statuses.keys()].filter((s) => s >= 500)).toEqual([]);
    expect(report.p95_ms).toBeLessThan(1500);
  }, 600_000);
});
