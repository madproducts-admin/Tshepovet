import type { Pool } from 'pg';
import type { Logger } from '../lib/logger';
import { Capability, InputOf, OutputOf, ProviderAdapter, ProviderError } from '../providers/types';
import { HealthSnapshot, HealthTracker } from './health';

/**
 * Waterfall router.
 *
 * For each request we rank every enabled provider for the capability by an
 * EXPECTED cost (ZAR cents), not just the list price:
 *
 *   score = marginal_price
 *         + FAILURE_PENALTY  * (1 - success_rate)     // a failure costs a retry + latency
 *         + LATENCY_PENALTY  * ewma_latency_seconds   // user-facing latency has a price too
 *         + LIVE_PENALTY     * (needs live data && provider serves a cached copy)
 *
 *   marginal_price = 0 while a prepaid bundle has units left (sunk cost),
 *                    else the volume-tier price for this month's volume.
 *
 * We then try providers in ascending score order, subject to:
 *   - a per-request cost ceiling (protects the R3.00 unit margin),
 *   - an overall deadline (sync API budget),
 *   - circuit breakers (open = skip, half-open = one probe),
 *   - upstream-degradation detection (registry down -> stale cache, not a
 *     paid tour of every bureau).
 *
 * "Not found" from a bureau that serves a CACHED copy of CIPC can just mean
 * the company is too new. When the caller sets confirmNotFoundWithLiveSource
 * (newly registered numbers), we confirm with a live-source provider before
 * reporting a definitive not-found.
 */
export interface ProviderCapabilityConfig {
  providerCode: string;
  capability: Capability;
  unitCostCents: number;
  volumeTiers: Array<{ from: number; costCents: number }>;
  prepaidRemaining: number | null;
  isLiveSource: boolean;
  timeoutMs: number;
  enabled: boolean;
}

export interface CapabilityConfigSource {
  list(capability: Capability): Promise<ProviderCapabilityConfig[]>;
}

export class StaticCapabilityConfig implements CapabilityConfigSource {
  constructor(private readonly rows: ProviderCapabilityConfig[]) {}
  async list(capability: Capability) {
    return this.rows.filter((r) => r.capability === capability && r.enabled);
  }
}

/** Reads provider_capabilities, cached in-process for 60s. */
export class PgCapabilityConfig implements CapabilityConfigSource {
  private cache = new Map<Capability, { at: number; rows: ProviderCapabilityConfig[] }>();
  constructor(private readonly pool: Pool, private readonly ttlMs = 60_000) {}

  async list(capability: Capability): Promise<ProviderCapabilityConfig[]> {
    const hit = this.cache.get(capability);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.rows;
    const r = await this.pool.query(
      `SELECT pc.provider_code, pc.capability, pc.unit_cost_cents, pc.volume_tiers, pc.prepaid_remaining,
              pc.is_live_source, pc.timeout_ms, pc.enabled
         FROM provider_capabilities pc JOIN providers p ON p.code = pc.provider_code
        WHERE pc.capability = $1 AND pc.enabled AND p.is_active`,
      [capability],
    );
    const rows: ProviderCapabilityConfig[] = r.rows.map((x) => ({
      providerCode: x.provider_code,
      capability: x.capability,
      unitCostCents: x.unit_cost_cents,
      volumeTiers: (x.volume_tiers ?? []).map((t: { from: number; cost_cents: number }) => ({ from: t.from, costCents: t.cost_cents })),
      prepaidRemaining: x.prepaid_remaining,
      isLiveSource: x.is_live_source,
      timeoutMs: x.timeout_ms,
      enabled: x.enabled,
    }));
    this.cache.set(capability, { at: Date.now(), rows });
    return rows;
  }
}

export const SCORING = {
  FAILURE_PENALTY_CENTS: 150,
  LATENCY_PENALTY_CENTS_PER_SECOND: 10,
  LIVE_SOURCE_PENALTY_CENTS: 500,
  UPSTREAM_PROBE_RATE: 0.1,
  MIN_ATTEMPT_MS: 250,
};

