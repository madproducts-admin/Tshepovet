import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Crypto, LocalKeyProvider } from '../src/lib/crypto';
import { signWebhook, verifyWebhook } from '../src/webhooks/signing';
import { verifyMetaSignature } from '../src/whatsapp/inbound';
import { backoffMs } from '../src/webhooks/dispatcher';

const k = () => crypto.randomBytes(32).toString('base64');

describe('envelope encryption', () => {
  const c = new Crypto(new LocalKeyProvider(`1:${k()},2:${k()}`), crypto.randomBytes(32));

  it('round-trips and uses the newest KEK', async () => {
    const blob = await c.encrypt('8001015009087', 'director_id:v1');
    expect(Crypto.keyVersionOf(blob)).toBe(2);
    expect(await c.decryptString(blob, 'director_id:v1')).toBe('8001015009087');
  });

  it('fails when the ciphertext is moved to another context (AAD)', async () => {
    const blob = await c.encrypt('PIN123ABC', 'tcs_pin:tenantA:vendor1');
    await expect(c.decrypt(blob, 'tcs_pin:tenantA:vendor2')).rejects.toThrow();
  });

  it('blind indexes are deterministic but scoped', () => {
    expect(c.blindIndex('sa_id', 'x').equals(c.blindIndex('sa_id', 'x'))).toBe(true);
    expect(c.blindIndex('sa_id', 'x').equals(c.blindIndex('msisdn', 'x'))).toBe(false);
    expect(c.blindIndex('sa_id', 'x', 'tenantA').equals(c.blindIndex('sa_id', 'x', 'tenantB'))).toBe(false);
  });
});

describe('webhook signatures', () => {
  it('verifies, rejects tampering and stale timestamps', () => {
    const body = JSON.stringify({ id: 'evt_1' });
    const header = signWebhook(['whsec_a'], body, 1_000_000);
    expect(verifyWebhook(header, body, 'whsec_a', 300, 1_000_100)).toBe(true);
    expect(verifyWebhook(header, body + ' ', 'whsec_a', 300, 1_000_100)).toBe(false);
    expect(verifyWebhook(header, body, 'whsec_b', 300, 1_000_100)).toBe(false);
    expect(verifyWebhook(header, body, 'whsec_a', 300, 1_000_400)).toBe(false);
  });

  it('supports secret rotation with multiple v1 signatures', () => {
    const body = '{}';
    const header = signWebhook(['old', 'new'], body, 5);
    expect(verifyWebhook(header, body, 'new', 300, 5)).toBe(true);
    expect(verifyWebhook(header, body, 'old', 300, 5)).toBe(true);
  });

  it('verifies Meta X-Hub-Signature-256', () => {
    const raw = Buffer.from('{"object":"whatsapp_business_account"}');
    const sig = 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(raw).digest('hex');
    expect(verifyMetaSignature(raw, sig, 'app-secret')).toBe(true);
    expect(verifyMetaSignature(raw, sig, 'other')).toBe(false);
    expect(verifyMetaSignature(raw, undefined, 'app-secret')).toBe(false);
  });

  it('backs off exponentially with a cap', () => {
    expect(backoffMs(1, () => 0.5)).toBe(30_000);
    expect(backoffMs(3, () => 0.5)).toBe(120_000);
    expect(backoffMs(30, () => 0.5)).toBe(6 * 3_600_000);
  });
});
