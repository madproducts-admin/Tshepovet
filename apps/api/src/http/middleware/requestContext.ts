import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthContext } from '@tshepovet/core';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthContext;
      rawBody?: Buffer;
      /** Parsed Cookie header (portal routes only). */
      cookies?: Record<string, string>;
      /** The buyer-portal session, when the session cookie is valid. */
      portal?: { token: string; session: import('@tshepovet/core').SessionData };
      /** The staff-console session, when the staff cookie is valid. */
      staff?: { token: string; session: import('@tshepovet/core').SessionData };
    }
  }
}

export function requestContext(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : `req_${randomUUID().replace(/-/g, '')}`;
  res.setHeader('x-request-id', req.requestId);
  next();
}
