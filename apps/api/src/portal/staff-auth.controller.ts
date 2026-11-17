import { Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError } from '@tshepovet/core';
import { LoginSchema, MfaChallengeSchema, MfaCodeSchema, PasswordConfirmSchema } from '@tshepovet/contracts';
import { AuthService } from './auth.service';
import { clearCookie } from './cookies';
import { AllowMfaSetup, StaffGuard } from './guards';

/**
 * Staff-console sign-in (/api/staff/auth). Separate cookies and sessions from the buyer
 * portal; two-step verification is mandatory: a staff member without it can only enrol.
 * Staff accounts are created with scripts/create-staff.ts, never through the API.
 */
@Controller('api/staff/auth')
export class StaffAuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get('csrf')
  csrf(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return { csrf_token: req.staff?.session.csrf ?? this.auth.issueCsrf(res, 'staff') };
  }

  @Post('login')
  @HttpCode(200)
  login(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const b = LoginSchema.parse(req.body);
    return this.auth.staffLogin(req, res, b.email, b.password);
  }

  @Post('mfa')
  @HttpCode(200)
  async mfa(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return { session: await this.auth.staffCompleteMfa(req, res, MfaChallengeSchema.parse(req.body)) };
  }

  @Get('session')
  @UseGuards(StaffGuard)
  @AllowMfaSetup()
  async session(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const view = await this.auth.staffView(req.staff!.session, req.staff!.token);
    if (!view) {
      clearCookie(res, this.auth.names.staffSession, this.auth.c.cookieSecure);
      throw new ApiError(401, 'unauthenticated', 'Sign in to continue.');
    }
    return view;
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.staffLogout(req, res);
  }

  @Post('mfa/setup')
  @HttpCode(200)
  @UseGuards(StaffGuard)
  @AllowMfaSetup()
  async mfaSetup(@Req() req: Request) {
    const st = await this.auth.c.accounts.staffById(req.staff!.session.subjectId);
    if (st?.mfa_enrolled) throw new ApiError(409, 'mfa_already_enabled', 'Two-step verification is already on.');
    return this.auth.mfaSetup('staff', req.staff!.session, st!.email);
  }

  @Post('mfa/enable')
  @HttpCode(200)
  @UseGuards(StaffGuard)
  @AllowMfaSetup()
  mfaEnable(@Req() req: Request) {
    return this.auth.mfaEnable(req, 'staff', req.staff!.token, req.staff!.session, MfaCodeSchema.parse(req.body).code);
  }

  @Post('mfa/recovery-codes')
  @HttpCode(200)
  @UseGuards(StaffGuard)
  recoveryCodes(@Req() req: Request) {
    return this.auth.regenerateRecoveryCodes(req, 'staff', req.staff!.session, PasswordConfirmSchema.parse(req.body).password);
  }
}
