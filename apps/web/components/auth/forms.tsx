'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Callout, Spinner } from '@/components/ui/feedback';
import { Checkbox, ErrorSummary, Field, Input } from '@/components/ui/form';
import { api, ApiProblem, setCsrfToken } from '@/lib/api';
import { check, type Errors, fromProblem, rules, summary } from '@/lib/forms';
import { AuthHeading, PASSWORD_HINT, PasswordInput, useHashToken } from './parts';

type Submit = { preventDefault(): void };
const unreachable = 'TshepoVet could not be reached. Check your connection and try again.';
const message = (err: unknown) => (err instanceof ApiProblem ? err.message : unreachable);

/** "Check your email": the same answer whether or not the address has an account. */
function CheckEmail({ email, what }: { email: string; what: string }) {
  return (
    <>
      <AuthHeading title="Check your email">
        If {email} {what}, we have sent a link to it. The link works once.
      </AuthHeading>
      <Callout tone="info" title="Nothing arrived?" announce={false}>
        <p>Look in your spam or junk folder. In the sandbox, email is not delivered: TshepoVet staff can see what would have been sent.</p>
      </Callout>
      <p className="mt-6">
        <Link href="/sign-in" className="inline-flex min-h-11 items-center">
          Back to sign in
        </Link>
      </p>
    </>
  );
}

// --- Sign up ---------------------------------------------------------------------------------
type SK = 'organisation_name' | 'full_name' | 'email' | 'password' | 'accept_terms';
const SIDS: Record<SK, string> = { organisation_name: 'su-org', full_name: 'su-name', email: 'su-email', password: 'su-password', accept_terms: 'su-terms' };

export function SignUpForm() {
  const [v, setV] = useState({ organisation_name: '', full_name: '', email: '', password: '' });
  const [terms, setTerms] = useState(false);
  const [errors, setErrors] = useState<Errors<SK>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));

  async function submit(e: Submit) {
    e.preventDefault();
    const found = check<SK>({
      organisation_name: [rules.required(v.organisation_name, 'Enter your organisation’s registered name.')],
      full_name: [rules.required(v.full_name, 'Enter your full name.')],
      email: [rules.required(v.email, 'Enter your work email address.'), rules.email(v.email)],
      password: [rules.required(v.password, 'Choose a password.'), rules.minLength(v.password, 12, 'Use at least 12 characters.')],
      accept_terms: [terms ? undefined : 'Accept the terms and the privacy notice to continue.'],
    });
    setErrors(found);
    setProblem(null);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      await api('/api/auth/signup', { method: 'POST', body: { ...v, accept_terms: true } });
      setSent(true);
    } catch (err) {
      const p = fromProblem(err, Object.keys(SIDS) as SK[]);
      setErrors(p.errors);
      setProblem(Object.keys(p.errors).length ? null : p.message);
    } finally {
      setBusy(false);
    }
  }

  if (sent) return <CheckEmail email={v.email} what="can be used for a new account" />;
  return (
    <>
      <AuthHeading title="Create your TshepoVet account">Your organisation gets its own workspace, a wallet for checks, and you as its owner.</AuthHeading>
      <form noValidate onSubmit={submit} className="flex flex-col gap-5">
        <ErrorSummary errors={summary(errors, SIDS)} />
        {problem ? <Callout tone="refused" title={problem} /> : null}
        <Field id={SIDS.organisation_name} label="Organisation" hint="The registered name, for example Acme Trading (Pty) Ltd." error={errors.organisation_name}>
          {(p) => <Input {...p} autoComplete="organization" value={v.organisation_name} onChange={set('organisation_name')} />}
        </Field>
        <Field id={SIDS.full_name} label="Your full name" error={errors.full_name}>
          {(p) => <Input {...p} autoComplete="name" value={v.full_name} onChange={set('full_name')} />}
        </Field>
        <Field id={SIDS.email} label="Work email address" hint="We send a link to confirm it." error={errors.email}>
          {(p) => <Input {...p} type="email" autoComplete="email" value={v.email} onChange={set('email')} spellCheck={false} />}
        </Field>
        <Field id={SIDS.password} label="Password" hint={PASSWORD_HINT} error={errors.password}>
          {(p) => <PasswordInput {...p} autoComplete="new-password" value={v.password} onChange={(x) => setV((s) => ({ ...s, password: x }))} />}
        </Field>
        <div id={SIDS.accept_terms}>
          <Checkbox
            label={
              <>
                I accept the <Link href="/legal/terms">terms of use</Link> and have read the <Link href="/legal/privacy">privacy notice</Link>
              </>
            }
            checked={terms}
            onCheckedChange={setTerms}
            invalid={Boolean(errors.accept_terms)}
          />
          {errors.accept_terms ? <p className="pl-9 text-sm font-semibold text-red">{errors.accept_terms}</p> : null}
        </div>
        <Button type="submit" loading={busy} block>
          Create account
        </Button>
      </form>
      <p className="mt-6 text-ink-2">
        Already have an account?{' '}
        <Link href="/sign-in" className="inline-flex min-h-11 items-center">
          Sign in
        </Link>
      </p>
    </>
  );
}

