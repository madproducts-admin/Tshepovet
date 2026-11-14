import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { EnterpriseNumberError } from '../domain/sa/cipc';
import { SaIdError } from '../domain/sa/saId';
import { TcsPinError } from '../domain/sa/tax';
import { ApiError, Errors } from '../lib/errors';
import type { Logger } from '../lib/logger';

export function errorHandler(log: Logger) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    let apiErr: ApiError;
    if (err instanceof ApiError) apiErr = err;
    else if (err instanceof ZodError) {
      apiErr = Errors.validation({ issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    } else if (err instanceof EnterpriseNumberError) apiErr = new ApiError(400, 'invalid_registration_number', err.message);
    else if (err instanceof SaIdError) apiErr = new ApiError(400, 'invalid_id_number', err.message);
    else if (err instanceof TcsPinError) apiErr = new ApiError(400, 'invalid_tcs_pin', err.message);
    else if (err instanceof SyntaxError && 'body' in (err as object)) apiErr = new ApiError(400, 'invalid_json', 'Request body is not valid JSON');
    else {
      log.error({ err, requestId: req.requestId }, 'unhandled error');
      apiErr = new ApiError(500, 'internal_error', 'An unexpected error occurred');
    }
    res.status(apiErr.status).type('application/problem+json').json(apiErr.toProblem(req.requestId));
  };
}
