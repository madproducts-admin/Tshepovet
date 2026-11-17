import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, otpauthUri, totpCode, totpStep, verifyTotp } from '../src/auth/totp';
import { isWellFormedToken, newOpaqueToken, newRecoveryCodes, recoveryCodeHash, tokenHash } from '../src/auth/tokens';
import { hashPassword, passwordProblems, verifyPassword } from '../src/auth/password';

// RFC 6238 appendix B, SHA-1, secret "12345678901234567890"; the RFC lists 8 digits, we use the last 6.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
const VECTORS: Array<[number, string]> = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
];

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC test vectors', () => {
    for (const [t, code] of VECTORS) expect(totpCode(RFC_SECRET, Math.floor(t / 30))).toBe(code);
  });

  it('round-trips base32 and rejects other characters', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(RFC_SECRET).toString('ascii')).toBe('12345678901234567890');
    expect(base32Decode('gezd gnbv-gy3t')).toEqual(base32Decode('GEZDGNBVGY3T'));
    expect(() => base32Decode('GEZ1')).toThrow();
  });

  it('accepts one step of drift either way, and never a step already used', () => {
    const now = 1111111111 * 1000;
    const step = totpStep(now);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), { nowMs: now })).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), { nowMs: now })).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 2), { nowMs: now })).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), { nowMs: now, notAfterStep: step })).toBeNull();
    expect(verifyTotp(RFC_SECRET, '12345', { nowMs: now })).toBeNull();
  });

  it('builds an otpauth URI authenticator apps read', () => {
    const uri = otpauthUri('TshepoVet', 'a@b.example', RFC_SECRET);
    const u = new URL(uri);
    expect(u.protocol).toBe('otpauth:');
    expect(u.searchParams.get('secret')).toBe(RFC_SECRET);
    expect(u.searchParams.get('issuer')).toBe('TshepoVet');
    expect(u.searchParams.get('digits')).toBe('6');
  });
});

describe('tokens and recovery codes', () => {
  it('makes 256-bit opaque tokens and stores only their hash', () => {
    const a = newOpaqueToken();
    expect(isWellFormedToken(a.token)).toBe(true);
    expect(a.hash.equals(tokenHash(a.token))).toBe(true);
    expect(newOpaqueToken().token).not.toBe(a.token);
    expect(isWellFormedToken('short')).toBe(false);
  });

  it('makes ten distinct recovery codes, matched regardless of case and dashes', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    const c = codes[0]!;
    expect(recoveryCodeHash(c.toUpperCase().replace(/-/g, ' ')).equals(recoveryCodeHash(c))).toBe(true);
  });
});

describe('passwords', () => {
  it('hashes with argon2id and verifies', async () => {
    const h = await hashPassword('a perfectly fine passphrase');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h, 'a perfectly fine passphrase')).toBe(true);
    expect(await verifyPassword(h, 'a perfectly fine passphrasE')).toBe(false);
    expect(await verifyPassword(null, 'x')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });

  it('explains what is wrong with a weak password', () => {
    expect(passwordProblems('short')).toContain('Use at least 12 characters.');
    expect(passwordProblems('password1234').join(' ')).toMatch(/too common/);
    expect(passwordProblems('aaaaaaaaaaaaaaa').join(' ')).toMatch(/too common/);
    expect(passwordProblems('thandi-rocks-2026', { email: 'thandi@x.example' })).toContain('Do not include your email address.');
    expect(passwordProblems('mokoena is great 1', { name: 'Thandi Mokoena' })).toContain('Do not include your name.');
    expect(passwordProblems('correct horse battery 42', { email: 'sipho@acme.example', name: 'Sipho Dlamini' })).toEqual([]);
  });
});
