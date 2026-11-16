import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ApiError, audit, withTenantTx } from '@tshepovet/core';
import { assignableRoles, InviteSchema, type Role, ROLES } from '@tshepovet/contracts';
import { AuthService, clientIp } from './auth.service';
import { PortalGuard, RequirePermission } from './guards';

const Uuid = z.uuid();
const RoleChange = z.object({ role: z.enum(ROLES) }).strict();

/**
 * The organisation's people: members and pending invitations. Everything runs under RLS in
 * the caller's tenant. Rules: nobody changes or disables themselves; only an owner touches an
 * owner; there is always at least one active owner.
 */
@Controller('api/team')
@UseGuards(PortalGuard)
export class TeamController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get()
  @RequirePermission('team:read')
  async list(@Req() req: Request) {
    const s = req.portal!.session;
    return withTenantTx(this.auth.c.pool, s.tenantId!, async (c) => {
      const members = await c.query(
        `SELECT id, email, full_name, role, mfa_enrolled, email_verified_at, last_login_at, disabled_at, created_at
           FROM tenant_users ORDER BY disabled_at NULLS FIRST, full_name`,
      );
      const invitations = await c.query(
        `SELECT id, email, role, expires_at, created_at FROM auth_tokens
          WHERE purpose = 'invite' AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
      );
      return { members: members.rows, invitations: invitations.rows, assignable_roles: assignableRoles(s.role as Role) };
    });
  }

  @Post('invitations')
  @HttpCode(202)
  @RequirePermission('team:manage')
  async invite(@Req() req: Request) {
    const s = req.portal!.session;
    const b = InviteSchema.parse(req.body);
    if (!assignableRoles(s.role as Role).includes(b.role)) throw new ApiError(403, 'forbidden', 'You cannot give someone a role above your own.');
    return { id: await this.auth.invite(req, s, b.email, b.role) };
  }

  @Delete('invitations/:id')
  @HttpCode(204)
  @RequirePermission('team:manage')
  async revoke(@Req() req: Request, @Param('id') id: string) {
    const s = req.portal!.session;
    const tid = Uuid.parse(id);
    const n = await withTenantTx(this.auth.c.pool, s.tenantId!, async (c) => {
      const r = await c.query(`UPDATE auth_tokens SET revoked_at = now() WHERE id = $1 AND purpose = 'invite' AND consumed_at IS NULL AND revoked_at IS NULL`, [tid]);
      if (r.rowCount) await audit(c, { tenantId: s.tenantId, actorType: 'user', actorId: s.subjectId, action: 'team.invitation_revoked', entityType: 'invitation', entityId: tid, requestId: req.requestId, ip: clientIp(req) });
      return r.rowCount;
    });
    if (!n) throw new ApiError(404, 'not_found', 'That invitation was already used or withdrawn.');
  }

  @Patch('members/:id')
  @RequirePermission('team:manage')
  async changeRole(@Req() req: Request, @Param('id') id: string) {
    const s = req.portal!.session;
    const uid = Uuid.parse(id);
    const { role } = RoleChange.parse(req.body);
    if (uid === s.subjectId) throw new ApiError(409, 'cannot_change_self', 'You cannot change your own role. Ask another administrator.');
    if (!assignableRoles(s.role as Role).includes(role)) throw new ApiError(403, 'forbidden', 'You cannot give someone a role above your own.');
    const member = await withTenantTx(this.auth.c.pool, s.tenantId!, async (c) => {
      const cur = (await c.query<{ role: string; disabled_at: Date | null }>(`SELECT role, disabled_at FROM tenant_users WHERE id = $1 FOR UPDATE`, [uid])).rows[0];
      if (!cur || cur.disabled_at) throw new ApiError(404, 'not_found', 'That person is not an active member.');
      if (cur.role === 'owner' && s.role !== 'owner') throw new ApiError(403, 'forbidden', 'Only an owner can change an owner.');
      if (cur.role === 'owner' && role !== 'owner') await this.assertAnotherOwner(c, uid);
      const r = await c.query(`UPDATE tenant_users SET role = $2 WHERE id = $1 RETURNING id, email, full_name, role`, [uid, role]);
      await audit(c, { tenantId: s.tenantId, actorType: 'user', actorId: s.subjectId, action: 'team.role_changed', entityType: 'user', entityId: uid, details: { from: cur.role, to: role }, requestId: req.requestId, ip: clientIp(req) });
      return r.rows[0];
    });
    await this.auth.c.sessions.patchAll('user', uid, { role });
    return member;
  }

  @Post('members/:id/disable')
  @HttpCode(204)
  @RequirePermission('team:manage')
  async disable(@Req() req: Request, @Param('id') id: string) {
    const s = req.portal!.session;
    const uid = Uuid.parse(id);
    if (uid === s.subjectId) throw new ApiError(409, 'cannot_change_self', 'You cannot remove yourself. Ask another administrator.');
    await withTenantTx(this.auth.c.pool, s.tenantId!, async (c) => {
      const cur = (await c.query<{ role: string; disabled_at: Date | null }>(`SELECT role, disabled_at FROM tenant_users WHERE id = $1 FOR UPDATE`, [uid])).rows[0];
      if (!cur || cur.disabled_at) throw new ApiError(404, 'not_found', 'That person is not an active member.');
      if (cur.role === 'owner') {
        if (s.role !== 'owner') throw new ApiError(403, 'forbidden', 'Only an owner can remove an owner.');
        await this.assertAnotherOwner(c, uid);
      }
      await c.query(`UPDATE tenant_users SET disabled_at = now() WHERE id = $1`, [uid]);
      await audit(c, { tenantId: s.tenantId, actorType: 'user', actorId: s.subjectId, action: 'team.member_disabled', entityType: 'user', entityId: uid, requestId: req.requestId, ip: clientIp(req) });
    });
    await this.auth.c.sessions.destroyAll('user', uid);
  }

  private async assertAnotherOwner(c: import('pg').PoolClient, exceptId: string) {
    const r = await c.query(`SELECT 1 FROM tenant_users WHERE role = 'owner' AND disabled_at IS NULL AND id <> $1 LIMIT 1`, [exceptId]);
    if (!r.rowCount) throw new ApiError(409, 'last_owner', 'An organisation needs at least one owner. Make someone else an owner first.');
  }
}
