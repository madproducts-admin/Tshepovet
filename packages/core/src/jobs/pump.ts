import type { Logger } from '../lib/logger';

/**
 * Runs a job alone: a kick while it runs makes it run once more afterwards (nothing is lost,
 * nothing runs twice at once). The job may say when it should run next (a webhook retry
 * falling due), and the pump sets a timer for it.
 */
export class Pump {
  private running: Promise<void> | null = null;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  private timerAt = Number.POSITIVE_INFINITY;
  private stopped = false;

  constructor(
    private readonly name: string,
    private readonly once: () => Promise<Date | null>,
    private readonly log: Logger,
  ) {}

  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.loop().finally(() => {
      this.running = null;
    });
  }

  private async loop() {
    do {
      this.again = false;
      try {
        const next = await this.once();
        if (next) this.at(next);
      } catch (err) {
        this.log.error({ err, job: this.name }, 'job failed');
      }
    } while (this.again && !this.stopped);
  }

  private at(when: Date) {
    const ms = Math.max(0, when.getTime() - Date.now());
    const at = Date.now() + ms;
    if (this.timer && at >= this.timerAt) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerAt = Number.POSITIVE_INFINITY;
      this.kick();
    }, Math.min(ms, 2_000_000_000));
    this.timer.unref();
  }

  /** Waits for the current run, if any (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.idle();
  }
}
