import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CONTAINER, type Container } from '../container';
import { Readiness } from './readiness';

@Controller()
export class HealthController {
  private readonly readiness: Readiness;

  constructor(@Inject(CONTAINER) c: Container) {
    this.readiness = Readiness.forContainer(c);
  }

  /** Liveness: the process answers. IIS, the deploy script and the smoke suites poll it. */
  @Get('healthz')
  @Header('cache-control', 'no-store')
  health() {
    return { ok: true };
  }

  /**
   * Readiness: PostgreSQL and Redis answer (readiness.ts), so requests can be served. 503 with
   * `{ ok: false }` while either does not; the reason is logged, never sent.
   */
  @Get('readyz')
  @Header('cache-control', 'no-store')
  async ready(@Res({ passthrough: true }) res: Response) {
    const ok = await this.readiness.check();
    res.status(ok ? 200 : 503);
    return { ok };
  }
}
