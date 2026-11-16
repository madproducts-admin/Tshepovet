import { DynamicModule, Module } from '@nestjs/common';
import { CONTAINER, type Container } from './container';
import { HealthController } from './http/health.controller';
import { V1Controller } from './http/v1.controller';
import { WhatsAppWebhookController } from './http/whatsapp.controller';
import { AuthController } from './portal/auth.controller';
import { AuthService } from './portal/auth.service';
import { ChecksController } from './portal/checks.controller';
import { ComplianceController } from './portal/compliance.controller';
import { DevelopersController } from './portal/developers.controller';
import { PortalGuard, StaffGuard } from './portal/guards';
import { ModulesController } from './portal/modules.controller';
import { MonitoringController } from './portal/monitoring.controller';
import { OrganisationController, PlatformController } from './portal/organisation.controller';
import { StaffAuthController } from './portal/staff-auth.controller';
import { SuppliersController } from './portal/suppliers.controller';
import { TeamController } from './portal/team.controller';
import { WalletController } from './portal/wallet.controller';

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
      providers: [
        { provide: CONTAINER, useValue: container },
        { provide: AuthService, useFactory: (c: Container) => new AuthService(c), inject: [CONTAINER] },
        PortalGuard,
        StaffGuard,
      ],
      controllers: [
        HealthController,
        V1Controller,
        WhatsAppWebhookController,
        PlatformController,
        AuthController,
        TeamController,
        StaffAuthController,
        OrganisationController,
        SuppliersController,
        ChecksController,
        MonitoringController,
        WalletController,
        ModulesController,
        DevelopersController,
        ComplianceController,
      ],
    };
  }
}
