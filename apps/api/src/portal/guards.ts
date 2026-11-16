import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiError } from '@tshepovet/core';
import { can, type Permission } from '@tshepovet/contracts';

const PERMISSION = 'tv:permission';
const ALLOW_MFA_SETUP = 'tv:allow-mfa-setup';
const STAFF_ROLES = 'tv:staff-roles';

/** The role must hold this permission (docs: packages/contracts/src/rbac.ts). */
export const RequirePermission = (p: Permission) => SetMetadata(PERMISSION, p);
/** Reachable by a session that still has to enrol in two-step verification. */
export const AllowMfaSetup = () => SetMetadata(ALLOW_MFA_SETUP, true);
/** Staff endpoints limited to some staff roles. */
export const RequireStaffRole = (...roles: string[]) => SetMetadata(STAFF_ROLES, roles);

const unauthenticated = () => new ApiError(401, 'unauthenticated', 'Sign in to continue.');

/** Buyer-portal routes: a signed-in user, MFA enrolled where the role requires it, and the permission. */
@Injectable()
export class PortalGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const p = req.portal;
    if (!p) throw unauthenticated();
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (p.session.stage === 'mfa_setup' && !this.reflector.getAllAndOverride<boolean>(ALLOW_MFA_SETUP, targets)) {
      throw new ApiError(403, 'mfa_setup_required', 'Set up two-step verification to continue.');
    }
    const perm = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION, targets);
    if (perm && !can(p.session.role, perm)) throw new ApiError(403, 'forbidden', 'Your role does not allow this. Ask an administrator.');
    return true;
  }
}

/** Staff-console routes: a signed-in staff member who has completed MFA. */
@Injectable()
export class StaffGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const st = req.staff;
    if (!st) throw unauthenticated();
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (st.session.stage === 'mfa_setup' && !this.reflector.getAllAndOverride<boolean>(ALLOW_MFA_SETUP, targets)) {
      throw new ApiError(403, 'mfa_setup_required', 'Set up two-step verification to continue.');
    }
    const roles = this.reflector.getAllAndOverride<string[] | undefined>(STAFF_ROLES, targets);
    if (roles && !roles.includes(st.session.role)) throw new ApiError(403, 'forbidden', 'Your staff role does not allow this.');
    return true;
  }
}