export interface ExecuteOptions {
  deadlineAt: number;
  costCeilingCents: number;
  preferLiveSource?: boolean;
  confirmNotFoundWithLiveSource?: boolean;
  /** freshness=live callers bypass the upstream-degraded short-circuit. */
  ignoreUpstreamDegraded?: boolean;
}

export type AttemptOutcome = 'success' | 'not_found' | 'timeout' | 'error_5xx' | 'error_4xx' | 'rate_limited' | 'circuit_open' | 'skipped_budget';

export interface Attempt {
  provider: string;
  attemptNo: number;
  outcome: AttemptOutcome;
  durationMs: number;
  costCents: number;
  httpStatus?: number;
  error?: string;
  raw?: unknown;
}

export type WaterfallOutcome<C extends Capability> =
  | { status: 'found'; data: OutputOf<C>; provider: string; isLiveSource: boolean; attempts: Attempt[]; costCents: number }
  | { status: 'not_found'; provider: string; authoritative: boolean; attempts: Attempt[]; costCents: number }
  | {
      status: 'unavailable';
      reason: 'no_providers' | 'all_failed' | 'budget_exhausted' | 'deadline' | 'upstream_degraded';
      attempts: Attempt[];
      costCents: number;
    };

export interface RankedCandidate {
  config: ProviderCapabilityConfig;
  adapter: ProviderAdapter;
  health: HealthSnapshot;
  marginalCostCents: number;
  score: number;
}

export class WaterfallEngine {
  private readonly adapters: Map<string, ProviderAdapter>;

  constructor(
    adapters: ProviderAdapter[],
    private readonly config: CapabilityConfigSource,
    private readonly health: HealthTracker,
    private readonly log: Logger,
    private readonly random: () => number = Math.random,
  ) {
    this.adapters = new Map(adapters.map((a) => [a.code, a]));
  }

  private marginalCost(cfg: ProviderCapabilityConfig, monthVolume: number): number {
    if (cfg.prepaidRemaining !== null && cfg.prepaidRemaining > 0) return 0;
    let cost = cfg.unitCostCents;
    for (const t of [...cfg.volumeTiers].sort((a, b) => a.from - b.from)) if (monthVolume >= t.from) cost = t.costCents;
    return cost;
  }

  async rank(capability: Capability, opts: Pick<ExecuteOptions, 'preferLiveSource'> = {}): Promise<RankedCandidate[]> {
    const rows = (await this.config.list(capability)).filter((r) => this.adapters.get(r.providerCode)?.supports(capability));
    const ranked = await Promise.all(
      rows.map(async (cfg) => {
        const [health, vol] = await Promise.all([
          this.health.snapshot(cfg.providerCode, capability),
          this.health.monthVolume(cfg.providerCode, capability),
        ]);
        const marginalCostCents = this.marginalCost(cfg, vol);
        const score =
          marginalCostCents +
          SCORING.FAILURE_PENALTY_CENTS * (1 - health.successRate) +
          SCORING.LATENCY_PENALTY_CENTS_PER_SECOND * (health.latencyMs / 1000) +
          (opts.preferLiveSource && !cfg.isLiveSource ? SCORING.LIVE_SOURCE_PENALTY_CENTS : 0);
        return { config: cfg, adapter: this.adapters.get(cfg.providerCode)!, health, marginalCostCents, score };
      }),
    );
    return ranked.sort((a, b) => a.score - b.score || a.config.providerCode.localeCompare(b.config.providerCode));
  }

