import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import express, { type Request } from 'express';
import { AppModule } from './app.module';
import type { Container } from './container';
import { ProblemFilter } from './http/problem.filter';
import { apiKeyAuth } from './http/middleware/auth';
import { errorHandler } from './http/middleware/errorHandler';
import { idempotency } from './http/middleware/idempotency';
import { rateLimit } from './http/middleware/rateLimit';
import { requestContext } from './http/middleware/requestContext';
import { NestPinoLogger } from './nest-logger';

/**
 * Builds the HTTP application around a ready Container: used by main.ts and by the
 * integration tests. Not yet listening; call app.listen() or pass app.getHttpServer() to
 * supertest.
 *
 * The Express pipeline is the one the API had before the NestJS port, in the same order:
 *   request id -> JSON body (256 KB, raw body kept for webhook signatures)
 *   -> /v1/verify: API key (verify:write), 50 req/s per key, Idempotency-Key
 *   -> /v1/verifications: API key (verify:read), 100 req/s per key
 *   -> Nest routes -> problem+json errors
 * The middleware is mounted on path prefixes with app.use, as before, so it also runs for
 * unknown paths under those prefixes (an unauthenticated caller gets 401, never a 404 that
 * would reveal which endpoints exist).
 */
export async function createHttpApp(c: Container): Promise<INestApplication> {
  const server = express();
  server.disable('x-powered-by');
  server.set('trust proxy', 1);

  const app = await NestFactory.create(AppModule.register(c), new ExpressAdapter(server), {
    bodyParser: false,
    logger: new NestPinoLogger(c.log),
  });

  app.use(requestContext);
  app.use(
    express.json({
      limit: '256kb',
      verify: (req, _res, buf) => {
        (req as Request).rawBody = buf; // needed for webhook signature checks
      },
    }),
  );
  const pepper = Buffer.from(c.config.API_KEY_PEPPER, 'base64');
  app.use('/v1/verify', apiKeyAuth(c.pool, pepper, 'verify:write'), rateLimit(c.redis, 50), idempotency(c.pool));
  app.use('/v1/verifications', apiKeyAuth(c.pool, pepper, 'verify:read'), rateLimit(c.redis, 100));
  // Errors the middleware above passes to next() - a malformed JSON body, a bad API key, a rate
  // limit - are answered here, by the pre-port errorHandler. Left to Nest, a body-parser error
  // would arrive wrapped as a generic 400 instead of invalid_json.
  app.use(errorHandler(c.log));
  // Errors thrown in the controllers, and Nest's own 404 for unknown routes.
  app.useGlobalFilters(new ProblemFilter(c.log));

  await app.init();
  return app;
}
