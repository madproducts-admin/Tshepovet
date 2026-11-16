import { CanActivate, Controller, ExecutionContext, Get, HttpCode, Inject, Injectable, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError, enqueueMail, newOpaqueToken, tokenHash } from '@tshepovet/core';
import { EmailOnlySchema, TokenSchema, VendorPassportUpdateSchema, VendorRequestSchema, VendorWithdrawSchema } from '@tshepovet/contracts';
import { CONTAINER, type Container } from '../container';
import { AuthService, clientIp } from '../portal/auth.service';
import { clearCookie } from '../portal/cookies';
import { utcInstants } from '../portal/tenant';

/** Supplier self-service routes: a signed-in supplier contact. */
@Injectable()
export class VendorGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    if (!ctx.switchToHttp().getRequest<Request>().vendor) throw new ApiError(401, 'unauthenticated', 'Sign in to continue.');
    return true;
  }
}

/**
 * Supplier self-service (/api/vendor): a supplier's contact signs in with a link sent to the
 * email address they onboarded with, and controls what TshepoVet holds about the supplier:
 * the public passport, consents, and requests to buyers. Every query goes through a
 * SECURITY DEFINER function that takes the supplier from the session, never from the request.
 */
@Controller('api/vendor')
export class VendorController {
  constructor(
    @Inject(CONTAINER) private readonly c: Container,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  private async limited(key: string, max: number): Promise<boolean> {
    const k = `tv:rl:vendor:${key}`;
    const n = await this.c.redis.incr(k);
    if (n === 1) await this.c.redis.expire(k, 900);
    return n > max;
  }

  @Get('auth/csrf')
  csrf(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return { csrf_token: req.vendor?.session.csrf ?? this.auth.issueCsrf(res, 'vendor') };
  }

  /** Always the same answer, whether or not the address belongs to a supplier contact. */
  @Post('auth/magic-link')
  @HttpCode(202)
  async magicLink(@Req() req: Request) {
    const { email } = EmailOnlySchema.parse(req.body);
    if ((await this.limited(`ip:${clientIp(req) ?? 'unknown'}`, 20)) || (await this.limited(`email:${email}`, 5))) {
      throw new ApiError(429, 'too_many_attempts', 'Too many attempts. Wait a few minutes and try again.');
    }
    const r = await this.c.pool.query<{ contact_id: string; full_name: string; legal_name: string }>(`SELECT contact_id, full_name, legal_name FROM vendor_login_candidates($1)`, [email]);
    for (const cand of r.rows) {
      const { token, hash } = newOpaqueToken();
      await this.c.pool.query(`SELECT vendor_issue_login_token($1, $2, interval '15 minutes')`, [cand.contact_id, hash]);
      await enqueueMail(this.c.pool, {
        tenantId: null,
        to: email,
        template: 'vendor_login',
        vars: { appUrl: this.c.config.APP_URL, name: cand.full_name, supplier: cand.legal_name, link: `${this.c.config.APP_URL}/supplier/sign-in#token=${token}` },
      });
    }
    return { status: 'check_email' };
  }

  @Post('auth/exchange')
  @HttpCode(200)
  async exchange(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const parsed = TokenSchema.safeParse(req.body);
    const invalid = new ApiError(400, 'invalid_link', 'This link has expired or was already used. Ask for a new one.');
    if (!parsed.success) throw invalid;
    const r = await this.c.pool.query<{ contact_id: string; vendor_id: string }>(`SELECT contact_id, vendor_id FROM vendor_consume_login_token($1)`, [tokenHash(parsed.data.token)]);
    const contact = r.rows[0];
    if (!contact) throw invalid;
    const { data } = await this.auth.startSession(req, res, 'vendor', contact.contact_id, null, 'vendor_contact', 'full');
    await this.platformAudit(req, 'vendor.signed_in', contact.vendor_id, contact.contact_id);
    return { csrf_token: data.csrf };
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (req.vendor) await this.c.sessions.destroy(req.vendor.token);
    const names = this.auth.cookiesFor('vendor');
    clearCookie(res, names.session, this.c.cookieSecure);
  }

  @Get('me')
  @UseGuards(VendorGuard)
  async me(@Req() req: Request) {
    const v = req.vendor!;
    const contact = await this.c.pool.query<{ full_name: string; email: string }>(`SELECT full_name, email::text AS email FROM vendor_contact_live($1)`, [v.session.subjectId]);
    const view = await this.c.pool.query<{ v: Record<string, unknown> }>(`SELECT vendor_portal_view($1) AS v`, [v.vendorId]);
    return { contact: contact.rows[0], ...utcInstants(view.rows[0]!.v) };
  }

  @Post('passport')
  @HttpCode(204)
  @UseGuards(VendorGuard)
  async passport(@Req() req: Request) {
    const b = VendorPassportUpdateSchema.parse(req.body);
    const v = req.vendor!;
    if (b.status === 'active') {
      const ok = await this.c.pool.query<{ ok: boolean }>(`SELECT (vendor_portal_view($1)->'vendor'->>'passport_last_verified_at') IS NOT NULL AS ok`, [v.vendorId]);
      if (!ok.rows[0]?.ok) throw new ApiError(409, 'not_verified_yet', 'A passport can be published once your company has been verified.');
    }
    await this.c.pool.query(`SELECT vendor_set_passport($1, $2, $3)`, [v.vendorId, b.status, b.fields]);
    await this.platformAudit(req, b.status === 'active' ? 'passport.published' : 'passport.withdrawn', v.vendorId, v.session.subjectId, { fields: b.fields });
  }

  @Post('consents/:id/withdraw')
  @HttpCode(200)
  @UseGuards(VendorGuard)
  async withdraw(@Req() req: Request, @Param('id') id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(404, 'not_found', 'That consent record was not found.');
    const b = VendorWithdrawSchema.parse(req.body ?? {});
    const v = req.vendor!;
    const r = await this.c.pool.query<{ n: number }>(`SELECT vendor_withdraw_consent($1, $2, $3) AS n`, [v.vendorId, id, b.purposes ?? null]);
    if (!r.rows[0]?.n) throw new ApiError(404, 'not_found', 'Nothing to withdraw on that consent record.');
    await this.platformAudit(req, 'consent.withdrawn_by_supplier', v.vendorId, v.session.subjectId, { consent_id: id, purposes: b.purposes ?? 'all' });
    return { withdrawn: r.rows[0].n };
  }

  @Post('requests')
  @HttpCode(201)
  @UseGuards(VendorGuard)
  async request(@Req() req: Request) {
    const b = VendorRequestSchema.parse(req.body);
    const v = req.vendor!;
    const contact = await this.c.pool.query<{ full_name: string }>(`SELECT full_name FROM vendor_contact_live($1)`, [v.session.subjectId]);
    try {
      const r = await this.c.pool.query<{ id: string }>(`SELECT vendor_submit_request($1, $2, $3, $4, $5) AS id`, [
        v.vendorId,
        b.relationship_id,
        b.request_type,
        `${contact.rows[0]?.full_name ?? 'Supplier contact'} (supplier portal)`,
        b.notes ?? null,
      ]);
      await this.platformAudit(req, 'dsr.submitted_by_supplier', v.vendorId, v.session.subjectId, { request_id: r.rows[0]!.id, type: b.request_type });
      return { id: r.rows[0]!.id };
    } catch (err) {
      if ((err as { code?: string }).code === 'P0002') throw new ApiError(404, 'not_found', 'That customer relationship was not found.');
      throw err;
    }
  }

  /** Supplier actions are not any one buyer's: they go on the platform chain, attributed in the details. */
  private platformAudit(req: Request, action: string, vendorId: string, contactId: string, details: Record<string, unknown> = {}) {
    return this.c.pool.query(`SELECT audit_platform_event('system', $1, $2, 'vendor', $3, $4, $5, $6)`, [
      'supplier_portal',
      action,
      vendorId,
      req.requestId,
      clientIp(req),
      JSON.stringify({ vendor_contact_id: contactId, ...details }),
    ]);
  }
}
