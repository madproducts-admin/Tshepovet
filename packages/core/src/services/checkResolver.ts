import type { VerificationCache } from '../cache/verificationCache';
import type { Capability, InputOf, OutputOf } from '../providers/types';
import type { Attempt, WaterfallEngine, WaterfallOutcome } from '../waterfall/engine';

export interface ResolveOptions {
  tenantId: string;
  freshness: 'cached_ok' | 'live';
  maxAgeSeconds?: number;
  deadlineAt: number;
  costCeilingCents: number;
  confirmNotFoundWithLiveSource?: boolean;
  preferLiveSource?: boolean;
}

export interface ResolvedCheck<C extends Capability> {
  status: 'found' | 'not_found' | 'unavailable';
  data: OutputOf<C> | null;
  /** cache:redis | cache:pg | provider:<code> | stale_cache:<tier> | coalesced */
  source: string;
  dataAsOf: string | null;
  stale: boolean;
  authoritative: boolean;
  attempts: Attempt[];
  costCents: number;
  unavailableReason?: string;
}

/**
 * cache -> (single-flight) waterfall -> stale-if-error.
 * `subject` is the normalised natural key (enterprise number, VAT number,
 * "taxref|pinFingerprint", "id|licence"); it is HMAC'd before storage.
 */
export class CheckResolver {
  constructor(
    private readonly cache: VerificationCache,
    private readonly engine: WaterfallEngine,
  ) {}

  async resolve<C extends Capability>(capability: C, subject: string, input: InputOf<C>, o: ResolveOptions): Promise<ResolvedCheck<C>> {
    if (o.freshness !== 'live') {
      const hit = await this.cache.get(capability, subject, o.tenantId, { maxAgeSeconds: o.maxAgeSeconds });
      if (hit?.fresh) {
        return {
          status: hit.entry.kind,
          data: hit.entry.data,
          source: hit.source,
          dataAsOf: hit.entry.fetchedAt,
          stale: false,
          authoritative: hit.entry.authoritative,
          attempts: [],
          costCents: 0,
        };
      }
    }

    const { result, coalesced } = await this.cache.coalesce(capability, subject, o.tenantId, async () => {
      const outcome: WaterfallOutcome<C> = await this.engine.execute(capability, input, {
        deadlineAt: o.deadlineAt,
        costCeilingCents: o.costCeilingCents,
        preferLiveSource: o.preferLiveSource || o.freshness === 'live',
        confirmNotFoundWithLiveSource: o.confirmNotFoundWithLiveSource,
        ignoreUpstreamDegraded: o.freshness === 'live',
      });
      let fetchedAt: string | null = null;
      if (outcome.status === 'found' || outcome.status === 'not_found') {
        const entry = await this.cache.put(capability, subject, o.tenantId, {
          kind: outcome.status,
          data: outcome.status === 'found' ? outcome.data : null,
          provider: outcome.provider,
          authoritative: outcome.status === 'found' ? true : outcome.authoritative,
        });
        fetchedAt = entry.fetchedAt;
      }
      return { outcome, fetchedAt };
    });

    if (result === null) {
      // Another instance did the work and populated the cache.
      const hit = await this.cache.get(capability, subject, o.tenantId);
      if (hit) {
        return { status: hit.entry.kind, data: hit.entry.data, source: 'coalesced', dataAsOf: hit.entry.fetchedAt, stale: false, authoritative: hit.entry.authoritative, attempts: [], costCents: 0 };
      }
      return { status: 'unavailable', data: null, source: 'coalesced', dataAsOf: null, stale: false, authoritative: false, attempts: [], costCents: 0, unavailableReason: 'coalesce_timeout' };
    }

    const { outcome, fetchedAt } = result;
    // A follower in the same process shares the leader's result but not its cost.
    const attempts = coalesced ? [] : outcome.attempts;
    const costCents = coalesced ? 0 : outcome.costCents;

    if (outcome.status === 'found') {
      return { status: 'found', data: outcome.data, source: coalesced ? 'coalesced' : `provider:${outcome.provider}`, dataAsOf: fetchedAt, stale: false, authoritative: true, attempts, costCents };
    }
    if (outcome.status === 'not_found') {
      return { status: 'not_found', data: null, source: coalesced ? 'coalesced' : `provider:${outcome.provider}`, dataAsOf: fetchedAt, stale: false, authoritative: outcome.authoritative, attempts, costCents };
    }

    // stale-if-error
    const stale = await this.cache.get(capability, subject, o.tenantId);
    if (stale?.staleUsable && stale.entry.kind === 'found') {
      return {
        status: 'found',
        data: stale.entry.data,
        source: `stale_${stale.source}`,
        dataAsOf: stale.entry.fetchedAt,
        stale: true,
        authoritative: false,
        attempts,
        costCents,
        unavailableReason: outcome.reason,
      };
    }
    return { status: 'unavailable', data: null, source: 'none', dataAsOf: null, stale: false, authoritative: false, attempts, costCents, unavailableReason: outcome.reason };
  }
}
