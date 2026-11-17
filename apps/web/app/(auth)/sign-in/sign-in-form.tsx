'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AuthHeading, PasswordInput, safeNext } from '@/components/auth/parts';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/feedback';
import { ErrorSummary, Field, Input } from '@/components/ui/form';
import { api, ApiProblem, setCsrfToken } from '@/lib/api';
import { check, type Errors, rules, summary } from '@/lib/forms';

type Step = { kind: 'password' } | { kind: 'code'; challenge: string };
type K = 'email' | 'password' | 'code';
const IDS: Record<K, string> = { email: 'signin-email', password: 'signin-password', code: 'signin-code' };

function SignIn() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [errors, setErrors] = useState<Errors<K>>({});
  const [problem, setProblem] = useState<{ title: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const done = (session: { csrf_token: string; stage: string }) => {
    setCsrfToken(session.csrf_token);
    router.replace(session.stage === 'mfa_setup' ? '/app/mfa-setup' : next);
  };

  async function submitPassword(e: { preventDefault(): void }) {
    e.preventDefault();
    const found = check<K>({ email: [rules.required(email, 'Enter your email address.'), rules.email(email)], password: [rules.required(password, 'Enter your password.')], code: [] });
    setErrors(found);
    setProblem(null);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      const r = await api<{ mfa_required: boolean; challenge?: string; session?: { csrf_token: string; stage: string } }>('/api/auth/login', { method: 'POST', body: { email, password } });
      if (r.mfa_required) setStep({ kind: 'code', challenge: r.challenge! });
      else done(r.session!);
    } catch (err) {
      setProblem(err instanceof ApiProblem ? { title: err.message, code: err.code } : { title: 'TshepoVet could not be reached. Check your connection and try again.' });
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: { preventDefault(): void }) {
    e.preventDefault();
    if (step.kind !== 'code') return;
    const found = check<K>({ email: [], password: [], code: [useRecovery ? rules.required(code, 'Enter one of your recovery codes.') : rules.totp(code)] });
    setErrors(found);
    setProblem(null);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      const body = useRecovery ? { challenge: step.challenge, recovery_code: code.trim() } : { challenge: step.challenge, code: code.replace(/\s/g, '') };
      const r = await api<{ session: { csrf_token: string; stage: string } }>('/api/auth/mfa', { method: 'POST', body });
      done(r.session);
    } catch (err) {
      if (err instanceof ApiProblem && err.code === 'challenge_expired') {
        setStep({ kind: 'password' });
        setCode('');
      }
      setProblem(err instanceof ApiProblem ? { title: err.message, code: err.code } : { title: 'TshepoVet could not be reached. Check your connection and try again.' });
    } finally {
      setBusy(false);
    }
  }

  if (step.kind === 'code') {
    return (
      <>
        <AuthHeading title="Two-step verification">
          {useRecovery ? 'Enter one of the recovery codes you saved when you set up two-step verification.' : 'Enter the 6-digit code from your authenticator app.'}
        </AuthHeading>
        <form noValidate onSubmit={submitCode} className="flex flex-col gap-5">
          <ErrorSummary errors={summary(errors, IDS)} />
          {problem ? <Callout tone="refused" title={problem.title} /> : null}
          <Field id={IDS.code} label={useRecovery ? 'Recovery code' : 'Code'} error={errors.code}>
            {(p) => (
              <Input
                {...p}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode={useRecovery ? 'text' : 'numeric'}
                autoComplete="one-time-code"
                mono
                autoFocus
                className="text-lg tracking-[0.2em]"
              />
            )}
          </Field>
          <Button type="submit" loading={busy} block>
            Sign in
          </Button>
          <Button
            intent="quiet"
            onClick={() => {
              setUseRecovery((v) => !v);
              setCode('');
              setErrors({});
            }}
          >
            {useRecovery ? 'Use a code from the app instead' : 'I cannot use my authenticator app'}
          </Button>
        </form>
      </>
    );
  }

  return (
    <>
      <AuthHeading title="Sign in to TshepoVet" />
      <form noValidate onSubmit={submitPassword} className="flex flex-col gap-5">
        <ErrorSummary errors={summary(errors, IDS)} />
        {problem ? (
          <Callout tone="refused" title={problem.title}>
            {problem.code === 'email_unverified' ? (
              <p>
                <Link href={`/verify-email?resend=${encodeURIComponent(email)}`}>Send the confirmation email again</Link>
              </p>
            ) : problem.code === 'invalid_credentials' || problem.code === 'account_locked' ? (
              <p>
                <Link href="/forgot-password">Reset your password</Link> if you cannot remember it.
              </p>
            ) : null}
          </Callout>
        ) : null}
        <Field id={IDS.email} label="Email address" error={errors.email}>
          {(p) => <Input {...p} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} spellCheck={false} />}
        </Field>
        <Field id={IDS.password} label="Password" error={errors.password}>
          {(p) => <PasswordInput {...p} autoComplete="current-password" value={password} onChange={setPassword} />}
        </Field>
        <Button type="submit" loading={busy} block>
          Sign in
        </Button>
      </form>
      <div className="mt-6 flex flex-col gap-1">
        <Link href="/forgot-password" className="inline-flex min-h-11 items-center">
          Forgot your password?
        </Link>
        <p className="text-ink-2">
          New to TshepoVet?{' '}
          <Link href="/sign-up" className="inline-flex min-h-11 items-center">
            Create an account
          </Link>
        </p>
      </div>
    </>
  );
}

export function SignInForm() {
  return (
    <Suspense>
      <SignIn />
    </Suspense>
  );
}
