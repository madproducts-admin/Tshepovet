import Redis from 'ioredis';
import { PDFDocument } from 'pdf-lib';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MetaSchema, TopupResultSchema } from '@tshepovet/contracts';
import { buildTestApp, ownerPool, resetDatabase } from './harness';
import { type Browser, ownerWithMfa } from './portal-helpers';

/**
 * Once TshepoVet's operator is a VAT vendor (SELLER_VAT_NUMBER set), top-ups carry 15% VAT and
 * their invoices are tax invoices; portal.test.ts covers today's case, not registered: no VAT,
 * plain invoices (the owner, 2026-11-17: "We are not VAT registered yet").
 */
const SELLER = {
  SELLER_VAT_NUMBER: '4123456789',
  SELLER_REGISTRATION_NUMBER: '2015/123456/07',
  SELLER_ADDRESS: '1 Test Street, Testville, 0001',
  SELLER_DIRECTORS: 'Ann Lee, Ben Moyo',
  SELLER_EMAIL: 'hello@seller.example',
  SELLER_INFORMATION_OFFICER: 'Ann Lee',
  SELLER_INFORMATION_REGULATOR_NUMBER: '2026-000001',
};
let t: Awaited<ReturnType<typeof buildTestApp>>;
let owner: Pool;
let A: { b: Browser };
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  await resetDatabase();
  const r = new Redis(process.env.TEST_REDIS_URL!);
  await r.flushdb();
  await r.quit();
  for (const [k, v] of Object.entries(SELLER)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  owner = ownerPool();
  t = await buildTestApp();
  A = await ownerWithMfa(t.app, owner, 'owner@vat.example', 'VAT Buyer (Pty) Ltd');
}, 120_000);

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await t?.close();
  await owner?.end();
});

describe('a VAT-registered operator', () => {
  it('says so in the public facts, with the details for the terms and the privacy notice', async () => {
    const res = await request(t.app).get('/api/meta');
    const m = MetaSchema.parse(res.body);
    expect([m.vat_registered, m.vat_rate]).toEqual([true, 0.15]);
    expect(m.seller).toMatchObject({
      registration_number: '2015/123456/07',
      vat_number: '4123456789',
      directors: ['Ann Lee', 'Ben Moyo'],
      email: 'hello@seller.example',
      phone: null,
      information_officer: 'Ann Lee',
      information_regulator_number: '2026-000001',
    });
  });

  it('adds 15% VAT to a top-up and issues a tax invoice', async () => {
    const res = await A.b.post('/api/wallet/topups', { credit_cents: 100_000 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const top = TopupResultSchema.parse(res.body);
    expect(top.topup).toMatchObject({ credit_cents: 100_000, vat_cents: 15_000, gross_cents: 115_000 });
    const pdf = await A.b.agent.get(`/api/wallet/topups/${top.topup.id}/invoice.pdf`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    const doc = await PDFDocument.load(pdf.body as Buffer);
    expect(doc.getTitle()).toBe(`Specimen tax invoice ${top.topup.tax_invoice_number}`);
  });
});
