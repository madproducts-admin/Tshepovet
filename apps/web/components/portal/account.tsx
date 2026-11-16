'use client';

import QRCode from 'qrcode';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { MFA_REQUIRED_ROLES, ROLE_LABELS, type Role, type SettingsSchema } from '@tshepovet/contracts';
import { PasswordInput, PASSWORD_HINT } from '@/components/auth/parts';
import { Button } from '@/components/ui/button';
import { Kbd, When } from '@/components/ui/data';
import { Callout, Stamp } from '@/components/ui/feedback';
import { Checkbox, ErrorSummary, Field, Input, Switch } from '@/components/ui/form';
import { PageHeader, RecordList, Sheet } from '@/components/ui/layout';
import { ConfirmDialog, Dialog, DialogClose } from '@/components/ui/overlay';
import { ThemeSwitch } from '@/components/ui/theme';
import { api, ApiProblem } from '@/lib/api';
import { fromProblem, rules } from '@/lib/forms';
import { useApi, useChange, useSession } from '@/lib/queries';
import type { ThemeChoice } from '@/lib/theme';
import { Loaded } from './common';

type Settings = z.infer<typeof SettingsSchema>;

// --- Organisation settings ---------------------------------------------------------------------
export function SettingsPage() {
  const { can } = useSession();
  const q = useApi<Settings>('/api/settings');
  return (
    <>
      <PageHeader title="Settings" description="Your organisation’s details and how TshepoVet behaves for everyone in it." />
      <Loaded q={q} label="Settings">{(s) => <SettingsForm s={s} editable={can('settings:manage')} />}</Loaded>
    </>
  );
}

