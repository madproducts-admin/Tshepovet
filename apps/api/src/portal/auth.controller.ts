import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError, tokenHash } from '@tshepovet/core';
import {
  AcceptInviteSchema,
  ChangePasswordSchema,
  EmailOnlySchema,
  LoginSchema,
  MfaChallengeSchema,
  MfaCodeSchema,
  MfaDisableSchema,
  PasswordConfirmSchema,
  ResetPasswordSchema,
  SignupSchema,
  TokenSchema,
} from '@tshepovet/contracts';
import { AuthService } from './auth.service';
import { clearCookie } from './cookies';
import { AllowMfaSetup, PortalGuard } from './guards';

/**
 * Buyer-portal accounts: sign-up, email verification, sign-in with two-step verification,
 * passwords, sessions and invitations. Every POST needs the X-CSRF-Token header (GET /csrf
 * issues the token before a session exists). Answers never reveal whether an email has an
 * account: sign-up, resend and forgot-password always say "check your email".
 */
@Controller('api/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get('csrf')
  csrf(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return { csrf_token: req.portal?.session.csrf ?? this.auth.issueCsrf(res, 'user') };
  }

  @Post('signup')
  @HttpCode(202)
  async signup(@Req() req: Request) {
    await this.auth.signup(req, SignupSchema.parse(req.body));
    return { status: 'check_email' };
  }

  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(@Req() req: Request) {
    await this.auth.verifyEmail(req, TokenSchema.parse(req.body).token);
    return { verified: true };
  }

  @Post('resend-verification')
  @HttpCode(202)
  async resend(@Req() req: Request) {
    await this.auth.resendVerification(req, EmailOnlySchema.parse(req.body).email);
    return { status: 'check_email' };
  }

  @Post('login')
  @HttpCode(200)
  login(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const b = LoginSchema.parse(req.body);
    return this.auth.login(req, res, b.email, b.password);
  }

  @Post('mfa')
  @HttpCode(200)
  async mfa(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return { session: await this.auth.completeMfa(req, res, MfaChallengeSchema.parse(req.body)) };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req, res);
  }

  @Get('session')
  @UseGuards(PortalGuard)
  @AllowMfaSetup()
  async session(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const view = await this.auth.view(req.portal!.session, req.portal!.token);
    if (!view) {
      clearCookie(res, this.auth.names.userSession, this.auth.c.cookieSecure);
      throw new ApiError(401, 'unauthenticated', 'Sign in to continue.');
    }
    return view;
  }

  @Post('password/forgot')
  @HttpCode(202)
  async forgot(@Req() req: Request) {
    await this.auth.forgotPassword(req, EmailOnlySchema.parse(req.body).email);
    return { status: 'check_email' };
  }

  @Post('password/reset')
  @HttpCode(200)
  async reset(@Req() req: Request) {
    const b = ResetPasswordSchema.parse(req.body);
    await this.auth.resetPassword(req, b.token, b.password);
    return { reset: true };
  }

  @Post('password/change')
  @HttpCode(204)
  @UseGuards(PortalGuard)
  async change(@Req() req: Request) {
    const b = ChangePasswordSchema.parse(req.body);
    await this.auth.changePassword(req, b.current_password, b.new_password);
  }

  @Post('mfa/setup')
  @HttpCode(200)
  @UseGuards(PortalGuard)
  @AllowMfaSetup()
  async mfaSetup(@Req() req: Request) {
    const s = req.portal!.session;
    const u = await this.auth.c.accounts.userById(s.subjectId);
    if (u?.mfa_enrolled) throw new ApiError(409, 'mfa_already_enabled', 'Two-step verification is already on.');
    return this.auth.mfaSetup('user', s, u!.email);
  }

  @Post('mfa/enable')
  @HttpCode(200)
  @UseGuards(PortalGuard)
  @AllowMfaSetup()
  mfaEnable(@Req() req: Request) {
    return this.auth.mfaEnable(req, 'user', req.portal!.token, req.portal!.session, MfaCodeSchema.parse(req.body).code);
  }

  @Post('mfa/disable')
  @HttpCode(204)
  @UseGuards(PortalGuard)
  async mfaDisable(@Req() req: Request) {
    const b = MfaDisableSchema.parse(req.body);
    await this.auth.mfaDisable(req, req.portal!.session, b.password, b.code);
  }

  @Post('mfa/recovery-codes')
  @HttpCode(200)
  @UseGuards(PortalGuard)
  recoveryCodes(@Req() req: Request) {
    return this.auth.regenerateRecoveryCodes(req, 'user', req.portal!.session, PasswordConfirmSchema.parse(req.body).password);
  }

  @Get('sessions')
  @UseGuards(PortalGuard)
  async sessions(@Req() req: Request) {
    return { sessions: await this.auth.listSessions('user', req.portal!.session) };
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  @UseGuards(PortalGuard)
  async endSession(@Req() req: Request, @Param('id') id: string) {
    const ok = await this.auth.c.sessions.destroyBySid('user', req.portal!.session.subjectId, id);
    if (!ok) throw new ApiError(404, 'not_found', 'That session has already ended.');
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  @UseGuards(PortalGuard)
  async revokeOthers(@Req() req: Request) {
    return { ended: await this.auth.c.sessions.destroyAll('user', req.portal!.session.subjectId, req.portal!.token) };
  }

  @Get('invitations/:token')
  async invitation(@Param('token') token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError(404, 'not_found', 'This invitation has expired or was already used.');
    const peek = await this.auth.c.accounts.peekInvite(tokenHash(token));
    if (!peek) throw new ApiError(404, 'not_found', 'This invitation has expired or was already used.');
    return { organisation: peek.legal_name, email: peek.email, role: peek.role, expires_at: peek.expires_at };
  }

  @Post('invitations/accept')
  @HttpCode(201)
  async accept(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const b = AcceptInviteSchema.parse(req.body);
    return { session: await this.auth.acceptInvite(req, res, b.token, b.full_name, b.password) };
  }
}
