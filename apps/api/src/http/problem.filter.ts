import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError, type Logger } from '@tshepovet/core';
import { errorHandler } from './middleware/errorHandler';

/**
 * Every error becomes an RFC 9457 problem+json response, built by the same errorHandler the
 * API used before the NestJS port, so error bodies are unchanged. Nest's own HTTP exceptions
 * (an unknown route's 404, for example) are mapped to an ApiError first.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly handle: ReturnType<typeof errorHandler>;

  constructor(log: Logger) {
    this.handle = errorHandler(log);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    if (res.headersSent) return;
    let err = exception;
    if (exception instanceof HttpException && !(exception instanceof ApiError)) {
      const status = exception.getStatus();
      err = new ApiError(status, status === 404 ? 'not_found' : `http_${status}`, status === 404 ? `No route for ${req.method} ${req.path}` : exception.message);
    }
    this.handle(err, req, res, () => undefined);
  }
}
