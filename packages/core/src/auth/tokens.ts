import crypto from 'node:crypto';

/** An opaque bearer token (256 bits, base64url) and the SHA-256 that is stored instead. */
export function newOpaqueToken(): { token: string; hash: Buffer } {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: tokenHash(token) };
}

export function tokenHash(token: string): Buffer {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

/** Tokens are base64url of 32 bytes; anything else is rejected before touching the database. */
export function isWellFormedToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o, 1/l/i

/** Ten one-time recovery codes like "k3m9-x2q7-v8bd" (about 59 bits each; single-use, behind lockout). */
export function newRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const chars = Array.from(crypto.randomBytes(12), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  });
}

export function recoveryCodeHash(code: string): Buffer {
  return tokenHash(code.toLowerCase().replace(/[^a-z0-9]/g, ''));
}
