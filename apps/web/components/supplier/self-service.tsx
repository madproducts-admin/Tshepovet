'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { PASSPORT_FIELDS, type VendorPortalSchema } from '@tshepovet/contracts';
import { AuthHeading, useHashToken } from '@/components/auth/parts';
import { humanise, Loaded } from '@/components/portal/common';
import { PURPOSE_LABELS } from '@/components/portal/compliance';
import { Button } from '@/components/ui/button';
import { type Column, DataTable, Term, When } from '@/components/ui/data';
import { Callout, EmptyState, Spinner, Stamp, type Tone } from '@/components/ui/feedback';
import { Checkbox, ErrorSummary, Field, Input, RadioGroup, Select, Textarea } from '@/components/ui/form';
import { PageHeader, RecordList, Sheet } from '@/components/ui/layout';
import { ConfirmDialog, Dialog, DialogClose } from '@/components/ui/overlay';
import { toast } from '@/components/ui/toast';
import { ApiProblem, setVendorCsrfToken, vendorApi } from '@/lib/api';
import { formatDay } from '@/lib/format';
import { rules } from '@/lib/forms';

/**
 * Supplier self-service (docs/PLAN.md M6). A supplier's director signs in with a link emailed
 * to the address they onboarded with (no password to forget), and controls what TshepoVet
 * holds about the company: the public passport, consents given to each customer, and POPIA
 * requests to those customers.
 */
type VendorPortal = z.infer<typeof VendorPortalSchema>;
const unreachable = 'TshepoVet could not be reached. Check your connection and try again.';
const message = (err: unknown) => (err instanceof ApiProblem ? err.message : unreachable);

// --- Sign in -----------------------------------------------------------------------------------
export function SupplierSignIn() {
  const token = useHashToken();
  const router = useRouter();
  const [stage, setStage] = useState<'form' | 'signing-in' | 'sent' | 'invalid'>('form');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    setStage('signing-in');
    vendorApi<{ csrf_token: string }>('/api/vendor/auth/exchange', { method: 'POST', body: { token } })
      .then((r) => {
        setVendorCsrfToken(r.csrf_token);
        router.replace('/supplier');
      })
      .catch(() => setStage('invalid'));
  }, [token, router]);

  async function send(e: { preventDefault(): void }) {
    e.preventDefault();
    const err = rules.required(email, 'Enter the email address you onboarded with.') ?? rules.email(email);
    setError(err);
    if (err) return;
    setBusy(true);
    try {
      await vendorApi('/api/vendor/auth/magic-link', { method: 'POST', body: { email } });
      setStage('sent');
    } catch (e2) {
      setError(message(e2));
    } finally {
      setBusy(false);
    }
  }

  if (stage === 'signing-in') return <Spinner label="Signing you in" />;
  if (stage === 'sent') {
    return (
      <>
        <AuthHeading title="Check your email">If {email} can sign in for a supplier, we have sent a link to it. The link works once, for 15 minutes.</AuthHeading>
        <Callout tone="info" title="Nothing arrived?" announce={false}>
          <p>
            Look in your spam or junk folder. Sign-in is for directors whose identity matched the company register when they onboarded; if that was not you, ask
            the customer who invited you.
          </p>
          <p className="mt-2">In the sandbox, email is not delivered: TshepoVet staff can see what would have been sent.</p>
        </Callout>
      </>
    );
  }
  return (
    <>
      <AuthHeading title={stage === 'invalid' ? 'This link has expired or was already used' : 'Sign in as a supplier'}>
        {stage === 'invalid' ? 'Ask for a new one below.' : 'Manage your passport, see which customers hold your details, and withdraw consent.'}
      </AuthHeading>
      <form noValidate onSubmit={send} className="flex flex-col gap-5">
        <Field id="ss-email" label="Email address" hint="The address your customer’s invitation was sent to." error={error}>
          {(p) => <Input {...p} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Button type="submit" loading={busy} block>
          Email me a sign-in link
        </Button>
      </form>
      <p className="mt-6 text-ink-2">
        Buying from suppliers?{' '}
        <Link href="/sign-in" className="inline-flex min-h-11 items-center">
          Sign in to the buyer portal
        </Link>
      </p>
    </>
  );
}

