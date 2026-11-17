'use client';

import QRCode from 'qrcode';
import { useState } from 'react';
import { AuthHeading, PasswordInput } from '@/components/auth/parts';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/form';
import { ApiProblem, setStaffCsrfToken, staffApi } from '@/lib/api';
import { rules } from '@/lib/forms';

/**
 * Staff sign-in: email and password, then the authenticator code. Two-step verification is
 * mandatory for staff: a member who has not enrolled does it here before anything else.
 */
type Session = { stage: 'full' | 'mfa_setup'; csrf_token: string };
const message = (e: unknown) => (e instanceof ApiProblem ? e.message : 'TshepoVet could not be reached. Check your connection and try again.');

export function StaffSignIn() {
  const [step, setStep] = useState<'credentials' | 'code' | 'enrol'>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState('');
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const done = (s: Session) => {
    setStaffCsrfToken(s.csrf_token);
    if (s.stage === 'full') window.location.assign('/staff');
    else void enrol();
  };

  async function enrol() {
    setStep('enrol');
    try {
      const s = await staffApi<{ secret: string; otpauth_uri: string }>('/api/staff/auth/mfa/setup', { method: 'POST' });
      const qr = await QRCode.toDataURL(s.otpauth_uri, { margin: 1, width: 288, errorCorrectionLevel: 'M', color: { dark: '#10242c', light: '#ffffff' } });
      setSetup({ secret: s.secret, qr });
    } catch (e) {
      setError(message(e));
    }
  }

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    setError(undefined);
    if (step === 'credentials') {
      const err = rules.required(email, 'Enter your email address.') ?? rules.email(email) ?? rules.required(password, 'Enter your password.');
      if (err) return setError(err);
    } else {
      const err = rules.totp(code);
      if (err) return setError(err);
    }
    setBusy(true);
    try {
      if (step === 'credentials') {
        const r = await staffApi<{ mfa_required: boolean; challenge?: string; session?: Session }>('/api/staff/auth/login', { method: 'POST', body: { email, password } });
        if (r.mfa_required) {
          setChallenge(r.challenge!);
          setStep('code');
        } else done(r.session!);
      } else if (step === 'code') {
        const r = await staffApi<{ session: Session }>('/api/staff/auth/mfa', { method: 'POST', body: { challenge, code: code.replace(/\s/g, '') } });
        done(r.session);
      } else {
        await staffApi('/api/staff/auth/mfa/enable', { method: 'POST', body: { code: code.replace(/\s/g, '') } });
        window.location.assign('/staff');
      }
    } catch (e2) {
      setError(message(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <AuthHeading title={step === 'enrol' ? 'Set up two-step verification' : 'Staff sign-in'}>
        {step === 'credentials'
          ? 'For TshepoVet staff. Customers sign in at the portal.'
          : step === 'code'
            ? 'Enter the 6-digit code from your authenticator app.'
            : 'Staff must use two-step verification. Scan the code with an authenticator app, then enter the code it shows.'}
      </AuthHeading>
      <form noValidate onSubmit={submit} className="flex flex-col gap-5">
        {error ? <Callout tone="refused" title={error} /> : null}
        {step === 'credentials' ? (
          <>
            <Field id="st-email" label="Email address">
              {(p) => <Input {...p} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />}
            </Field>
            <Field id="st-password" label="Password">
              {(p) => <PasswordInput {...p} autoComplete="current-password" value={password} onChange={setPassword} />}
            </Field>
          </>
        ) : null}
        {step === 'enrol' && setup ? (
          <div className="flex flex-col items-start gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- a generated data: URL */}
            <img src={setup.qr} width={288} height={288} alt="QR code for your authenticator app" className="rounded-control border border-rule bg-white p-2" />
            <p className="text-sm text-ink-2">
              Setup key: <span className="font-mono break-all text-ink">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</span>
            </p>
          </div>
        ) : null}
        {step !== 'credentials' ? (
          <Field id="st-code" label="6-digit code">
            {(p) => <Input {...p} mono inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />}
          </Field>
        ) : null}
        <Button type="submit" loading={busy} block>
          {step === 'credentials' ? 'Sign in' : step === 'code' ? 'Continue' : 'Turn on two-step verification'}
        </Button>
      </form>
    </>
  );
}