// --- Confirm email -----------------------------------------------------------------------------
export function VerifyEmail() {
  const token = useHashToken();
  const params = useSearchParams();
  const [state, setState] = useState<'checking' | 'done' | 'invalid' | 'resend'>(params.get('resend') !== null ? 'resend' : 'checking');
  const [email, setEmail] = useState(params.get('resend') ?? '');
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state !== 'checking' || token === undefined) return;
    if (token === null) {
      setState('invalid');
      return;
    }
    api('/api/auth/verify-email', { method: 'POST', body: { token } })
      .then(() => setState('done'))
      .catch(() => setState('invalid'));
  }, [token, state]);

  async function resend(e: Submit) {
    e.preventDefault();
    const err = rules.required(email, 'Enter your email address.') ?? rules.email(email);
    setError(err);
    if (err) return;
    setBusy(true);
    try {
      await api('/api/auth/resend-verification', { method: 'POST', body: { email } });
      setSent(true);
    } catch (e2) {
      setError(message(e2));
    } finally {
      setBusy(false);
    }
  }

  if (sent) return <CheckEmail email={email} what="has an account waiting to be confirmed" />;
  if (state === 'checking') return <Spinner label="Confirming your email address" />;
  if (state === 'done')
    return (
      <>
        <AuthHeading title="Email address confirmed">You can sign in now.</AuthHeading>
        <Button asChild>
          <Link href="/sign-in">Sign in</Link>
        </Button>
      </>
    );
  return (
    <>
      <AuthHeading title={state === 'invalid' ? 'This link has expired or was already used' : 'Confirm your email address'}>
        Enter your email address and we will send a new confirmation link.
      </AuthHeading>
      <form noValidate onSubmit={resend} className="flex flex-col gap-5">
        <Field id="ve-email" label="Email address" error={error}>
          {(p) => <Input {...p} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Button type="submit" loading={busy} block>
          Send a new link
        </Button>
      </form>
    </>
  );
}

// --- Forgot and reset password -----------------------------------------------------------------
export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e: Submit) {
    e.preventDefault();
    const err = rules.required(email, 'Enter your email address.') ?? rules.email(email);
    setError(err);
    if (err) return;
    setBusy(true);
    try {
      await api('/api/auth/password/forgot', { method: 'POST', body: { email } });
      setSent(true);
    } catch (e2) {
      setError(message(e2));
    } finally {
      setBusy(false);
    }
  }
  if (sent) return <CheckEmail email={email} what="has a TshepoVet account" />;
  return (
    <>
      <AuthHeading title="Reset your password">Enter the email address you sign in with. We will send a link to choose a new password.</AuthHeading>
      <form noValidate onSubmit={submit} className="flex flex-col gap-5">
        <Field id="fp-email" label="Email address" error={error}>
          {(p) => <Input {...p} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Button type="submit" loading={busy} block>
          Send reset link
        </Button>
      </form>
      <p className="mt-6">
        <Link href="/sign-in" className="inline-flex min-h-11 items-center">
          Back to sign in
        </Link>
      </p>
    </>
  );
}