function SettingsForm({ s, editable }: { s: Settings; editable: boolean }) {
  const [o, setO] = useState({
    legal_name: s.organisation.legal_name,
    registration_number: s.organisation.registration_number ?? '',
    vat_number: s.organisation.vat_number ?? '',
    information_officer_email: s.organisation.information_officer_email ?? '',
    is_public_sector: s.organisation.is_public_sector,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useChange((b: unknown) => api<Settings>('/api/settings', { method: 'PATCH', body: b }), { invalidate: ['/api/settings', '/api/auth/session'], success: 'Settings saved' });
  const pref = useChange((b: unknown) => api<Settings>('/api/settings', { method: 'PATCH', body: { preferences: b } }), { invalidate: ['/api/settings', '/api/checks/prices'], success: 'Preference saved' });
  const ids = { legal_name: 'st-name', registration_number: 'st-reg', vat_number: 'st-vat', information_officer_email: 'st-io' } as const;
  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    const found: Record<string, string> = {};
    if (!o.legal_name.trim()) found.legal_name = 'Enter the organisation’s registered name.';
    if (o.registration_number && !/^\d{4}\/\d{6}\/\d{2}$/.test(o.registration_number)) found.registration_number = 'Use the CIPC format, for example 2019/123456/07.';
    if (o.vat_number && !/^4\d{9}$/.test(o.vat_number)) found.vat_number = 'VAT numbers are 10 digits starting with 4.';
    if (o.information_officer_email && rules.email(o.information_officer_email)) found.information_officer_email = 'Enter an email address like io@company.co.za.';
    setErrors(found);
    if (Object.keys(found).length) return;
    try {
      await save.mutateAsync({
        organisation: {
          legal_name: o.legal_name,
          registration_number: o.registration_number || null,
          vat_number: o.vat_number || null,
          information_officer_email: o.information_officer_email || null,
          is_public_sector: o.is_public_sector,
        },
      });
    } catch (err) {
      setErrors(fromProblem(err, Object.keys(ids) as Array<keyof typeof ids>).errors as Record<string, string>);
    }
  };
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,40rem)_1fr]">
      <Sheet title="Organisation">
        {editable ? (
          <form noValidate onSubmit={submit} className="flex flex-col gap-5">
            <ErrorSummary errors={Object.entries(errors).map(([k, message]) => ({ field: ids[k as keyof typeof ids], message }))} />
            <Field id={ids.legal_name} label="Registered name" error={errors.legal_name}>
              {(p) => <Input {...p} value={o.legal_name} onChange={(e) => setO((x) => ({ ...x, legal_name: e.target.value }))} />}
            </Field>
            <Field id={ids.registration_number} label="Registration number" optional error={errors.registration_number}>
              {(p) => <Input {...p} mono value={o.registration_number} onChange={(e) => setO((x) => ({ ...x, registration_number: e.target.value }))} />}
            </Field>
            <Field id={ids.vat_number} label="VAT number" optional error={errors.vat_number}>
              {(p) => <Input {...p} mono inputMode="numeric" value={o.vat_number} onChange={(e) => setO((x) => ({ ...x, vat_number: e.target.value }))} />}
            </Field>
            <Field id={ids.information_officer_email} label="Information officer’s email" optional hint="POPIA requires an information officer. Suppliers’ requests about their information go to them." error={errors.information_officer_email}>
              {(p) => <Input {...p} type="email" value={o.information_officer_email} onChange={(e) => setO((x) => ({ ...x, information_officer_email: e.target.value }))} />}
            </Field>
            <Checkbox
              label="We are a public-sector buyer"
              hint="Under the PFMA or MFMA, suppliers must be on the Central Supplier Database."
              checked={o.is_public_sector}
              onCheckedChange={(v) => setO((x) => ({ ...x, is_public_sector: v }))}
            />
            <div>
              <Button type="submit" loading={save.isPending}>
                Save changes
              </Button>
            </div>
          </form>
        ) : (
          <RecordList
            columns={1}
            items={[
              { label: 'Registered name', value: s.organisation.legal_name },
              { label: 'Registration number', value: s.organisation.registration_number },
              { label: 'VAT number', value: s.organisation.vat_number },
              { label: 'Information officer', value: s.organisation.information_officer_email },
            ]}
          />
        )}
      </Sheet>
      <Sheet title="How TshepoVet works for you" description={editable ? 'Changes apply at once, for everyone.' : 'Only owners and administrators can change these.'}>
        <div className="flex flex-col divide-y divide-rule">
          <Switch
            label="Ask for consent on every check"
            hint="Even where your legitimate interest would do. Some organisations prefer it."
            checked={s.preferences.require_consent_for_all_checks}
            onCheckedChange={(v) => pref.mutate({ require_consent_for_all_checks: v })}
            disabled={!editable || pref.isPending}
          />
          <Switch label="Email me when the wallet runs low" checked={s.preferences.notify_low_balance} onCheckedChange={(v) => pref.mutate({ notify_low_balance: v })} disabled={!editable || pref.isPending} />
          <Switch label="Email me before documents expire" checked={s.preferences.notify_expiries} onCheckedChange={(v) => pref.mutate({ notify_expiries: v })} disabled={!editable || pref.isPending} />
        </div>
      </Sheet>
    </div>
  );
}

// --- Your account ------------------------------------------------------------------------------
interface SessionRow {
  id: string;
  current: boolean;
  created_at: string;
  last_seen_at: string;
  ip: string | null;
  user_agent: string | null;
}