// --- The self-service page ---------------------------------------------------------------------
const ME = ['vendor-me'];

export function SupplierPortal() {
  const q = useQuery<VendorPortal, ApiProblem>({ queryKey: ME, queryFn: () => vendorApi<VendorPortal>('/api/vendor/me'), retry: false });
  const [leaving, setLeaving] = useState(false);
  const signOut = async () => {
    setLeaving(true);
    try {
      await vendorApi('/api/vendor/auth/logout', { method: 'POST' });
    } finally {
      setVendorCsrfToken(null);
      window.location.assign('/supplier/sign-in');
    }
  };
  return (
    <Loaded q={q} label="Your company’s record">
      {(d) => (
        <>
          <PageHeader
            title={d.vendor.legal_name}
            meta={
              <>
                {d.vendor.registration_number ? <span className="font-mono text-ink-2">{d.vendor.registration_number}</span> : null}
                <span className="text-ink-2">
                  Signed in as {d.contact.full_name} ({d.contact.email})
                </span>
              </>
            }
            actions={
              <Button intent="secondary" loading={leaving} onClick={signOut}>
                Sign out
              </Button>
            }
          />
          <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
            <div className="flex min-w-0 flex-col gap-6">
              <PassportControl d={d} />
              <Customers d={d} />
              <Consents d={d} />
              <Requests d={d} />
            </div>
            <div className="flex min-w-0 flex-col gap-6">
              <Company d={d} />
              <Documents d={d} />
            </div>
          </div>
        </>
      )}
    </Loaded>
  );
}

/** Mutations on the supplier's record: refresh it, confirm in the button's words. */
function useVendorChange() {
  const qc = useQueryClient();
  return async (fn: () => Promise<unknown>, done: string) => {
    await fn();
    await qc.invalidateQueries({ queryKey: ME });
    toast.success(done);
  };
}

export const PASSPORT_FIELD_LABELS: Record<(typeof PASSPORT_FIELDS)[number], string> = {
  legal_name: 'Registered name',
  registration_number: 'Registration number',
  cipc_status: 'Status on the CIPC register',
  vat_status: 'VAT registration',
  tcs_status: 'Tax compliance status',
  bbbee_level: 'B-BBEE level',
  directors_initials: 'Directors’ initials',
  verified_at: 'When it was verified',
};

const PASSPORT_STATUS: Record<VendorPortal['vendor']['passport_status'], { tone: Tone; label: string }> = {
  none: { tone: 'neutral', label: 'Not published' },
  active: { tone: 'verified', label: 'Published' },
  suspended: { tone: 'refused', label: 'Suspended by TshepoVet' },
  revoked: { tone: 'neutral', label: 'Withdrawn' },
};

