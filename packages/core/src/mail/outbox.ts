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
  | 'mfa_changed'
  | 'vendor_invite'
  | 'vendor_login'
  | 'supplier_onboarded'
  | 'expiry_reminder'
  | 'expired'
  | 'compliance_changed'
  | 'monitoring_unpaid'
  | 'module_unpaid';

export interface MailVars {
  appUrl: string;
  name?: string | null;
  org?: string | null;
  link?: string | null;
  role?: string | null;
  inviter?: string | null;
  minutes?: number | null;
  change?: string | null;
  supplier?: string | null;
  /** What expires or changed, in words ("the tax compliance PIN"). */
  what?: string | null;
  /** A calendar day, already formatted ("16 December 2026"). */
  day?: string | null;
  amount?: string | null;
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
    case 'vendor_invite':
      return {
        subject: `${v.org ?? 'A customer'} asked you to complete supplier onboarding`,
        text: `${hi}

${v.org ?? 'One of your customers'} uses TshepoVet to check its suppliers, and asked ${v.supplier ?? 'your company'} to complete onboarding. It takes about ten minutes: your company details, an ID document, and, where they need them, B-BBEE evidence, bank details and a SARS tax compliance PIN.

Start here:

${v.link}

The link works for 14 days. If you did not expect this, ask ${v.org ?? 'your customer'} before you continue.${SIGN_OFF}`,
      };
    case 'vendor_login':
      return {
        subject: `Sign in to TshepoVet for ${v.supplier ?? 'your company'}`,
        text: `${hi}

Use this link to see and control ${v.supplier ?? 'your company'}'s information on TshepoVet: your passport, who you share it with, and your consents.

${v.link}

The link works once and expires in 15 minutes. If you did not ask for it, ignore this email.${SIGN_OFF}`,
      };
    case 'supplier_onboarded':
      return {
        subject: `${v.supplier ?? 'A supplier'} finished onboarding`,
        text: `${hi}

${v.supplier ?? 'A supplier'} finished onboarding on TshepoVet and is waiting for your review.

Open it here: ${v.link}${SIGN_OFF}`,
      };
    case 'expiry_reminder':
      return {
        subject: `${v.supplier ?? 'A supplier'}: ${v.what ?? 'a document'} expires on ${v.day}`,
        text: `${hi}

${v.what ?? 'A document'} for ${v.supplier ?? 'one of your suppliers'} expires on ${v.day}. Ask the supplier for a new one before then; TshepoVet checks it again as soon as you add it.

See the supplier: ${v.link}${SIGN_OFF}`,
      };
    case 'expired':
      return {
        subject: `${v.supplier ?? 'A supplier'}: ${v.what ?? 'a document'} has expired`,
        text: `${hi}

${v.what ?? 'A document'} for ${v.supplier ?? 'one of your suppliers'} expired on ${v.day}.${v.change ? ` ${v.change}` : ''}

See the supplier: ${v.link}${SIGN_OFF}`,
      };
    case 'compliance_changed':
      return {
        subject: `${v.supplier ?? 'A supplier'}: its compliance changed`,
        text: `${hi}

TshepoVet checked ${v.supplier ?? 'one of your suppliers'} again. ${v.change ?? 'The result changed since the last check.'}

See the result: ${v.link}${SIGN_OFF}`,
      };
    case 'monitoring_unpaid':
      return {
        subject: 'Monitoring could not be paid from your TshepoVet wallet',
        text: `${hi}

Monitoring ${v.supplier ?? 'a supplier'} costs ${v.amount ?? 'a monthly fee'} this month, and your wallet does not have enough credit. TshepoVet keeps monitoring for 7 days; top up before ${v.day} or monitoring of this supplier stops.

Top up: ${v.appUrl}/app/wallet${SIGN_OFF}`,
      };
    case 'module_unpaid':
      return {
        subject: `${v.what ?? 'A module'} could not be renewed`,
        text: `${hi}

${v.what ?? 'A module'} renews for ${v.amount ?? 'its monthly fee'}, and your wallet does not have enough credit, so it is paused. Top up before ${v.day} and it renews by itself; after that it is turned off.

Top up: ${v.appUrl}/app/wallet${SIGN_OFF}`,
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