function device(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

export function AccountPage({ theme }: { theme: ThemeChoice }) {
  const { session } = useSession();
  const sessions = useApi<{ sessions: SessionRow[] }>('/api/auth/sessions');
  const end = useChange((id: string) => api(`/api/auth/sessions/${id}`, { method: 'DELETE' }), { invalidate: ['/api/auth/sessions'], success: 'Signed out of that device' });
  const others = useChange(() => api<{ ended: number }>('/api/auth/sessions/revoke-others', { method: 'POST' }), {
    invalidate: ['/api/auth/sessions'],
    success: (r) => (r.ended ? `Signed out of ${r.ended} other device${r.ended === 1 ? '' : 's'}` : 'No other devices were signed in'),
  });
  const mfaRequired = (MFA_REQUIRED_ROLES as readonly string[]).includes(session.user.role);
  return (
    <>
      <PageHeader title="Your account" description={`${session.user.full_name}, ${session.user.email}`} />
      <div className="grid gap-6 xl:grid-cols-2">
        <Sheet title="You">
          <RecordList
            columns={1}
            items={[
              { label: 'Name', value: session.user.full_name },
              { label: 'Email address', value: session.user.email },
              { label: 'Role', value: ROLE_LABELS[session.user.role as Role] ?? session.user.role, note: 'An administrator can change it.' },
              { label: 'Organisation', value: session.organisation.legal_name },
            ]}
          />
          <div className="mt-6 max-w-sm">
            <ThemeSwitch initial={theme} />
          </div>
        </Sheet>
        <Sheet title="Two-step verification" actions={session.user.mfa_enrolled ? <Stamp tone="verified">On</Stamp> : <Stamp tone="caution">Off</Stamp>}>
          {session.user.mfa_enrolled ? (
            <div className="flex flex-col gap-4">
              <p>Signing in needs your password and a code from your authenticator app.</p>
              <div className="flex flex-wrap gap-3">
                <RecoveryCodes />
                {mfaRequired ? null : <DisableMfa />}
              </div>
              {mfaRequired ? <p className="text-sm text-ink-2">Owners and administrators must keep two-step verification on.</p> : null}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <p>Protect your account with a code from an app on your phone as well as your password.</p>
              <div>
                <Button asChild>
                  <Link href="/app/mfa-setup">Turn on two-step verification</Link>
                </Button>
              </div>
            </div>
          )}
        </Sheet>
        <Sheet title="Password">
          <ChangePassword />
        </Sheet>
        <Sheet
          title="Where you are signed in"
          actions={
            <Button intent="secondary" size="sm" loading={others.isPending} onClick={() => others.mutate(undefined)}>
              Sign out everywhere else
            </Button>
          }
        >
          <Loaded q={sessions} label="Your sessions">
            {(d) => (
              <ul className="flex flex-col divide-y divide-rule">
                {d.sessions.map((x) => (
                  <li key={x.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div>
                      <p className="font-semibold">
                        {device(x.user_agent)}
                        {x.current ? ' (this device)' : ''}
                      </p>
                      <p className="text-sm text-ink-2">
                        {x.ip ? `${x.ip}, ` : ''}last active <When value={x.last_seen_at} />
                      </p>
                    </div>
                    {x.current ? null : (
                      <Button intent="quiet" size="sm" onClick={() => end.mutate(x.id)}>
                        Sign out
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Loaded>
        </Sheet>
      </div>
    </>
  );
}

function ChangePassword() {
  const [v, setV] = useState({ current_password: '', new_password: '' });
  const [errors, setErrors] = useState<{ current_password?: string; new_password?: string }>({});
  const change = useChange((b: unknown) => api('/api/auth/password/change', { method: 'POST', body: b }), { invalidate: ['/api/auth/sessions'], success: 'Password changed: other devices were signed out' });
  return (
    <form
      noValidate
      className="flex flex-col gap-5"
      onSubmit={async (e) => {
        e.preventDefault();
        const found = {
          current_password: rules.required(v.current_password, 'Enter your current password.'),
          new_password: rules.required(v.new_password, 'Choose a new password.') ?? rules.minLength(v.new_password, 12, 'Use at least 12 characters.'),
        };
        setErrors(found);
        if (found.current_password || found.new_password) return;
        try {
          await change.mutateAsync(v);
          setV({ current_password: '', new_password: '' });
        } catch (err) {
          const p = fromProblem(err, ['current_password', 'new_password'] as const);
          setErrors(Object.keys(p.errors).length ? p.errors : { current_password: p.message });
        }
      }}
    >
      <Field label="Current password" error={errors.current_password}>
        {(p) => <PasswordInput {...p} autoComplete="current-password" value={v.current_password} onChange={(x) => setV((s) => ({ ...s, current_password: x }))} />}
      </Field>
      <Field label="New password" hint={PASSWORD_HINT} error={errors.new_password}>
        {(p) => <PasswordInput {...p} autoComplete="new-password" value={v.new_password} onChange={(x) => setV((s) => ({ ...s, new_password: x }))} />}
      </Field>
      <div>
        <Button type="submit" loading={change.isPending}>
          Change password
        </Button>
      </div>
    </form>
  );
}

function CodesList({ codes }: { codes: string[] }) {
  return (
    <div className="flex flex-col gap-3">
      <Callout tone="caution" title="Save these codes now" announce={false}>
        <p>Each one signs you in once if you lose your phone. TshepoVet will not show them again.</p>
      </Callout>
      <ol className="grid grid-cols-2 gap-2 font-mono text-lg">
        {codes.map((c) => (
          <li key={c} className="rounded-control border border-rule bg-sheet-2 px-3 py-1.5 text-center">
            {c}
          </li>
        ))}
      </ol>
      <Button
        intent="secondary"
        onClick={() => navigator.clipboard.writeText(codes.join('\n'))}
      >
        Copy the codes
      </Button>
    </div>
  );
}

function RecoveryCodes() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string>();
  const make = useChange((b: unknown) => api<{ recovery_codes: string[] }>('/api/auth/mfa/recovery-codes', { method: 'POST', body: b }));
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setCodes(null);
          setPassword('');
        }
      }}
      title={codes ? 'Your new recovery codes' : 'New recovery codes'}
      description={codes ? undefined : 'Your old codes stop working.'}
      trigger={<Button intent="secondary">New recovery codes</Button>}
      footer={
        codes ? (
          <DialogClose asChild>
            <Button>I have saved them</Button>
          </DialogClose>
        ) : (
          <Button
            loading={make.isPending}
            onClick={async () => {
              try {
                setCodes((await make.mutateAsync({ password })).recovery_codes);
              } catch (e) {
                setError(e instanceof ApiProblem ? e.message : 'That did not work. Try again.');
              }
            }}
          >
            Make new codes
          </Button>
        )
      }
    >
      {codes ? (
        <CodesList codes={codes} />
      ) : (
        <Field label="Your password" error={error}>
          {(p) => <PasswordInput {...p} autoComplete="current-password" value={password} onChange={setPassword} />}
        </Field>
      )}
    </Dialog>
  );
}

function DisableMfa() {
  const { refresh } = useSession();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const off = useChange((b: unknown) => api('/api/auth/mfa/disable', { method: 'POST', body: b }), { success: 'Two-step verification turned off', onSuccess: () => refresh() });
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Turn off two-step verification?"
      description="Your account is then protected by your password alone."
      trigger={<Button intent="quiet">Turn off</Button>}
      footer={
        <>
          <DialogClose asChild>
            <Button intent="secondary">Keep it on</Button>
          </DialogClose>
          <Button
            intent="danger"
            loading={off.isPending}
            onClick={async () => {
              try {
                await off.mutateAsync({ password, code: code.replace(/\s/g, '') });
                setOpen(false);
              } catch (e) {
                setError(e instanceof ApiProblem ? e.message : 'That did not work.');
              }
            }}
          >
            Turn off
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {error ? <Callout tone="refused" title={error} /> : null}
        <Field label="Your password">{(p) => <PasswordInput {...p} autoComplete="current-password" value={password} onChange={setPassword} />}</Field>
        <Field label="A code from your app">{(p) => <Input {...p} inputMode="numeric" autoComplete="one-time-code" mono value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}

// --- Two-step verification setup ------------------------------------------------------------------
export function MfaSetupPage() {
  const { session, refresh } = useSession();
  const router = useRouter();
  const [setup, setSetup] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [qr, setQr] = useState<string>('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const forced = session.stage === 'mfa_setup';

  useEffect(() => {
    if (session.user.mfa_enrolled && !codes) router.replace('/app/account');
  }, [session.user.mfa_enrolled, codes, router]);
  useEffect(() => {
    api<{ secret: string; otpauth_uri: string }>('/api/auth/mfa/setup', { method: 'POST' })
      .then(async (s) => {
        setSetup(s);
        setQr(await QRCode.toDataURL(s.otpauth_uri, { margin: 1, width: 352, errorCorrectionLevel: 'M', color: { dark: '#10242c', light: '#ffffff' } }));
      })
      .catch((e) => setError(e instanceof ApiProblem ? e.message : 'Setup could not start. Reload the page.'));
  }, []);

  if (codes) {
    return (
      <div className="max-w-xl">
        <PageHeader title="Two-step verification is on" />
        <CodesList codes={codes} />
        <Button
          className="mt-6"
          onClick={async () => {
            await refresh();
            router.replace('/app');
          }}
        >
          Continue to TshepoVet
        </Button>
      </div>
    );
  }
  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Set up two-step verification"
        description={forced ? 'Your role holds the keys to your organisation, so TshepoVet asks for a code from your phone as well as your password. It takes a minute.' : 'Sign in with your password and a code from your phone.'}
      />
      {error ? <Callout tone="refused" title={error} className="mb-6" /> : null}
      <ol className="flex flex-col gap-6">
        <li>
          <Sheet title="1. Get an authenticator app" headingLevel={2}>
            <p>Any authenticator app works: Google Authenticator, Microsoft Authenticator, 1Password, or the one your organisation uses.</p>
          </Sheet>
        </li>
        <li>
          <Sheet title="2. Add TshepoVet to it" headingLevel={2}>
            <div className="flex flex-wrap items-start gap-6">
              {/* The QR code is drawn here, in the browser, from the setup key written out beside it. */}
              <div className="grid size-48 shrink-0 place-items-center rounded-control border border-rule bg-white p-2">
                {qr ? <img src={qr} alt="QR code to scan with your authenticator app. The same key is written out beside it." width={176} height={176} /> : null}
              </div>
              <div className="min-w-0 flex-1">
                <p>Scan the code with the app. If you cannot scan it, type this key instead:</p>
                <p className="mt-2 font-mono text-lg break-all" aria-label={`Setup key: ${setup?.secret.split('').join(' ') ?? ''}`}>
                  {setup?.secret.match(/.{1,4}/g)?.join(' ') ?? '…'}
                </p>
                <p className="mt-2 text-sm text-ink-2">
                  Choose a time-based key if the app asks. Press <Kbd>Tab</Kbd> to move on once it is added.
                </p>
              </div>
            </div>
          </Sheet>
        </li>
        <li>
          <Sheet title="3. Enter the code it shows" headingLevel={2}>
            <form
              noValidate
              className="flex flex-col gap-5"
              onSubmit={async (e) => {
                e.preventDefault();
                const err = rules.totp(code);
                setError(err);
                if (err) return;
                setBusy(true);
                try {
                  const r = await api<{ recovery_codes: string[] }>('/api/auth/mfa/enable', { method: 'POST', body: { code: code.replace(/\s/g, '') } });
                  setCodes(r.recovery_codes);
                } catch (e2) {
                  setError(e2 instanceof ApiProblem ? e2.message : 'That did not work. Try again.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Field label="6-digit code" hint="The code changes every 30 seconds. Enter the one showing now.">
                {(p) => <Input {...p} inputMode="numeric" autoComplete="one-time-code" mono value={code} onChange={(e) => setCode(e.target.value)} className="max-w-48 text-lg tracking-[0.2em]" />}
              </Field>
              <div>
                <Button type="submit" loading={busy} disabled={!setup}>
                  Turn on two-step verification
                </Button>
              </div>
            </form>
          </Sheet>
        </li>
      </ol>
      {forced ? (
        <p className="mt-6">
          <ConfirmDialog
            trigger={<Button intent="quiet">Sign out instead</Button>}
            title="Sign out?"
            consequence={<p>You will need to set up two-step verification the next time you sign in.</p>}
            confirmLabel="Sign out"
            onConfirm={async () => {
              await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
              window.location.assign('/sign-in');
            }}
          />
        </p>
      ) : null}
    </div>
  );
}
