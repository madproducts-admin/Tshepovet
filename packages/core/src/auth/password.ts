import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing: argon2id with OWASP's baseline (19 MiB, 2 iterations, 1 lane).
 * `algorithm: 2` is Argon2id (@node-rs/argon2's Algorithm enum is a const enum, which an
 * isolated-modules build cannot inline).
 */
const ARGON2ID = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2ID);
}

export async function verifyPassword(passwordHash: string | null | undefined, password: string): Promise<boolean> {
  if (!passwordHash) return false;
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/**
 * For a sign-in with an unknown email: spend the same time a real check would, so response
 * timing does not reveal whether an account exists.
 */
let timingHash: Promise<string> | null = null;
export async function spendPasswordCheck(password: string): Promise<void> {
  timingHash ??= hashPassword('tshepovet:timing-equaliser');
  await verifyPassword(await timingHash, password);
}

// The most common passwords that pass the length rule (a small, offline list; a breached-
// password service can replace it).
const COMMON = new Set([
  'password1234', 'password12345', 'password123456', 'qwertyuiop12', 'qwertyuiop123', '123456789012', '1234567890ab',
  'iloveyou1234', 'welcome12345', 'letmein12345', 'administrator', 'passw0rd1234', 'p@ssword1234', 'changeme1234',
  'southafrica1', 'southafrica123', 'johannesburg', 'capetown1234', 'tshepovet123', 'abcdefghijkl', 'aaaaaaaaaaaa',
]);

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

/** Plain-language problems with a new password; empty when it is acceptable. */
export function passwordProblems(password: string, context: { email?: string | null; name?: string | null } = {}): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN) problems.push(`Use at least ${PASSWORD_MIN} characters.`);
  if (password.length > PASSWORD_MAX) problems.push(`Use at most ${PASSWORD_MAX} characters.`);
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) problems.push('This password is too common. Choose something less predictable.');
  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) problems.push('Do not include your email address.');
  for (const part of (context.name ?? '').toLowerCase().split(/\s+/)) {
    if (part.length >= 4 && lower.includes(part)) {
      problems.push('Do not include your name.');
      break;
    }
  }
  return problems;
}
