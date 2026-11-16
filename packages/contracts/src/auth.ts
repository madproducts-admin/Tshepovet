import { z } from 'zod';
import { ROLES } from './rbac';

/**
 * Request bodies of the portal's account endpoints (/api/auth, /api/team, /api/staff/auth).
 * Password rules beyond length are checked server-side (passwordProblems in @tshepovet/core),
 * so the messages stay in one place.
 */
const email = z.string().trim().toLowerCase().pipe(z.email({ message: 'Enter a valid email address.' }).max(254));
const password = z.string().min(1).max(128);
const name = z.string().trim().min(1).max(120);
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'This link is not valid.');
const totp = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.');
const recovery = z.string().trim().min(8).max(20);

export const SignupSchema = z
  .object({
    organisation_name: z.string().trim().min(2).max(160),
    full_name: name,
    email,
    password,
    accept_terms: z.literal(true, { message: 'Accept the terms and the privacy notice to continue.' }),
  })
  .strict();

export const LoginSchema = z.object({ email, password }).strict();
export const TokenSchema = z.object({ token }).strict();
export const EmailOnlySchema = z.object({ email }).strict();
export const MfaChallengeSchema = z
  .object({ challenge: token, code: totp.optional(), recovery_code: recovery.optional() })
  .strict()
  .refine((b) => Boolean(b.code) !== Boolean(b.recovery_code), { message: 'Send either a code or a recovery code.' });
export const MfaCodeSchema = z.object({ code: totp }).strict();
export const MfaDisableSchema = z.object({ password, code: totp }).strict();
export const PasswordConfirmSchema = z.object({ password }).strict();
export const ResetPasswordSchema = z.object({ token, password }).strict();
export const ChangePasswordSchema = z.object({ current_password: password, new_password: password }).strict();
export const InviteSchema = z.object({ email, role: z.enum(ROLES) }).strict();
export const AcceptInviteSchema = z.object({ token, full_name: name, password }).strict();

/** What GET /api/auth/session returns: enough for the web app to render the shell. */
export interface SessionView {
  user: { id: string; email: string; full_name: string; role: string; mfa_enrolled: boolean };
  organisation: { id: string; legal_name: string };
  stage: 'full' | 'mfa_setup';
  permissions: string[];
  csrf_token: string;
}

export interface StaffSessionView {
  staff: { id: string; email: string; full_name: string; role: string; mfa_enrolled: boolean };
  stage: 'full' | 'mfa_setup';
  csrf_token: string;
}