  async execute<C extends Capability>(capability: C, input: InputOf<C>, opts: ExecuteOptions): Promise<WaterfallOutcome<C>> {
    const attempts: Attempt[] = [];
    let spent = 0;

    if (!opts.ignoreUpstreamDegraded && (await this.health.isUpstreamDegraded(capability))) {
      if (this.random() >= SCORING.UPSTREAM_PROBE_RATE) {
        return { status: 'unavailable', reason: 'upstream_degraded', attempts, costCents: 0 };
      }
    }

    const candidates = await this.rank(capability, opts);
    if (candidates.length === 0) return { status: 'unavailable', reason: 'no_providers', attempts, costCents: 0 };

    let provisionalNotFound: { provider: string } | null = null;
    let stoppedFor: 'budget_exhausted' | 'deadline' | null = null;
    let attemptNo = 0;

    for (const c of candidates) {
      const code = c.config.providerCode;

      // While confirming a cached-copy "not found", only live sources are useful.
      if (provisionalNotFound && !c.config.isLiveSource) continue;

      if (spent + c.marginalCostCents > opts.costCeilingCents) {
        attempts.push({ provider: code, attemptNo: ++attemptNo, outcome: 'skipped_budget', durationMs: 0, costCents: 0 });
        stoppedFor = 'budget_exhausted';
        continue;
      }

      if (c.health.circuit === 'open' || (c.health.circuit === 'half_open' && !(await this.health.tryAcquireProbe(code, capability)))) {
        attempts.push({ provider: code, attemptNo: ++attemptNo, outcome: 'circuit_open', durationMs: 0, costCents: 0 });
        continue;
      }

      const remaining = opts.deadlineAt - Date.now();
      if (remaining < SCORING.MIN_ATTEMPT_MS) {
        stoppedFor = 'deadline';
        break;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(c.config.timeoutMs, remaining));
      const started = Date.now();
      attemptNo++;
      try {
        const res = await c.adapter.call(capability, input, controller.signal);
        const durationMs = Date.now() - started;
        const cost = res.costCents ?? c.marginalCostCents;
        spent += cost;
        await Promise.all([this.health.recordSuccess(code, capability, durationMs), this.health.incrementVolume(code, capability)]);

        if (res.kind === 'found') {
          attempts.push({ provider: code, attemptNo, outcome: 'success', durationMs, costCents: cost, raw: res.raw });
          if (await this.health.isUpstreamDegraded(capability)) await this.health.clearUpstreamDegraded(capability);
          return { status: 'found', data: res.data, provider: code, isLiveSource: c.config.isLiveSource, attempts, costCents: spent };
        }

        attempts.push({ provider: code, attemptNo, outcome: 'not_found', durationMs, costCents: cost, raw: res.raw });
        if (c.config.isLiveSource || !opts.confirmNotFoundWithLiveSource) {
          return { status: 'not_found', provider: code, authoritative: c.config.isLiveSource, attempts, costCents: spent };
        }
        provisionalNotFound = { provider: code };
      } catch (err) {
        const durationMs = Date.now() - started;
        const pe = err instanceof ProviderError ? err : new ProviderError(controller.signal.aborted ? 'timeout' : 'error_5xx', (err as Error).message);
        attempts.push({ provider: code, attemptNo, outcome: pe.kind, durationMs, costCents: 0, httpStatus: pe.httpStatus, error: pe.message });
        this.log.warn({ provider: code, capability, kind: pe.kind, durationMs }, 'provider attempt failed');
        if (pe.countsAgainstHealth) {
          await this.health.recordFailure(code, capability);
          const failingProviders = await this.health.noteUpstreamFailure(capability, code);
          const nothingSucceeded = attempts.every((a) => !['success', 'not_found'].includes(a.outcome));
          if (failingProviders >= 2 && nothingSucceeded) await this.health.markUpstreamDegraded(capability);
        }
      } finally {
        clearTimeout(timer);
      }
    }

    if (provisionalNotFound) {
      return { status: 'not_found', provider: provisionalNotFound.provider, authoritative: false, attempts, costCents: spent };
    }
    return { status: 'unavailable', reason: stoppedFor ?? 'all_failed', attempts, costCents: spent };
  }
}
