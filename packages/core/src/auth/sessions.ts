import crypto from 'node:crypto';
import type { RedisClient } from '../lib/redis';
import { newOpaqueToken, tokenHash } from './tokens';

/**
 * Server-side sessions in Redis. The cookie carries a 256-bit opaque token; Redis is keyed by
 * its SHA-256, so a Redis dump yields no usable session. Each session has an idle timeout
 * (refreshed on use) and an absolute lifetime. A per-subject index lets a user list and end
 * their sessions, and lets a password change end all of them.
 */
export type SessionKind = 'user' | 'staff';

/** 'full': normal access. 'mfa_setup': a role that must use MFA has not enrolled yet - only
 * the enrolment endpoints and sign-out are allowed until it does. */
export type SessionStage = 'full' | 'mfa_setup';

export interface SessionData {
  sid: string; // public id, shown in the sessions list
  kind: SessionKind;
  subjectId: string;
  tenantId: string | null;
  role: string;
  stage: SessionStage;
  csrf: string;
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
  ip: string | null;
  userAgent: string | null;
}

export interface SessionPolicy {
  idleSeconds: number;
  absoluteSeconds: number;
}

const key = (hashHex: string) => `tv:sess:${hashHex}`;
const indexKey = (kind: SessionKind, subjectId: string) => `tv:sess:idx:${kind}:${subjectId}`;

export class SessionStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly policy: SessionPolicy,
  ) {}

  async create(input: Omit<SessionData, 'sid' | 'csrf' | 'createdAt' | 'lastSeenAt' | 'absoluteExpiresAt'>): Promise<{ token: string; data: SessionData }> {
    const { token, hash } = newOpaqueToken();
    const now = Date.now();
    const data: SessionData = {
      ...input,
      sid: crypto.randomBytes(9).toString('base64url'),
      csrf: crypto.randomBytes(32).toString('base64url'),
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: now + this.policy.absoluteSeconds * 1000,
    };
    const h = hash.toString('hex');
    await this.redis
      .multi()
      .set(key(h), JSON.stringify(data), 'EX', this.ttl(data, now))
      .sadd(indexKey(data.kind, data.subjectId), h)
      .expire(indexKey(data.kind, data.subjectId), this.policy.absoluteSeconds)
      .exec();
    return { token, data };
  }

  /** The session for a cookie token, its idle timer refreshed; null if unknown or expired. */
  async touch(token: string): Promise<SessionData | null> {
    const h = tokenHash(token).toString('hex');
    const raw = await this.redis.get(key(h));
    if (!raw) return null;
    const data = JSON.parse(raw) as SessionData;
    const now = Date.now();
    if (now >= data.absoluteExpiresAt) {
      await this.removeHash(data.kind, data.subjectId, h);
      return null;
    }
    // Refresh at most once a minute: every request does not need a Redis write.
    if (now - data.lastSeenAt > 60_000) {
      data.lastSeenAt = now;
      await this.redis.set(key(h), JSON.stringify(data), 'EX', this.ttl(data, now));
    }
    return data;
  }

  /** Replaces a session's stage or role (after MFA enrolment, or a role change). */
  async update(token: string, patch: Partial<Pick<SessionData, 'stage' | 'role'>>): Promise<SessionData | null> {
    const h = tokenHash(token).toString('hex');
    const raw = await this.redis.get(key(h));
    if (!raw) return null;
    const data = { ...(JSON.parse(raw) as SessionData), ...patch };
    await this.redis.set(key(h), JSON.stringify(data), 'EX', this.ttl(data, Date.now()));
    return data;
  }

  /** Applies a role change to every live session of a subject, so it takes effect at once. */
  async patchAll(kind: SessionKind, subjectId: string, patch: Partial<Pick<SessionData, 'role'>>): Promise<void> {
    const now = Date.now();
    for (const s of await this.list(kind, subjectId)) {
      const { hashHex, ...data } = s;
      const next = { ...data, ...patch };
      await this.redis.set(key(hashHex), JSON.stringify(next), 'EX', this.ttl(next, now));
    }
  }

  async destroy(token: string): Promise<void> {
    const h = tokenHash(token).toString('hex');
    const raw = await this.redis.get(key(h));
    if (!raw) return;
    const data = JSON.parse(raw) as SessionData;
    await this.removeHash(data.kind, data.subjectId, h);
  }

  async list(kind: SessionKind, subjectId: string): Promise<Array<SessionData & { hashHex: string }>> {
    const hashes = await this.redis.smembers(indexKey(kind, subjectId));
    const out: Array<SessionData & { hashHex: string }> = [];
    for (const h of hashes) {
      const raw = await this.redis.get(key(h));
      if (raw) out.push({ ...(JSON.parse(raw) as SessionData), hashHex: h });
      else await this.redis.srem(indexKey(kind, subjectId), h);
    }
    return out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  /** Ends one session by its public id. Returns whether it existed. */
  async destroyBySid(kind: SessionKind, subjectId: string, sid: string): Promise<boolean> {
    const s = (await this.list(kind, subjectId)).find((x) => x.sid === sid);
    if (!s) return false;
    await this.removeHash(kind, subjectId, s.hashHex);
    return true;
  }

  /** Ends every session of a subject, except (optionally) the one making the request. */
  async destroyAll(kind: SessionKind, subjectId: string, exceptToken?: string): Promise<number> {
    const keep = exceptToken ? tokenHash(exceptToken).toString('hex') : null;
    let n = 0;
    for (const s of await this.list(kind, subjectId)) {
      if (s.hashHex === keep) continue;
      await this.removeHash(kind, subjectId, s.hashHex);
      n++;
    }
    return n;
  }

  private ttl(data: SessionData, now: number): number {
    const remaining = Math.ceil((data.absoluteExpiresAt - now) / 1000);
    return Math.max(1, Math.min(this.policy.idleSeconds, remaining));
  }

  private async removeHash(kind: SessionKind, subjectId: string, h: string) {
    await this.redis.multi().del(key(h)).srem(indexKey(kind, subjectId), h).exec();
  }
}

