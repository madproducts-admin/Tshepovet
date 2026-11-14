import express, { Express } from 'express';
import type { Pool } from 'pg';
import { VerificationCache } from './cache/verificationCache';
import type { Config } from './config';
import { ConsentService } from './consent/consentService';
import { Crypto, LocalKeyProvider } from './lib/crypto';
import type { Logger } from './lib/logger';
import type { RedisClient } from './lib/redis';
import { apiKeyAuth } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import { idempotency } from './middleware/idempotency';
import { rateLimit } from './middleware/rateLimit';
import { requestContext } from './middleware/requestContext';
import { bureauSpecsFromEnv, HttpBureauAdapter } from './providers/adapters/httpBureau';
import { MockProvider } from './providers/adapters/mockProvider';
import type { ProviderAdapter } from './providers/types';
import { verificationsRouter, verifyRouter } from './routes/verify';
import { CheckResolver } from './services/checkResolver';
import { CompanyVerificationService } from './services/companyVerification';
import { DriverLicenceVerificationService } from './services/driverLicenceVerification';
import { CapabilityConfigSource, PgCapabilityConfig, StaticCapabilityConfig, WaterfallEngine } from './waterfall/engine';
import { HealthTracker } from './waterfall/health';
import type { Router } from 'express';

export interface Container {
  config: Config;
  pool: Pool;
  redis: RedisClient;
  crypto: Crypto;
  log: Logger;
  cache: VerificationCache;
  resolvers: { live: CheckResolver; test: CheckResolver };
  consent: ConsentService;
  company: CompanyVerificationService;
  driver: DriverLicenceVerificationService;
}

export interface ContainerOverrides {
  liveAdapters?: ProviderAdapter[];
  liveCapabilityConfig?: CapabilityConfigSource;
}

/** Sandbox keys (tv_test_) only ever reach the deterministic mock provider. */
const SANDBOX_CONFIG = new StaticCapabilityConfig(
  (['company_registration', 'vat_status', 'tax_compliance_status', 'driver_licence', 'id_verification'] as const).map((capability) => ({
    providerCode: 'mock',
    capability,
    unitCostCents: 0,
    volumeTiers: [],
    prepaidRemaining: null,
    isLiveSource: true,
    timeoutMs: 2000,
    enabled: true,
  })),
);

export function buildContainer(config: Config, pool: Pool, redis: RedisClient, log: Logger, o: ContainerOverrides = {}): Container {
  const crypto = new Crypto(new LocalKeyProvider(config.KEK_KEYS), Buffer.from(config.BLIND_INDEX_ROOT_KEY, 'base64'));
  const cache = new VerificationCache(pool, redis, crypto);

  const enabled = new Set(config.ENABLED_PROVIDERS.split(',').map((s) => s.trim()).filter(Boolean));
  const liveAdapters =
    o.liveAdapters ??
    [
      ...bureauSpecsFromEnv(process.env).map((s) => new HttpBureauAdapter(s)),
      ...(enabled.has('mock') && config.NODE_ENV !== 'production' ? [new MockProvider('mock')] : []),
    ].filter((a) => enabled.has(a.code));

  const liveEngine = new WaterfallEngine(liveAdapters, o.liveCapabilityConfig ?? new PgCapabilityConfig(pool), new HealthTracker(redis, 'tv:health:live'), log);
  const testEngine = new WaterfallEngine([new MockProvider('mock')], SANDBOX_CONFIG, new HealthTracker(redis, 'tv:health:test'), log);
  const resolvers = { live: new CheckResolver(cache, liveEngine), test: new CheckResolver(cache, testEngine) };
  const consent = new ConsentService();

  const company = new CompanyVerificationService({
    pool,
    crypto,
    resolvers,
    consent,
    log,
    syncDeadlineMs: config.SYNC_DEADLINE_MS,
    costCeilingCents: config.COMPANY_CHECK_COST_CEILING_CENTS,
  });
  const driver = new DriverLicenceVerificationService({
    pool,
    crypto,
    resolvers,
    consent,
    log,
    syncDeadlineMs: config.SYNC_DEADLINE_MS,
    costCeilingCents: config.DRIVER_CHECK_COST_CEILING_CENTS,
  });
  return { config, pool, redis, crypto, log, cache, resolvers, consent, company, driver };
}

export function createApp(c: Container, extraRouters: Array<{ path: string; router: Router }> = []): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(requestContext);
  app.use(
    express.json({
      limit: '256kb',
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf; // needed for webhook signature checks
      },
    }),
  );

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  for (const { path, router } of extraRouters) app.use(path, router);

  const pepper = Buffer.from(c.config.API_KEY_PEPPER, 'base64');
  const v1 = express.Router();
  v1.use('/verify', apiKeyAuth(c.pool, pepper, 'verify:write'), rateLimit(c.redis, 50), idempotency(c.pool));
  v1.use('/verifications', apiKeyAuth(c.pool, pepper, 'verify:read'), rateLimit(c.redis, 100));
  v1.use(verifyRouter({ pool: c.pool, company: c.company, driver: c.driver }));
  v1.use(verificationsRouter(c.pool));
  app.use('/v1', v1);

  app.use(errorHandler(c.log));
  return app;
}
