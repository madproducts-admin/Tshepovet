import { Controller, Get, Header } from '@nestjs/common';

@Controller()
export class HealthController {
  /** Liveness: the process answers. IIS, the deploy script and the smoke suites poll it. */
  @Get('healthz')
  @Header('cache-control', 'no-store')
  health() {
    return { ok: true };
  }
}
