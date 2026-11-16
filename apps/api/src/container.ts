import type { Pool } from 'pg';
import {
  AccountStore,
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
  MfaChallengeStore,
  MockProvider,
  PgCapabilityConfig,
  type ProviderAdapter,
  type RedisClient,
  SessionStore,
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
  /** Portal accounts (docs/PLAN.md M2). */
  accounts: AccountStore;
  sessions: SessionStore;
  mfa: MfaChallengeStore;
  /** Secure, __Host- cookies (HTTPS); off only for plain-http tests and local runs. */
  cookieSecure: boolean;
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
  const accounts = new AccountStore(pool);
  const sessions = new SessionStore(redis, { idleSeconds: config.SESSION_IDLE_MINUTES * 60, absoluteSeconds: config.SESSION_ABSOLUTE_HOURS * 3600 });
  const mfa = new MfaChallengeStore(redis);
  const cookieSecure = config.COOKIE_SECURE ? config.COOKIE_SECURE === 'true' : config.NODE_ENV === 'production';
  return { config, pool, redis, crypto, log, cache, resolvers, consent, company, driver, accounts, sessions, mfa, cookieSecure };
}
