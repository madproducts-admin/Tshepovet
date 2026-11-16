import type { LoggerService } from '@nestjs/common';
import type { Logger } from '@tshepovet/core';

/** Routes Nest's own log lines into pino, so the service writes one JSON log stream. */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly pino: Logger) {}
  log(message: unknown, context?: string) {
    this.pino.debug({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string) {
    this.pino.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string) {
    this.pino.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string) {
    this.pino.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string) {
    this.pino.trace({ context }, String(message));
  }
}
