import type { Pool, PoolClient } from 'pg';

/**
 * Transactional email, written to email_outbox. In the sandbox nothing is delivered: the
 * staff console shows the outbox (docs/PLAN.md §6). Plain text only, written to be read on a
 * phone: what happened, what to do, and what to do if it was not you.
 */
export type MailTemplate =
  | 'verify_email'
  | 'signup_exists'
  | 'reset_password'
  | 'reset_unknown'
  | 'password_changed'
  | 'account_locked'
  | 'invite'
  | 'mfa_changed';

export interface MailVars {
  appUrl: string;
  name?: string | null;
  org?: string | null;
  link?: string | null;
  role?: string | null;
  inviter?: string | null;
  minutes?: number | null;
  change?: string | null;
}

const SIGN_OFF = '\n\nTshepoVet\nThis is an automated message; replies are not read.';

export function renderMail(template: MailTemplate, v: MailVars): { subject: string; text: string } {
  const hi = v.name ? `Hi ${v.name},` : 'Hi,';
  switch (template) {
    case 'verify_email':
      return {
        subject: 'Confirm your email address for TshepoVet',
        text: `${hi}\n\nConfirm your email address to finish setting up ${v.org ?? 'your organisation'} on TshepoVet:\n\n${v.link}\n\nThe link works once and expires in 24 hours. If you did not sign up, you can ignore this email.${SIGN_OFF}`,
      };
    case 'signup_exists':
      return {
        subject: 'Someone tried to sign up with your email address',
        text: `${hi}\n\nSomeone tried to create a TshepoVet account with this email address, but you already have one.\n\nIf it was you, sign in here: ${v.appUrl}/sign-in\nForgot your password? Reset it here: ${v.appUrl}/forgot-password\n\nIf it was not you, no action is needed: nothing was changed.${SIGN_OFF}`,
      };
    case 'reset_password':
      return {
        subject: 'Reset your TshepoVet password',
        text: `${hi}\n\nUse this link to choose a new password:\n\n${v.link}\n\nThe link works once and expires in one hour. If you did not ask for this, ignore this email: your password stays as it is.${SIGN_OFF}`,
      };
    case 'reset_unknown':
      return {
        subject: 'Password reset request for TshepoVet',
        text: `Hi,\n\nSomeone asked to reset the TshepoVet password for this email address, but there is no TshepoVet account with it.\n\nIf you expected an account, ask your organisation's TshepoVet administrator to invite you, or sign up at ${v.appUrl}/sign-up.${SIGN_OFF}`,
      };
    case 'password_changed':
      return {
        subject: 'Your TshepoVet password was changed',
        text: `${hi}\n\nThe password for your TshepoVet account was just changed, and you were signed out everywhere else.\n\nIf this was not you, reset your password now at ${v.appUrl}/forgot-password and tell your administrator.${SIGN_OFF}`,
      };
    case 'account_locked':
      return {
        subject: 'Your TshepoVet account is temporarily locked',
        text: `${hi}\n\nAfter several wrong passwords, sign-in to your TshepoVet account is locked for ${v.minutes ?? 15} minutes.\n\nIf this was you, wait and try again, or reset your password: ${v.appUrl}/forgot-password\nIf it was not you, someone may be guessing your password: reset it now.${SIGN_OFF}`,
      };
    case 'invite':
      return {
        subject: `${v.inviter ?? 'A colleague'} invited you to ${v.org ?? 'their organisation'} on TshepoVet`,
        text: `Hi,\n\n${v.inviter ?? 'A colleague'} invited you to join ${v.org ?? 'their organisation'} on TshepoVet as ${v.role ?? 'a team member'}.\n\nAccept the invitation here:\n\n${v.link}\n\nThe link works once and expires in 7 days.${SIGN_OFF}`,
      };
    case 'mfa_changed':
      return {
        subject: 'Two-step verification changed on your TshepoVet account',
        text: `${hi}\n\n${v.change ?? 'Your two-step verification settings changed'}.\n\nIf this was not you, reset your password now at ${v.appUrl}/forgot-password and tell your administrator.${SIGN_OFF}`,
      };
  }
}

export async function enqueueMail(db: Pool | PoolClient, m: { tenantId: string | null; to: string; template: MailTemplate; vars: MailVars }): Promise<void> {
  const { subject, text } = renderMail(m.template, m.vars);
  await db.query(`INSERT INTO email_outbox (tenant_id, to_email, template, subject, body_text) VALUES ($1, $2, $3, $4, $5)`, [
    m.tenantId,
    m.to,
    m.template,
    subject,
    text,
  ]);
}
