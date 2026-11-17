import type { NextFunction, Request, Response } from 'express';
import { ApiError, type RedisClient } from '@tshepovet/core';
import { clientIp } from '../../portal/auth.service';

/**
 * A fixed one-minute window on every /api request, after the session is known (docs/PLAN.md
 * M9). Each signed-in session (buyer, staff or supplier) has its own allowance; anonymous
 * visitors share one per address. The web server's own calls on loopback (no forwarding
 * headers: it renders public pages such as passports) get a larger shared allowance rather
 * than none, so a request mistaken for it is still bounded. Sign-in and sign-up keep their
 * own, much stricter, per-address limits. Fails open if Redis is down.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function portalRateLimit(redis: RedisClient, limits: { session: number; anonymous: number; internal: number }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const s = req.portal?.session ?? req.staff?.session ?? req.vendor?.session;
    let who: string;
    let limit: number;
    if (s) {
      who = `s:${s.kind}:${s.subjectId}`;
      limit = limits.session;
    } else if (!req.header('cf-connecting-ip') && !req.header('x-forwarded-for') && LOOPBACK.has(req.socket.remoteAddress ?? '')) {
      who = 'internal';
      limit = limits.internal;
    } else {
      who = `ip:${clientIp(req) ?? 'unknown'}`;
      limit = limits.anonymous;
    }
    const minute = Math.floor(Date.now() / 60_000);
    const key = `tv:rl:api:${who}:${minute}`;
    try {
      const [[, count]] = (await redis.multi().incr(key).expire(key, 120).exec()) as [[Error | null, number]];
      res.setHeader('ratelimit-limit', String(limit));
      res.setHeader('ratelimit-remaining', String(Math.max(0, limit - count)));
      if (count > limit) {
        res.setHeader('retry-after', String(60 - (Math.floor(Date.now() / 1000) % 60)));
        return next(new ApiError(429, 'rate_limited', 'Too many requests. Wait a minute and try again.'));
      }
    } catch {
      /* fail open: Redis down must not take the portal with it */
    }
    next();
  };
}
