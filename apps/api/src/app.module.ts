import { DynamicModule, Module } from '@nestjs/common';
import { CONTAINER, type Container } from './container';
import { HealthController } from './http/health.controller';
import { V1Controller } from './http/v1.controller';
import { WhatsAppWebhookController } from './http/whatsapp.controller';

/**
 * The HTTP application. The domain services come in pre-built (CONTAINER) instead of being
 * declared as Nest providers: the composition root stays in container.ts, shared with the
 * worker and the tests. Every injection uses an explicit token, so nothing depends on
 * emitted decorator metadata (vitest's esbuild transform does not emit it).
 */
@Module({})
export class AppModule {
  static register(container: Container): DynamicModule {
    return {
      module: AppModule,
      providers: [{ provide: CONTAINER, useValue: container }],
      controllers: [HealthController, V1Controller, WhatsAppWebhookController],
    };
  }
}
