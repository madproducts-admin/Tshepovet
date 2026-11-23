import type { Logger } from '@tshepovet/core';
import type { Container } from '../container';

export interface ReadinessProbes {
  /** The tenant-scoped PostgreSQL pool answers (`select 1`). */
  database: () => Promise<unknown>;
  /** Redis answers (PING): sessions, the rate limit and the job queue live there. */
  redis: () => Promise<unknown>;
}

export interface ReadinessOptions {
  /** One result answers every caller for this long. */
  cacheMs?: number;
  /** Each dependency must answer within this. */
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Readiness, for GET /readyz: can this process serve requests, that is, do PostgreSQL and Redis
 * answer? /healthz stays liveness only (the process is up).
 *
 * The endpoint is public and outside the /api and /v1 rate limits, so a result is reused for
 * `cacheMs` and callers who arrive during a check share it: at most one `select 1` and one PING
 * per `cacheMs` per process, however often it is called. Nothing calls it on a timer, so an idle
 * site costs nothing (the owner's idle database budget, docs/PLAN.md M7, is unchanged).
 */
export class Readiness {
  private readonly cacheMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private last: { ok: boolean; at: number } | null = null;
  private inFlight: Promise<boolean> | null = null;

  constructor(
    private readonly probes: ReadinessProbes,
    private readonly log: Pick<Logger, 'warn'>,
    o: ReadinessOptions = {},
  ) {
    this.cacheMs = o.cacheMs ?? 5_000;
    this.timeoutMs = o.timeoutMs ?? 2_000;
    this.now = o.now ?? Date.now;
  }

  static forContainer(c: Container, o?: ReadinessOptions): Readiness {
    return new Readiness({ database: () => c.pool.query('select 1'), redis: () => c.redis.ping() }, c.log, o);
  }

  /** True when every dependency answered in time. Never throws. */
  check(): Promise<boolean> {
    if (this.last && this.now() - this.last.at < this.cacheMs) return Promise.resolve(this.last.ok);
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<boolean> {
    const names = Object.keys(this.probes) as (keyof ReadinessProbes)[];
    const answers = await Promise.all(
      names.map(async (name) => {
        try {
          await withTimeout(this.probes[name](), this.timeoutMs);
          return true;
        } catch (err) {
          // The reason stays in the log: the public answer names nothing internal.
          this.log.warn({ dependency: name, reason: err instanceof Error ? err.message : String(err) }, 'readiness: a dependency did not answer');
          return false;
        }
      }),
    );
    const ok = answers.every(Boolean);
    this.last = { ok, at: this.now() };
    return ok;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