export function ResetPassword() {
  const token = useHashToken();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e: Submit) {
    e.preventDefault();
    const err = rules.required(password, 'Choose a new password.') ?? rules.minLength(password, 12, 'Use at least 12 characters.');
    setError(err);
    setProblem(null);
    if (err || !token) return;
    setBusy(true);
    try {
      await api('/api/auth/password/reset', { method: 'POST', body: { token, password } });
      setDone(true);
    } catch (e2) {
      const p = fromProblem(e2, ['password'] as const);
      setError(p.errors.password);
      if (!p.errors.password) setProblem(p.message);
    } finally {
      setBusy(false);
    }
  }
  if (token === undefined) return <Spinner />;
  if (token === null)
    return (
      <>
        <AuthHeading title="This link is not complete">Open the link from the email again, or ask for a new one.</AuthHeading>
        <Button asChild>
          <Link href="/forgot-password">Ask for a new link</Link>
        </Button>
      </>
    );
  if (done)
    return (
      <>
        <AuthHeading title="Password changed">You were signed out everywhere. Sign in with your new password.</AuthHeading>
        <Button asChild>
          <Link href="/sign-in">Sign in</Link>
        </Button>
      </>
    );
  return (
    <>
      <AuthHeading title="Choose a new password" />
      <form noValidate onSubmit={submit} className="flex flex-col gap-5">
        {problem ? (
          <Callout tone="refused" title={problem}>
            <p>
              <Link href="/forgot-password">Ask for a new link</Link>
            </p>
          </Callout>
        ) : null}
        <Field id="rp-password" label="New password" hint={PASSWORD_HINT} error={error}>
          {(p) => <PasswordInput {...p} autoComplete="new-password" value={password} onChange={setPassword} />}
        </Field>
        <Button type="submit" loading={busy} block>
          Change password
        </Button>
      </form>
    </>
  );
}

// --- Accept an invitation ----------------------------------------------------------------------
type AK = 'full_name' | 'password';
export function AcceptInvite() {
  const token = useHashToken();
  const router = useRouter();
  const [invite, setInvite] = useState<{ organisation: string; email: string; role: string } | null | 'gone'>(null);
  const [v, setV] = useState({ full_name: '', password: '' });
  const [errors, setErrors] = useState<Errors<AK>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (token === undefined) return;
    if (token === null) {
      setInvite('gone');
      return;
    }
    api<{ organisation: string; email: string; role: string }>('/api/auth/invitations/lookup', { method: 'POST', body: { token } })
      .then(setInvite)
      .catch(() => setInvite('gone'));
  }, [token]);

  async function submit(e: Submit) {
    e.preventDefault();
    const found = check<AK>({
      full_name: [rules.required(v.full_name, 'Enter your full name.')],
      password: [rules.required(v.password, 'Choose a password.'), rules.minLength(v.password, 12, 'Use at least 12 characters.')],
    });
    setErrors(found);
    setProblem(null);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      const r = await api<{ session: { csrf_token: string; stage: string } }>('/api/auth/invitations/accept', { method: 'POST', body: { token, ...v } });
      setCsrfToken(r.session.csrf_token);
      router.replace(r.session.stage === 'mfa_setup' ? '/app/mfa-setup' : '/app');
    } catch (e2) {
      const p = fromProblem(e2, ['full_name', 'password'] as const);
      setErrors(p.errors);
      setProblem(Object.keys(p.errors).length ? null : p.message);
    } finally {
      setBusy(false);
    }
  }

  if (invite === null) return <Spinner label="Opening your invitation" />;
  if (invite === 'gone')
    return <AuthHeading title="This invitation has expired or was already used">Ask the person who invited you to send a new one.</AuthHeading>;
  const role = invite.role.replace('_', ' ');
  return (
    <>
      <AuthHeading title={`Join ${invite.organisation}`}>
        You were invited as {/^[aeiou]/.test(role) ? 'an' : 'a'} {role}. You will sign in with {invite.email}.
      </AuthHeading>
      <form noValidate onSubmit={submit} className="flex flex-col gap-5">
        <ErrorSummary errors={summary(errors, { full_name: 'ai-name', password: 'ai-password' })} />
        {problem ? <Callout tone="refused" title={problem} /> : null}
        <Field id="ai-name" label="Your full name" error={errors.full_name}>
          {(p) => <Input {...p} autoComplete="name" value={v.full_name} onChange={(e) => setV((s) => ({ ...s, full_name: e.target.value }))} />}
        </Field>
        <Field id="ai-password" label="Choose a password" hint={PASSWORD_HINT} error={errors.password}>
          {(p) => <PasswordInput {...p} autoComplete="new-password" value={v.password} onChange={(x) => setV((s) => ({ ...s, password: x }))} />}
        </Field>
        <Button type="submit" loading={busy} block>
          Join {invite.organisation}
        </Button>
      </form>
    </>
  );
}
