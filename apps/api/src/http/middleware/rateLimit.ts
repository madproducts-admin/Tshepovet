import type { NextFunction, Request, Response } from 'express';
import type { RedisClient } from '@tshepovet/core';
import { ApiError } from '@tshepovet/core';

/** Fixed-window limiter per API key, shared across instances via Redis. Fails open if Redis is down. */
export function rateLimit(redis: RedisClient, perSecond: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) return next();
    const window = Math.floor(Date.now() / 1000);
    const key = `tv:rl:${req.auth.apiKeyId}:${window}`;
    try {
      const [[, count]] = (await redis.multi().incr(key).expire(key, 2).exec()) as [[Error | null, number]];
      res.setHeader('ratelimit-limit', String(perSecond));
      res.setHeader('ratelimit-remaining', String(Math.max(0, perSecond - count)));
      if (count > perSecond) {
        res.setHeader('retry-after', '1');
        return next(new ApiError(429, 'rate_limited', 'Too many requests'));
      }
    } catch {
      /* fail open */
    }
    next();
  };
}