/**
 * A pending second factor: password accepted, TOTP or recovery code still to come. Lives five
 * minutes, allows five attempts, and is single-use.
 */
export interface MfaChallenge {
  kind: SessionKind;
  subjectId: string;
  attempts: number;
}

export class MfaChallengeStore {
  constructor(private readonly redis: RedisClient) {}

  async create(kind: SessionKind, subjectId: string): Promise<string> {
    const { token, hash } = newOpaqueToken();
    const data: MfaChallenge = { kind, subjectId, attempts: 0 };
    await this.redis.set(`tv:mfa:challenge:${hash.toString('hex')}`, JSON.stringify(data), 'EX', 300);
    return token;
  }

  async get(token: string): Promise<MfaChallenge | null> {
    const raw = await this.redis.get(`tv:mfa:challenge:${tokenHash(token).toString('hex')}`);
    return raw ? (JSON.parse(raw) as MfaChallenge) : null;
  }

  /** Counts a wrong code; the challenge is gone after the fifth. */
  async fail(token: string): Promise<void> {
    const k = `tv:mfa:challenge:${tokenHash(token).toString('hex')}`;
    const raw = await this.redis.get(k);
    if (!raw) return;
    const data = JSON.parse(raw) as MfaChallenge;
    data.attempts++;
    if (data.attempts >= 5) await this.redis.del(k);
    else await this.redis.set(k, JSON.stringify(data), 'KEEPTTL');
  }

  async consume(token: string): Promise<void> {
    await this.redis.del(`tv:mfa:challenge:${tokenHash(token).toString('hex')}`);
  }

  /** Remembers the last TOTP step accepted for a subject, so a code cannot be replayed. */
  async lastStep(kind: SessionKind, subjectId: string): Promise<number | null> {
    const v = await this.redis.get(`tv:mfa:last:${kind}:${subjectId}`);
    return v === null ? null : Number(v);
  }

  async recordStep(kind: SessionKind, subjectId: string, step: number): Promise<void> {
    await this.redis.set(`tv:mfa:last:${kind}:${subjectId}`, String(step), 'EX', 300);
  }

  /** A secret generated during enrolment, not yet confirmed with a first code. */
  async setPendingSecret(kind: SessionKind, subjectId: string, secret: string): Promise<void> {
    await this.redis.set(`tv:mfa:pending:${kind}:${subjectId}`, secret, 'EX', 900);
  }

  async takePendingSecret(kind: SessionKind, subjectId: string): Promise<string | null> {
    const k = `tv:mfa:pending:${kind}:${subjectId}`;
    const v = await this.redis.get(k);
    return v;
  }

  async clearPendingSecret(kind: SessionKind, subjectId: string): Promise<void> {
    await this.redis.del(`tv:mfa:pending:${kind}:${subjectId}`);
  }
}
