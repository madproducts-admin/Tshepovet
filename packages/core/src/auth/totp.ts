import crypto from 'node:crypto';

/**
 * TOTP (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits) - what every authenticator app
 * speaks. Secrets are 160 random bits, shown to the user as RFC 4648 base32.
 */
const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function totpStep(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

export function totpCode(secretB32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Checks a code against the current step and one step either side (clock drift). Returns the
 * matching step, so the caller can refuse to accept the same step twice (replay), or null.
 */
export function verifyTotp(secretB32: string, code: string, opts: { nowMs?: number; window?: number; notAfterStep?: number | null } = {}): number | null {
  const clean = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const now = totpStep(opts.nowMs);
  const window = opts.window ?? 1;
  for (let d = -window; d <= window; d++) {
    const step = now + d;
    if (opts.notAfterStep != null && step <= opts.notAfterStep) continue;
    const expected = Buffer.from(totpCode(secretB32, step));
    if (crypto.timingSafeEqual(expected, Buffer.from(clean))) return step;
  }
  return null;
}

export function otpauthUri(issuer: string, account: string, secretB32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