function PassportControl({ d }: { d: VendorPortal }) {
  const v = d.vendor;
  const [fields, setFields] = useState<string[]>(v.passport_public_fields.length ? v.passport_public_fields : [...PASSPORT_FIELDS]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const change = useVendorChange();
  const status = PASSPORT_STATUS[v.passport_status];
  const active = v.passport_status === 'active';

  const save = async (next: 'active' | 'revoked', done: string) => {
    if (!fields.length) {
      setError('Choose at least one fact to show.');
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      await change(() => vendorApi('/api/vendor/passport', { method: 'POST', body: { status: next, fields } }), done);
      setConfirm(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      id="passport"
      title="Your Verified Vendor Passport"
      description="A page with your verified facts that you can share with any customer, so they do not have to check you again."
      actions={<Stamp tone={status.tone}>{status.label}</Stamp>}
    >
      <div className="flex flex-col gap-5">
        {v.passport_status === 'suspended' ? (
          <Callout tone="refused" title="TshepoVet suspended your passport">
            <p>Anyone opening it is told it was withdrawn. Contact TshepoVet support to have it reviewed.</p>
          </Callout>
        ) : null}
        {active ? (
          <p>
            <Link href={`/passport/${v.passport_public_id}`} className="inline-flex min-h-11 items-center font-semibold">
              Open your passport
            </Link>
            <span className="text-ink-2">
              {' '}
              (verified {v.passport_last_verified_at ? formatDay(v.passport_last_verified_at) : 'not yet'})
            </span>
          </p>
        ) : null}
        {!v.passport_last_verified_at ? (
          <Callout tone="info" title="Your company has not been verified yet" announce={false}>
            <p>A passport can be published once a customer’s check has verified your company.</p>
          </Callout>
        ) : null}
        {error ? <Callout tone="refused" title={error} /> : null}
        <fieldset className="flex flex-col">
          <legend className="mb-1 font-semibold">What it shows</legend>
          <p className="mb-2 text-sm text-ink-2">Directors are shown by their initials only. ID numbers, bank details and documents are never shown.</p>
          <div className="grid sm:grid-cols-2">
            {PASSPORT_FIELDS.map((f) => (
              <Checkbox
                key={f}
                label={PASSPORT_FIELD_LABELS[f]}
                checked={fields.includes(f)}
                disabled={v.passport_status === 'suspended'}
                onCheckedChange={(on) => setFields((cur) => (on ? [...cur, f] : cur.filter((x) => x !== f)))}
              />
            ))}
          </div>
        </fieldset>
        {v.passport_status !== 'suspended' && v.passport_last_verified_at ? (
          <div className="flex flex-wrap gap-3">
            {active ? (
              <>
                <Button loading={busy && !confirm} onClick={() => save('active', 'Passport updated')}>
                  Save what it shows
                </Button>
                <ConfirmDialog
                  open={confirm}
                  onOpenChange={setConfirm}
                  trigger={<Button intent="secondary">Withdraw the passport</Button>}
                  title="Withdraw your passport?"
                  consequence="Anyone opening the link, or checking the code on a printed copy, is told it was withdrawn. You can publish it again at any time."
                  confirmLabel="Withdraw the passport"
                  destructive
                  busy={busy}
                  onConfirm={() => save('revoked', 'Passport withdrawn')}
                />
              </>
            ) : (
              <Button loading={busy} onClick={() => save('active', 'Passport published')}>
                Publish the passport
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

const RELATIONSHIP: Record<string, string> = {
  invited: 'Invited you',
  onboarding: 'Onboarding you',
  pending_review: 'Reviewing your details',
  approved: 'Approved you',
  rejected: 'Did not approve you',
  suspended: 'Suspended work with you',
  offboarded: 'No longer works with you',
};

function Customers({ d }: { d: VendorPortal }) {
  const columns: Column<VendorPortal['buyers'][number]>[] = [
    { key: 'buyer', header: 'Customer', rowHeader: true, cell: (b) => <span className="font-semibold">{b.buyer}</span> },
    { key: 'status', header: 'Where it stands', cell: (b) => RELATIONSHIP[b.status] ?? humanise(b.status) },
    { key: 'monitored', header: 'Monitoring you', cell: (b) => (b.monitored ? 'Yes' : 'No') },
    { key: 'since', header: 'Since', cell: (b) => <When value={b.since} day /> },
  ];
  return (
    <Sheet title="Customers who hold your details" description="Each of them is responsible for what it does with your information." flush>
      <DataTable caption="Customers who hold your details" captionHidden columns={columns} rows={d.buyers} rowKey={(b) => b.relationship_id} empty="No customer holds your details." />
    </Sheet>
  );
}

function Consents({ d }: { d: VendorPortal }) {
  const [target, setTarget] = useState<{ consent: string; purpose: string; buyer: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const change = useVendorChange();
  const withdraw = async () => {
    if (!target) return;
    setBusy(true);
    setError(undefined);
    try {
      await change(() => vendorApi(`/api/vendor/consents/${target.consent}/withdraw`, { method: 'POST', body: { purposes: [target.purpose] } }), 'Consent withdrawn');
      setTarget(null);
    } catch (e) {
      setError(message(e));
      setTarget(null);
    } finally {
      setBusy(false);
    }
  };
  const consequence = (purpose: string, buyer: string) =>
    purpose === 'continuous_monitoring'
      ? `${buyer} stops monitoring you, and is no longer told when a document or your tax compliance lapses.`
      : purpose === 'passport_sharing'
        ? 'Your passport is no longer shared on your behalf with this customer. Withdraw the passport itself above if you want it offline.'
        : `${buyer} may no longer use your information for this. What was already done under your consent stays lawful.`;
  return (
    <Sheet title="Consents you gave" description="Withdrawing consent stops future use for that purpose. It does not undo what was already done.">
      <div className="flex flex-col gap-6">
        {error ? <Callout tone="refused" title={error} /> : null}
        {!d.consents.length ? <EmptyState title="No consents on record" /> : null}
        {d.consents.map((c) => (
          <section key={c.id} aria-label={`Consent to ${c.buyer ?? 'TshepoVet'}`} className="flex flex-col gap-2">
            <h3 className="font-bold">
              To {c.buyer ?? 'TshepoVet'}
              <span className="font-normal text-ink-2">
                , <When value={c.granted_at} day /> ({humanise(c.capture_method)})
              </span>
            </h3>
            <ul className="flex flex-col divide-y divide-rule border-y border-rule">
              {c.purposes.map((p) => (
                <li key={p.purpose} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <span>{PURPOSE_LABELS[p.purpose] ?? humanise(p.purpose)}</span>
                  {p.withdrawn_at ? (
                    <Stamp tone="neutral">
                      Withdrawn <When value={p.withdrawn_at} day />
                    </Stamp>
                  ) : (
                    <Button intent="secondary" size="sm" onClick={() => setTarget({ consent: c.id, purpose: p.purpose, buyer: c.buyer })}>
                      Withdraw<span className="sr-only"> consent to {PURPOSE_LABELS[p.purpose] ?? humanise(p.purpose)} for {c.buyer ?? 'TshepoVet'}</span>
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
        <ConfirmDialog
          open={target !== null}
          onOpenChange={(o) => !o && setTarget(null)}
          title={target ? `Withdraw consent to ${(PURPOSE_LABELS[target.purpose] ?? humanise(target.purpose)).toLowerCase()}?` : ''}
          consequence={target ? consequence(target.purpose, target.buyer ?? 'TshepoVet') : ''}
          confirmLabel="Withdraw consent"
          destructive
          busy={busy}
          onConfirm={withdraw}
        />
      </div>
    </Sheet>
  );
}

const REQUEST_TYPES = [
  { value: 'access', label: 'Show me what you hold', hint: 'A copy of the information the customer holds about your company and its people.' },
  { value: 'correction', label: 'Correct something', hint: 'Say what is wrong and what it should be.' },
  { value: 'deletion', label: 'Delete my information', hint: 'Where the customer no longer needs it, or has no lawful reason to keep it.' },
  { value: 'objection', label: 'Stop using my information', hint: 'Object to a use you did not agree to.' },
] as const;

function Requests({ d }: { d: VendorPortal }) {
  const [open, setOpen] = useState(false);
  const [buyer, setBuyer] = useState(d.buyers[0]?.relationship_id ?? '');
  const [type, setType] = useState('access');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const change = useVendorChange();
  const submit = async () => {
    const e: Record<string, string> = {};
    if (!buyer) e['rq-buyer'] = 'Choose the customer.';
    if (type === 'correction' && !notes.trim()) e['rq-notes'] = 'Say what is wrong and what it should be.';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await change(() => vendorApi('/api/vendor/requests', { method: 'POST', body: { relationship_id: buyer, request_type: type, ...(notes.trim() ? { notes: notes.trim() } : {}) } }), 'Request sent');
      setOpen(false);
      setNotes('');
    } catch (err) {
      setErrors({ form: message(err) });
    } finally {
      setBusy(false);
    }
  };
  const label = (t: string) => REQUEST_TYPES.find((r) => r.value === t)?.label ?? humanise(t);
  const columns: Column<VendorPortal['requests'][number]>[] = [
    { key: 'type', header: 'Request', rowHeader: true, cell: (r) => <span className="font-semibold">{label(r.request_type)}</span> },
    { key: 'buyer', header: 'To', cell: (r) => r.buyer },
    { key: 'status', header: 'Status', cell: (r) => humanise(r.status) },
    { key: 'received', header: 'Sent', cell: (r) => <When value={r.received_at} day /> },
    { key: 'due', header: 'Answer due', cell: (r) => formatDay(r.due_at) },
  ];
  return (
    <Sheet
      title="Your requests to customers"
      description={
        <>
          Under <Term term="POPIA" />, a customer must answer within 30 days.
        </>
      }
      actions={
        d.buyers.length ? (
          <Dialog
            open={open}
            onOpenChange={setOpen}
            title="Send a request to a customer"
            description="The customer is told at once, and the 30 days start today."
            trigger={<Button>Send a request</Button>}
            footer={
              <>
                <DialogClose asChild>
                  <Button intent="secondary">Cancel</Button>
                </DialogClose>
                <Button loading={busy} onClick={submit}>
                  Send the request
                </Button>
              </>
            }
          >
            <div className="flex flex-col gap-5">
              {errors.form ? <Callout tone="refused" title={errors.form} /> : null}
              <ErrorSummary errors={Object.entries(errors).filter(([k]) => k !== 'form').map(([field, m]) => ({ field, message: m }))} />
              <Field id="rq-buyer" label="Customer" error={errors['rq-buyer']}>
                {(p) => <Select {...p} value={buyer} onValueChange={setBuyer} options={d.buyers.map((b) => ({ value: b.relationship_id, label: b.buyer }))} />}
              </Field>
              <RadioGroup legend="What you are asking" value={type} onValueChange={setType} options={REQUEST_TYPES.map((r) => ({ value: r.value, label: r.label, hint: r.hint }))} />
              <Field id="rq-notes" label="Details" optional={type !== 'correction'} error={errors['rq-notes']}>
                {(p) => <Textarea {...p} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={4} />}
              </Field>
            </div>
          </Dialog>
        ) : null
      }
      flush
    >
      <DataTable caption="Your requests to customers" captionHidden columns={columns} rows={d.requests} rowKey={(r) => r.id} empty="You have not sent a request." />
    </Sheet>
  );
}

function Company({ d }: { d: VendorPortal }) {
  const v = d.vendor;
  return (
    <Sheet title="Your company" description="As verified from the CIPC register. If something is wrong, send a correction request to a customer.">
      <RecordList
        columns={1}
        items={[
          { label: 'Registered name', value: v.legal_name },
          { label: 'Trading name', value: v.trading_name },
          { label: 'Registration number', value: v.registration_number ? <span className="font-mono">{v.registration_number}</span> : null },
          { label: 'Type of entity', value: humanise(v.entity_kind) },
          { label: <>Status on the <Term term="CIPC" /> register</>, value: v.cipc_status ? humanise(v.cipc_status) : null },
          { label: <><Term term="VAT" /> number</>, value: v.vat_number ? <span className="font-mono">{v.vat_number}</span> : null },
        ]}
      />
    </Sheet>
  );
}

function Documents({ d }: { d: VendorPortal }) {
  return (
    <Sheet title="Documents on your record" description="What was read from them is kept; the images are deleted within 30 to 90 days.">
      {d.documents.length ? (
        <ul className="flex flex-col divide-y divide-rule">
          {d.documents.map((doc) => (
            <li key={doc.id} className="flex flex-col gap-0.5 py-3">
              <span className="font-semibold">{doc.name}</span>
              <span className="text-sm text-ink-2">
                {humanise(doc.review_status)}, added <When value={doc.created_at} day />
                {doc.expires_on ? `, valid until ${formatDay(doc.expires_on)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No documents on your shared record" />
      )}
    </Sheet>
  );
}
