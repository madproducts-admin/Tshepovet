'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { OnboardingState } from '@tshepovet/contracts';
import { Seal } from '@/components/brand/seal';
import { Button } from '@/components/ui/button';
import { Term } from '@/components/ui/data';
import { Callout, Spinner, Stamp } from '@/components/ui/feedback';
import { Checkbox, ErrorSummary, Field, Input, RadioGroup, Select } from '@/components/ui/form';
import { RecordList, Sheet, Steps } from '@/components/ui/layout';

/**
 * Supplier onboarding from a customer's invitation. One page that follows the API's state: the
 * notice, the company as the register knows it, an identity document, the optional B-BBEE,
 * bank and tax steps, and a review before submitting. The invitation token comes in the link's
 * fragment and is kept for this browser tab only (sessionStorage), so a reload keeps the place.
 */
const KEY = 'tv_onboarding_token';
const STEPS = ['Agree', 'Company', 'Identity', 'B-BBEE', 'Bank', 'Tax', 'Review'];

function useOnboardingToken(): string | null | undefined {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const read = (initial: boolean) => {
      const m = /(?:^|[#&])token=([A-Za-z0-9_-]{43})/.exec(window.location.hash);
      // A newer link pasted into this tab only changes the fragment: take it without a reload.
      if (!initial && !m) return;
      let t: string | null = m?.[1] ?? null;
      try {
        if (t) sessionStorage.setItem(KEY, t);
        else t = sessionStorage.getItem(KEY);
      } catch {
        // storage blocked: the token lives in memory for this page only
      }
      if (m) history.replaceState(null, '', window.location.pathname);
      setToken(t);
    };
    read(true);
    const onHash = () => read(false);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return token;
}

const BANKS = ['ABSA', 'Capitec', 'Discovery Bank', 'FNB', 'Investec', 'Nedbank', 'Standard Bank', 'TymeBank', 'African Bank', 'Another bank'];

export function Onboarding() {
  const token = useOnboardingToken();
  const [state, setState] = useState<OnboardingState | null>(null);
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const call = useCallback(
    async (path: string, body?: unknown) => {
      if (!token) return;
      setBusy(true);
      setProblem(null);
      try {
        const headers: Record<string, string> = { 'x-onboarding-token': token, accept: 'application/json' };
        let init: RequestInit = { headers, credentials: 'same-origin', cache: 'no-store' };
        if (body !== undefined) {
          const csrf = (await (await fetch('/api/auth/csrf', { credentials: 'same-origin' })).json()).csrf_token as string;
          init = { ...init, method: 'POST', headers: { ...headers, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify(body) };
        }
        const res = await fetch(`/api/onboarding${path}`, init);
        const data = await res.json();
        if (res.status === 404) setGone(true);
        else if (!res.ok) setProblem((data as { title?: string }).title ?? 'That did not work. Try again.');
        else setState(data as OnboardingState);
      } catch {
        setProblem('TshepoVet could not be reached. Check your connection and try again.');
      } finally {
        setBusy(false);
      }
    },
    [token],
  );

  useEffect(() => {
    if (token) void call('');
    else if (token === null) setGone(true);
  }, [token, call]);

  if (gone) {
    return (
      <Sheet title="This link has expired or was withdrawn">
        <p>Ask the customer who invited you to send a new one. Links work for 14 days, and only the newest one works.</p>
      </Sheet>
    );
  }
  if (!state) return <Spinner label="Opening your invitation" />;

  const s = state;
  // The company step is done once confirmed, or when the register could not answer (the
  // customer follows that up); "found" waits for the supplier's answer, "disputed" stops here.
  const companyDone = ['confirmed', 'not_found', 'unavailable'].includes(s.company.state);
  const current = !s.consent_given
    ? 0
    : !companyDone
      ? 1
      : !['accepted', 'review'].includes(s.identity.state)
        ? 2
        : !['accepted', 'review', 'skipped'].includes(s.bbbee.state)
          ? 3
          : s.bank.state === 'todo'
            ? 4
            : s.tax.state === 'todo'
              ? 5
              : 6;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-bold">Supplier onboarding for {s.buyer}</h1>
        <p className="text-lg text-ink-2">
          {s.supplier.legal_name}
          {s.supplier.registration_number ? <span className="font-mono"> ({s.supplier.registration_number})</span> : null}
        </p>
        {!s.submitted_at ? <Steps steps={STEPS} current={current} /> : null}
      </header>
      {problem ? <Callout tone="refused" title={problem} /> : null}
      <div aria-live="polite">
        {s.submitted_at ? (
          <Done s={s} />
        ) : current === 0 ? (
          <AgreeStep s={s} busy={busy} onStart={(b) => call('/start', b)} />
        ) : current === 1 ? (
          <CompanyStep s={s} busy={busy} onAnswer={(correct) => call('/company', { correct })} />
        ) : current === 2 ? (
          <DocumentStep kind="identity" s={s} busy={busy} onAdd={(sample) => call('/documents', { kind: 'identity', sample })} />
        ) : current === 3 ? (
          <DocumentStep kind="bbbee" s={s} busy={busy} onAdd={(sample) => call('/documents', { kind: 'bbbee', sample })} onSkip={() => call('/skip', { step: 'bbbee' })} />
        ) : current === 4 ? (
          <BankStep busy={busy} onAdd={(b) => call('/bank', b)} onSkip={() => call('/skip', { step: 'bank' })} />
        ) : current === 5 ? (
          <TaxStep busy={busy} onAdd={(b) => call('/tax', b)} onSkip={() => call('/skip', { step: 'tax' })} />
        ) : (
          <ReviewStep s={s} busy={busy} onSubmit={(publish) => call('/submit', { publish_passport: publish })} />
        )}
      </div>
    </div>
  );
}

function AgreeStep({ s, busy, onStart }: { s: OnboardingState; busy: boolean; onStart: (b: unknown) => void }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [agree, setAgree] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  return (
    <Sheet title="Before you start">
      <div className="flex flex-col gap-5">
        <p>
          {s.buyer} uses TshepoVet to check its suppliers. Here is what happens to the information you give, so you can decide whether to continue.
        </p>
        <div className="rounded-control border border-rule bg-sheet-2 p-4">
          <p>
            We check your company’s details with the <Term term="CIPC" /> register, <Term term="SARS" /> and licensed data bureaus in South Africa. We ask for an
            identity document of the person completing this, and where {s.buyer} needs them, <Term term="B-BBEE" /> evidence, bank details and a tax compliance PIN.
          </p>
          <p className="mt-2">
            Photos of documents are read by software and deleted within 30 to 90 days. What is read from them is kept while you supply {s.buyer}, plus five
            years. You may ask to see or correct your information, object to its use, or complain to the Information Regulator.{' '}
            <Link href="/legal/privacy">The full privacy notice</Link>
          </p>
        </div>
        {s.sandbox ? (
          <Callout tone="info" title="This is the sandbox" announce={false}>
            <p>Do not enter real people’s details here. Where we ask for a document, you choose a sample instead.</p>
          </Callout>
        ) : null}
        <ErrorSummary errors={Object.entries(errors).map(([field, message]) => ({ field, message }))} />
        <Field id="ob-name" label="Your full name" error={errors['ob-name']}>
          {(p) => <Input {...p} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field id="ob-role" label="Your role at the company" optional hint="For example: director, or financial manager.">
          {(p) => <Input {...p} autoComplete="organization-title" value={role} onChange={(e) => setRole(e.target.value)} />}
        </Field>
        <p className="text-ink-2">You will sign in later with {s.invited_email}, the address this link was sent to.</p>
        <div id="ob-agree">
          <Checkbox label={`I agree, on behalf of ${s.supplier.legal_name}, to the checks described above`} checked={agree} onCheckedChange={setAgree} invalid={Boolean(errors['ob-agree'])} />
        </div>
        <div>
          <Button
            loading={busy}
            onClick={() => {
              const e: Record<string, string> = {};
              if (!name.trim()) e['ob-name'] = 'Enter your full name.';
              if (!agree) e['ob-agree'] = 'Agree to the checks to continue, or close this page.';
              setErrors(e);
              if (!Object.keys(e).length) onStart({ agree: true, full_name: name, ...(role ? { role } : {}) });
            }}
          >
            Agree and continue
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

function CompanyStep({ s, busy, onAnswer }: { s: OnboardingState; busy: boolean; onAnswer: (correct: boolean) => void }) {
  if (s.company.state === 'disputed') {
    return (
      <Callout tone="caution" title="We told your customer that these details are not right">
        <p>{s.buyer} will contact you. You can close this page; the link works until it expires.</p>
      </Callout>
    );
  }
  return (
    <Sheet title="Is this your company?" description="As the CIPC register has it today.">
      <RecordList
        columns={1}
        items={[
          { label: 'Registered name', value: s.company.legal_name },
          { label: 'Status', value: s.company.cipc_status ? s.company.cipc_status.replace(/_/g, ' ') : null },
          { label: 'Directors', value: s.company.directors.length ? s.company.directors.join(', ') : null },
        ]}
      />
      <div className="mt-6 flex flex-wrap gap-3">
        <Button loading={busy} onClick={() => onAnswer(true)}>
          Yes, this is my company
        </Button>
        <Button intent="secondary" disabled={busy} onClick={() => onAnswer(false)}>
          No, something is wrong
        </Button>
      </div>
    </Sheet>
  );
}

function DocumentStep({ kind, s, busy, onAdd, onSkip }: { kind: 'identity' | 'bbbee'; s: OnboardingState; busy: boolean; onAdd: (sample: string) => void; onSkip?: () => void }) {
  const samples = s.samples.filter((x) => x.kind === kind);
  const [choice, setChoice] = useState(samples[0]?.id ?? '');
  const last = kind === 'identity' ? s.identity.state : s.bbbee.state;
  const title = kind === 'identity' ? 'Your identity document' : 'B-BBEE evidence';
  return (
    <Sheet
      title={title}
      description={
        kind === 'identity'
          ? 'A South African ID card or ID book of the person completing this. We check it against the directors on the register.'
          : 'An EME or QSE sworn affidavit, or a B-BBEE certificate. Your customer counts your level towards its own scorecard.'
      }
    >
      <div className="flex flex-col gap-5">
        {last === 'retake' ? <Callout tone="caution" title="We could not read that clearly">Take the photo again in good light, flat on a table.</Callout> : null}
        {last === 'wrong_document' ? <Callout tone="caution" title="That is not the document we asked for" /> : null}
        {kind === 'bbbee' && last === 'refused' ? (
          <Callout tone="refused" title="That evidence was not accepted">
            <ul className="list-disc pl-5">
              {s.bbbee.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </Callout>
        ) : null}
        {s.sandbox ? (
          <RadioGroup
            legend="Sandbox: choose a sample document"
            hint="The sandbox never takes real documents. Each sample shows how TshepoVet responds."
            value={choice}
            onValueChange={setChoice}
            options={samples.map((x) => ({ value: x.id, label: x.label, hint: x.outcome }))}
          />
        ) : (
          <Callout tone="info" title="Uploads open when TshepoVet goes live" announce={false} />
        )}
        <div className="flex flex-wrap gap-3">
          <Button loading={busy} disabled={!choice} onClick={() => onAdd(choice)}>
            Add the document
          </Button>
          {onSkip ? (
            <Button intent="secondary" disabled={busy} onClick={onSkip}>
              My customer does not need this
            </Button>
          ) : null}
        </div>
      </div>
    </Sheet>
  );
}

function BankStep({ busy, onAdd, onSkip }: { busy: boolean; onAdd: (b: unknown) => void; onSkip: () => void }) {
  const [v, setV] = useState({ bank_name: '', account_number: '', account_type: 'current' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  return (
    <Sheet title="Bank details" description="Where your customer pays you. Stored encrypted; only the last four digits are ever shown.">
      <div className="flex flex-col gap-5">
        <ErrorSummary errors={Object.entries(errors).map(([field, message]) => ({ field, message }))} />
        <Field id="ob-bank" label="Bank" error={errors['ob-bank']}>
          {(p) => <Select {...p} value={v.bank_name} onValueChange={(x) => setV((s) => ({ ...s, bank_name: x }))} options={BANKS.map((b) => ({ value: b, label: b }))} />}
        </Field>
        <Field id="ob-account" label="Account number" error={errors['ob-account']}>
          {(p) => <Input {...p} mono inputMode="numeric" autoComplete="off" value={v.account_number} onChange={(e) => setV((s) => ({ ...s, account_number: e.target.value.replace(/\s/g, '') }))} />}
        </Field>
        <RadioGroup
          legend="Account type"
          value={v.account_type}
          onValueChange={(x) => setV((s) => ({ ...s, account_type: x }))}
          options={[
            { value: 'current', label: 'Current or cheque' },
            { value: 'savings', label: 'Savings' },
            { value: 'transmission', label: 'Transmission' },
          ]}
        />
        <div className="flex flex-wrap gap-3">
          <Button
            loading={busy}
            onClick={() => {
              const e: Record<string, string> = {};
              if (!v.bank_name) e['ob-bank'] = 'Choose your bank.';
              if (!/^\d{6,16}$/.test(v.account_number)) e['ob-account'] = 'Account numbers are 6 to 16 digits.';
              setErrors(e);
              if (!Object.keys(e).length) onAdd(v);
            }}
          >
            Add bank details
          </Button>
          <Button intent="secondary" disabled={busy} onClick={onSkip}>
            Skip for now
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

function TaxStep({ busy, onAdd, onSkip }: { busy: boolean; onAdd: (b: unknown) => void; onSkip: () => void }) {
  const [v, setV] = useState({ tax_reference_number: '', tcs_pin: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  return (
    <Sheet
      title="Tax compliance"
      description={
        <>
          Create a <Term term="TCS" /> PIN on SARS eFiling (Tax Compliance Status, then Request a PIN) and enter it here. We check it with SARS once, now.
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <ErrorSummary errors={Object.entries(errors).map(([field, message]) => ({ field, message }))} />
        <Field id="ob-taxref" label="Income tax reference number" error={errors['ob-taxref']}>
          {(p) => <Input {...p} mono inputMode="numeric" autoComplete="off" value={v.tax_reference_number} onChange={(e) => setV((s) => ({ ...s, tax_reference_number: e.target.value }))} />}
        </Field>
        <Field id="ob-pin" label="Tax compliance status PIN" hint="It is not your tax number. It looks like AB12CD34EF." error={errors['ob-pin']}>
          {(p) => <Input {...p} mono autoComplete="off" spellCheck={false} value={v.tcs_pin} onChange={(e) => setV((s) => ({ ...s, tcs_pin: e.target.value }))} />}
        </Field>
        <div className="flex flex-wrap gap-3">
          <Button
            loading={busy}
            onClick={() => {
              const e: Record<string, string> = {};
              if (!/^[0-39]\d{9}$/.test(v.tax_reference_number.replace(/\s/g, ''))) e['ob-taxref'] = 'Enter the 10-digit income tax reference number.';
              if (v.tcs_pin.trim().length < 6) e['ob-pin'] = 'Enter the PIN from SARS eFiling.';
              setErrors(e);
              if (!Object.keys(e).length) onAdd({ tax_reference_number: v.tax_reference_number.replace(/\s/g, ''), tcs_pin: v.tcs_pin.trim() });
            }}
          >
            Check with SARS
          </Button>
          <Button intent="secondary" disabled={busy} onClick={onSkip}>
            Skip for now
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

const STATE_LABEL: Record<string, { tone: 'verified' | 'caution' | 'refused' | 'neutral'; label: string }> = {
  confirmed: { tone: 'verified', label: 'Confirmed' },
  not_found: { tone: 'caution', label: 'Not found on the register' },
  unavailable: { tone: 'neutral', label: 'Checked later by your customer' },
  accepted: { tone: 'verified', label: 'Accepted' },
  review: { tone: 'caution', label: 'Your customer will review it' },
  refused: { tone: 'refused', label: 'Not accepted' },
  skipped: { tone: 'neutral', label: 'Skipped' },
  added: { tone: 'verified', label: 'Added' },
  compliant: { tone: 'verified', label: 'Tax compliant' },
  non_compliant: { tone: 'refused', label: 'Not tax compliant' },
  problem: { tone: 'caution', label: 'Could not be checked' },
};

function StateStamp({ state }: { state: string }) {
  const x = STATE_LABEL[state] ?? { tone: 'neutral' as const, label: state };
  return <Stamp tone={x.tone}>{x.label}</Stamp>;
}

function ReviewStep({ s, busy, onSubmit }: { s: OnboardingState; busy: boolean; onSubmit: (publish: boolean) => void }) {
  // Only a director (ID matched to the register) speaks for the company beyond this customer.
  const director = s.identity.is_director === true;
  const [publish, setPublish] = useState(director);
  return (
    <Sheet title="Check and submit" description={`${s.buyer} reviews this next. You cannot change it after submitting; ask ${s.buyer} if something is wrong.`}>
      <ul className="flex flex-col divide-y divide-rule">
        {[
          ['Company', s.company.state],
          ['Identity document', s.identity.state],
          ['B-BBEE', s.bbbee.state],
          ['Bank details', s.bank.state],
          ['Tax compliance', s.tax.state],
        ].map(([label, state]) => (
          <li key={label} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <span className="font-semibold">{label}</span>
            <StateStamp state={state!} />
          </li>
        ))}
      </ul>
      {s.tax.detail ? <Callout tone="caution" title={s.tax.detail} className="mt-4" announce={false} /> : null}
      {director ? (
        <div className="mt-5 rounded-control border border-rule bg-sheet-2 p-4">
          <Checkbox
            label="Publish a Verified Vendor Passport"
            hint="A page with your verified facts that you can share with any customer, so they do not have to check you again. You choose what it shows and can withdraw it at any time."
            checked={publish}
            onCheckedChange={setPublish}
          />
        </div>
      ) : (
        <Callout tone="info" title={`What you entered goes to ${s.buyer} only`} className="mt-5" announce={false}>
          <p>
            Your ID did not match a current director on the register, so {s.buyer} reviews it. A Verified Vendor Passport can be published by a director of{' '}
            {s.supplier.legal_name}.
          </p>
        </Callout>
      )}
      <div className="mt-6">
        <Button loading={busy} onClick={() => onSubmit(publish)}>
          Submit to {s.buyer}
        </Button>
      </div>
    </Sheet>
  );
}

function Done({ s }: { s: OnboardingState }) {
  return (
    <Sheet title="Submitted">
      <div className="flex flex-wrap items-center gap-6">
        <Seal size={96} verified label="Submitted" />
        <div className="min-w-0 flex-1">
          <p className="text-lg">{s.buyer} has your details and will review them.</p>
          {s.identity.is_director ? (
            <p className="mt-2 text-ink-2">
              To see your information, manage your passport or withdraw consent later, <Link href="/supplier/sign-in">sign in as a supplier</Link> with{' '}
              {s.invited_email}.
            </p>
          ) : (
            <p className="mt-2 text-ink-2">
              To see or correct what you gave, or to withdraw consent, contact {s.buyer}. Signing in as a supplier is for directors whose identity matched the register.
            </p>
          )}
        </div>
      </div>
    </Sheet>
  );
}
