import type { Pool } from 'pg';
import {
  bureauSpecsFromEnv,
  CapabilityConfigSource,
  CheckResolver,
  CompanyVerificationService,
  type Config,
  ConsentService,
  Crypto,
  DriverLicenceVerificationService,
  HealthTracker,
  HttpBureauAdapter,
  LocalKeyProvider,
  type Logger,
  MockProvider,
  PgCapabilityConfig,
  type ProviderAdapter,
  type RedisClient,
  StaticCapabilityConfig,
  VerificationCache,
  WaterfallEngine,
} from '@tshepovet/core';

/**
 * The composition root: every service the HTTP layer and the worker use, built once per
 * process. Nest provides it under CONTAINER (see app.module.ts) rather than constructing the
 * services itself, so the domain stays framework-free and the tests can build it directly.
 */
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

export const CONTAINER = Symbol('tshepovet.container');

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
