import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './harness';

/**
 * HTTP-pipeline behaviour that the NestJS port must keep (docs/PLAN.md M1): ordering of the
 * middleware, problem+json for every error, and no information leaks. None of it needs data.
 */
let t: Awaited<ReturnType<typeof buildTestApp>>;

beforeAll(async () => {
  t = await buildTestApp();
});

afterAll(async () => {
  await t?.close();
});

const isProblem = (res: request.Response, status: number, code: string) => {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(res.body).toMatchObject({ status, code, type: `https://docs.tshepovet.co.za/errors/${code}` });
  expect(res.body.request_id).toBe(res.headers['x-request-id']);
};

describe('HTTP pipeline', () => {
  it('answers /healthz and sends no server banner', async () => {
    const res = await request(t.app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('echoes a well-formed X-Request-Id and replaces a malformed one', async () => {
    const ok = await request(t.app).get('/healthz').set('x-request-id', 'req-client-12345678');
    expect(ok.headers['x-request-id']).toBe('req-client-12345678');
    const bad = await request(t.app).get('/healthz').set('x-request-id', 'no spaces <allowed>');
    expect(bad.headers['x-request-id']).toMatch(/^req_[0-9a-f]{32}$/);
  });

  it('answers an unknown route with a problem+json 404', async () => {
    isProblem(await request(t.app).get('/no-such-route'), 404, 'not_found');
  });

  it('rejects a malformed JSON body with invalid_json, before authentication', async () => {
    const res = await request(t.app).post('/v1/verify/company').set('content-type', 'application/json').send('{bad');
    isProblem(res, 400, 'invalid_json');
    expect(res.body.title).toBe('Request body is not valid JSON');
  });

  it('authenticates every path under /v1/verify, so unknown endpoints are not revealed', async () => {
    isProblem(await request(t.app).get('/v1/verify/does-not-exist'), 401, 'unauthorized');
    isProblem(await request(t.app).get('/v1/verifications/not-a-uuid'), 401, 'unauthorized');
  });

  it('rejects a malformed API key', async () => {
    isProblem(await request(t.app).post('/v1/verify/company').set('authorization', 'Bearer tv_live_short.x').send({}), 401, 'unauthorized');
  });

  it('keeps the WhatsApp webhook closed until it is configured', async () => {
    isProblem(await request(t.app).get('/webhooks/whatsapp?hub.mode=subscribe'), 404, 'not_found');
  });
});
