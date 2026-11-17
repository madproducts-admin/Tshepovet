import { describe, expect, it } from 'vitest';
import { guardedWebhookFetch, isPublicAddress, parseDenyList, publicOnlyLookup, webhookUrlProblem } from '../src/webhooks/safeTarget';

describe('webhook address guard', () => {
  it('accepts public unicast addresses only', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '41.0.0.1', '2606:4700:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '198.18.0.1',
      '::1',
      '::',
      '::ffff:127.0.0.1',
      '64:ff9b::7f00:1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      '2002:7f00:1::',
      'not-an-ip',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    expect(isPublicAddress('209.58.145.5', parseDenyList('209.58.145.5, junk'))).toBe(false);
  });

  it('explains why a URL cannot be an endpoint', async () => {
    expect(await webhookUrlProblem('https://1.1.1.1/hook')).toBeNull();
    expect(await webhookUrlProblem('http://1.1.1.1/hook')).toMatch(/https/);
    expect(await webhookUrlProblem('https://localhost/x')).toMatch(/public internet/);
    expect(await webhookUrlProblem('https://printer.local/x')).toMatch(/public internet/);
    expect(await webhookUrlProblem('https://[fe80::1]/x')).toMatch(/not on the public internet/);
    expect(await webhookUrlProblem('not a url')).toMatch(/full URL/);
  });

  it('refuses at connect time: IP literals and names that resolve privately', async () => {
    const post = guardedWebhookFetch('');
    await expect(post('https://127.0.0.1:9131/x', { method: 'POST', headers: {}, body: '{}' })).rejects.toThrow(/public address/);
    await expect(post('http://1.1.1.1/x', { method: 'POST', headers: {}, body: '{}' })).rejects.toThrow(/https/);
    const lookup = publicOnlyLookup(new Set());
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => lookup('localhost', { all: true }, (e) => resolve(e)));
    expect(err?.code).toBe('EBLOCKED');
  });
});
