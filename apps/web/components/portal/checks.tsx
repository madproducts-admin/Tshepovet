'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { LICENCE_CODES, PRDP_CATEGORIES, type CheckPageSchema, type CheckPricesSchema, type PortalVerification } from '@tshepovet/contracts';
import { Button } from '@/components/ui/button';
import { type Column, DataTable, Money, Pagination, Term, When } from '@/components/ui/data';
import { Callout, OutcomeStamp, Stamp } from '@/components/ui/feedback';
import { Checkbox, ErrorSummary, Field, Input, RadioGroup, SearchField, Select } from '@/components/ui/form';
import { PageHeader, RecordList, Sheet } from '@/components/ui/layout';
import { api, ApiProblem } from '@/lib/api';
import { explainFlag, explainWarning } from '@/lib/explain';
import { formatDay, formatMoney } from '@/lib/format';
import { check, type Errors, fromProblem, rules, summary } from '@/lib/forms';
import { useApi, useSession, useVatRegistered } from '@/lib/queries';
import { CHECK_LABELS, FilterBar, humanise, Loaded, useListParams } from './common';

type CheckPage = z.infer<typeof CheckPageSchema>;
type Prices = z.infer<typeof CheckPricesSchema>;
type Item = CheckPage['items'][number];

// --- History ----------------------------------------------------------------------------------
const DEFAULTS = { q: '', type: 'all', outcome: 'all', sort: 'requested_at', order: 'desc', page: '1' };

export function ChecksPage() {
  const { can } = useSession();
  const { values, set } = useListParams(DEFAULTS);
  const [search, setSearch] = useState(values.q);
  useEffect(() => {
    const t = setTimeout(() => search !== values.q && set({ q: search }), 350);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = useApi<CheckPage>('/api/checks', {
    q: values.q || undefined,
    type: values.type === 'all' ? undefined : values.type,
    outcome: values.outcome === 'all' ? undefined : values.outcome,
    sort: values.sort,
    order: values.order,
    page: Number(values.page),
    page_size: 25,
  });
  const columns: Column<Item>[] = [
    {
      key: 'subject',
      header: 'Checked',
      rowHeader: true,
      cell: (c) => (
        <div className="flex min-w-52 flex-col">
          <Link href={`/app/checks/${c.id}`} className="font-semibold">
            {c.supplier_name ?? c.subject}
          </Link>
          <span className="text-sm text-ink-2">
            {c.type === 'company' ? 'Company check' : 'Driver check'}
            {c.supplier_name ? <>, <span className="font-mono">{c.subject}</span></> : null}
          </span>
        </div>
      ),
    },
    { key: 'outcome', header: 'Result', sortable: true, cell: (c) => <OutcomeStamp outcome={c.outcome} status={c.status} /> },
    { key: 'requested_at', header: 'When', sortable: true, cell: (c) => <When value={c.requested_at} /> },
    { key: 'requested_by', header: 'By', cell: (c) => c.requested_by.name ?? humanise(c.requested_by.type) },
    { key: 'price_cents', header: 'Cost', sortable: true, align: 'end', cell: (c) => (c.charged ? <Money cents={c.price_cents} /> : <span className="text-ink-2">Not charged</span>) },
  ];
  return (
    <>
      <PageHeader
        title="Checks"
        description="Every company and driver check your organisation has run, through the portal or the API."
        actions={
          can('checks:run') ? (
            <Button asChild>
              <Link href="/app/checks/new">Run a check</Link>
            </Button>
          ) : null
        }
      />
      <Sheet flush>
        <FilterBar>
          <SearchField label="Search" placeholder="Supplier name, registration number or reference" value={search} onChange={(e) => setSearch(e.target.value)} className="min-w-64 flex-1" />
          <Field label="Type" className="w-44">
            {(p) => (
              <Select
                {...p}
                value={values.type}
                onValueChange={(v) => set({ type: v })}
                options={[
                  { value: 'all', label: 'All checks' },
                  { value: 'company', label: 'Company' },
                  { value: 'driver_licence', label: 'Driver' },
                ]}
              />
            )}
          </Field>
          <Field label="Result" className="w-56">
            {(p) => (
              <Select
                {...p}
                value={values.outcome}
                onValueChange={(v) => set({ outcome: v })}
                options={[
                  { value: 'all', label: 'Any result' },
                  { value: 'verified', label: 'Verified' },
                  { value: 'verified_with_warnings', label: 'Verified, with warnings' },
                  { value: 'failed_checks', label: 'Failed checks' },
                  { value: 'not_found', label: 'Not found' },
                  { value: 'unable_to_verify', label: 'Could not verify' },
                ]}
              />
            )}
          </Field>
        </FilterBar>
        <div className="border-t border-rule">
          <Loaded q={q} label="Checks">
            {(page) => (
              <>
                <DataTable
                  caption="Checks"
                  captionHidden
                  columns={columns}
                  rows={page.items}
                  rowKey={(c) => c.id}
                  sort={{ sort: values.sort, order: values.order as 'asc' | 'desc' }}
                  onSort={(s) => set({ sort: s.sort, order: s.order })}
                  empty="No checks match. Run one: the result appears here."
                />
                <div className="border-t border-rule">
                  <Pagination page={page.page} pageSize={page.page_size} total={page.total} noun={['check', 'checks']} onPage={(p) => set({ page: p }, false)} />
                </div>
              </>
            )}
          </Loaded>
        </div>
      </Sheet>
    </>
  );
}

// --- Run a check ----------------------------------------------------------------------------------
type CK = 'registration_number' | 'vat_number' | 'tax_reference_number' | 'tcs_pin' | 'consent' | 'evidence';
type DK = 'id_number' | 'licence_number' | 'consent' | 'evidence';
const CIDS: Record<CK, string> = { registration_number: 'rc-reg', vat_number: 'rc-vat', tax_reference_number: 'rc-taxref', tcs_pin: 'rc-pin', consent: 'rc-consent', evidence: 'rc-evidence' };
const DIDS: Record<DK, string> = { id_number: 'rd-id', licence_number: 'rd-licence', consent: 'rd-consent', evidence: 'rd-evidence' };

export function RunCheck() {
  const params = useSearchParams();
  const router = useRouter();
  const prices = useApi<Prices>('/api/checks/prices');
  const [kind, setKind] = useState(params.get('type') === 'driver' ? 'driver' : 'company');
  return (
    <>
      <PageHeader crumbs={[{ label: 'Checks', href: '/app/checks' }, { label: 'Run a check' }]} title="Run a check" />
      <Loaded q={prices} label="Prices">
        {(p) => (
          <div className="grid gap-8 xl:grid-cols-[minmax(0,44rem)_1fr]">
            <div className="flex flex-col gap-6">
              <RadioGroup
                legend="What do you want to check?"
                value={kind}
                onValueChange={setKind}
                options={[
                  { value: 'company', label: 'A company', hint: `Registration, directors, VAT and tax compliance. From ${formatMoney(p.company.price_cents)}.` },
                  { value: 'driver', label: 'A driver', hint: `Driving licence and professional driving permit. ${formatMoney(p.driver.price_cents)}.` },
                ]}
              />
              {kind === 'company' ? (
                <CompanyForm prices={p} initialReg={params.get('registration') ?? ''} onDone={(id) => router.push(`/app/checks/${id}`)} />
              ) : (
                <DriverForm prices={p} onDone={(id) => router.push(`/app/checks/${id}`)} />
              )}
            </div>
            <aside aria-label="Wallet" className="flex flex-col gap-4 xl:sticky xl:top-6 xl:self-start">
              <Sheet title="Your wallet">
                <p className="text-3xl font-bold tabular">
                  <Money cents={p.available_cents} />
                </p>
                <p className="mt-1 text-ink-2">available for checks</p>
                <p className="mt-3 text-sm text-ink-2">You are charged only when TshepoVet gets an answer. If the bureaus cannot be reached, the money is released.</p>
                <Link href="/app/wallet" className="mt-2 inline-flex min-h-11 items-center font-semibold">
                  Top up the wallet
                </Link>
              </Sheet>
              {p.sandbox ? (
                <Callout tone="info" title="Sandbox: test data answers" announce={false}>
                  <p>
                    Any registration number works. Sequence 000404 is “not found”, 000777 is being deregistered. PINs starting NC are non-compliant, EX expired.
                    Licence numbers ending 0410 are expired.
                  </p>
                </Callout>
              ) : null}
            </aside>
          </div>
        )}
      </Loaded>
    </>
  );
}

function ConsentBlock({ ids, agreed, setAgreed, evidence, setEvidence, errors, driver }: {
  ids: { consent: string; evidence: string };
  agreed: boolean;
  setAgreed: (v: boolean) => void;
  evidence: string;
  setEvidence: (v: string) => void;
  errors: { consent?: string; evidence?: string };
  driver?: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-sheet border border-rule bg-sheet p-5">
      <legend className="px-1 font-bold">Consent</legend>
      <p className="text-ink-2">
        {driver
          ? 'The driver must agree before their licence is checked. Keep their signed consent: TshepoVet records where it is.'
          : 'A tax compliance check uses the supplier’s own PIN, and monitoring keeps checking after today: both need the supplier’s agreement.'}{' '}
        <Link href="/legal/privacy">What the supplier is told</Link>
      </p>
      <div id={ids.consent}>
        <Checkbox label={driver ? 'The driver agreed to this check' : 'The supplier agreed to this check'} checked={agreed} onCheckedChange={setAgreed} invalid={Boolean(errors.consent)} />
        {errors.consent ? <p className="pl-9 text-sm font-semibold text-red">{errors.consent}</p> : null}
      </div>
      <Field id={ids.evidence} label="Where the evidence is kept" hint="For example: signed onboarding form SOF-2026-014." error={errors.evidence}>
        {(f) => <Input {...f} value={evidence} onChange={(e) => setEvidence(e.target.value)} maxLength={200} />}
      </Field>
    </fieldset>
  );
}

function PriceLine({ cents, available }: { cents: number; available: number }) {
  const vat = useVatRegistered();
  const short = available < cents;
  return short ? (
    <Callout tone="caution" title="Your wallet does not have enough for this check">
      <p>
        It costs <Money cents={cents} /> and <Money cents={available} /> is available. <Link href="/app/wallet">Top up the wallet</Link>
      </p>
    </Callout>
  ) : (
    <p className="text-ink-2">
      This check costs <strong className="text-ink tabular">{formatMoney(cents)}</strong>
      {vat ? ' (excluding VAT)' : ''} from your wallet.
    </p>
  );
}

function CompanyForm({ prices, initialReg, onDone }: { prices: Prices; initialReg: string; onDone: (id: string) => void }) {
  const [v, setV] = useState({ registration_number: initialReg, vat_number: '', tax_reference_number: '', tcs_pin: '', external_ref: '' });
  const [checks, setChecks] = useState({ directors: true, vat: false, tcs: false });
  const [freshness, setFreshness] = useState('cached_ok');
  const [monitor, setMonitor] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [evidence, setEvidence] = useState('');
  const [errors, setErrors] = useState<Errors<CK>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needsConsent = checks.tcs || monitor || prices.consent_always_required;
  const price = freshness === 'live' ? prices.company_live.price_cents : prices.company.price_cents;
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    const found = check<CK>({
      registration_number: [rules.registration(v.registration_number)],
      vat_number: [checks.vat ? (/^4\d{9}$/.test(v.vat_number.replace(/[\s-]/g, '')) ? undefined : 'Enter the 10-digit VAT number, starting with 4.') : undefined],
      tax_reference_number: [checks.tcs ? (/^[0-39]\d{9}$/.test(v.tax_reference_number.replace(/[\s-]/g, '')) ? undefined : 'Enter the 10-digit income tax reference number.') : undefined],
      tcs_pin: [checks.tcs ? rules.required(v.tcs_pin, 'Enter the tax compliance status PIN the supplier gave you.') : undefined],
      consent: [needsConsent && !agreed ? 'Confirm that the supplier agreed to this check.' : undefined],
      evidence: [needsConsent ? rules.required(evidence, 'Say where the evidence of consent is kept.') : undefined],
    });
    setErrors(found);
    setProblem(null);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      const r = await api<PortalVerification>('/api/checks/company', {
        method: 'POST',
        body: {
          registration_number: v.registration_number,
          checks: ['registration', ...(checks.directors ? ['directors'] : []), ...(checks.vat ? ['vat'] : []), ...(checks.tcs ? ['tcs'] : [])],
          freshness,
          monitor,
          ...(checks.vat ? { vat_number: v.vat_number } : {}),
          ...(checks.tcs ? { tax_reference_number: v.tax_reference_number, tcs_pin: v.tcs_pin } : {}),
          ...(v.external_ref ? { external_ref: v.external_ref } : {}),
          ...(needsConsent ? { consent: { confirmed: true, evidence_reference: evidence } } : {}),
        },
      });
      onDone(r.id);
    } catch (err) {
      const p = fromProblem(err, Object.keys(CIDS) as CK[]);
      setErrors(p.errors);
      setProblem(err instanceof ApiProblem && err.code === 'insufficient_funds' ? 'Your wallet does not have enough for this check. Top it up and try again.' : Object.keys(p.errors).length ? null : p.message);
      setBusy(false);
    }
  }

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-6">
      <ErrorSummary errors={summary(errors, CIDS)} />
      {problem ? <Callout tone="refused" title={problem} /> : null}
      <Field id={CIDS.registration_number} label="Registration number" hint={<>As on the supplier’s <Term term="CIPC" /> certificate, for example 2019/123456/07.</>} error={errors.registration_number}>
        {(f) => <Input {...f} mono autoComplete="off" spellCheck={false} value={v.registration_number} onChange={set('registration_number')} />}
      </Field>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 font-semibold">What to check</legend>
        <Checkbox label="Registration on the CIPC register" hint="Always included." checked onCheckedChange={() => undefined} disabled />
        <Checkbox label="Directors" hint="Who runs the company, and recent changes." checked={checks.directors} onCheckedChange={(x) => setChecks((s) => ({ ...s, directors: x }))} />
        <Checkbox label="VAT registration" hint="Needs the supplier’s VAT number." checked={checks.vat} onCheckedChange={(x) => setChecks((s) => ({ ...s, vat: x }))} />
        <Checkbox label="Tax compliance with SARS" hint="Needs the supplier’s tax reference number and a PIN from eFiling." checked={checks.tcs} onCheckedChange={(x) => setChecks((s) => ({ ...s, tcs: x }))} />
      </fieldset>
      {checks.vat ? (
        <Field id={CIDS.vat_number} label="VAT number" error={errors.vat_number}>
          {(f) => <Input {...f} mono inputMode="numeric" value={v.vat_number} onChange={set('vat_number')} />}
        </Field>
      ) : null}
      {checks.tcs ? (
        <>
          <Field id={CIDS.tax_reference_number} label="Income tax reference number" error={errors.tax_reference_number}>
            {(f) => <Input {...f} mono inputMode="numeric" value={v.tax_reference_number} onChange={set('tax_reference_number')} />}
          </Field>
          <Field id={CIDS.tcs_pin} label={<><Term term="TCS" /> PIN</>} hint="The PIN the supplier created on SARS eFiling. It is not their tax number." error={errors.tcs_pin}>
            {(f) => <Input {...f} mono autoComplete="off" spellCheck={false} value={v.tcs_pin} onChange={set('tcs_pin')} />}
          </Field>
        </>
      ) : null}
      <RadioGroup
        legend="How fresh must the answer be?"
        value={freshness}
        onValueChange={setFreshness}
        options={[
          { value: 'cached_ok', label: 'A recent answer is fine', hint: `Uses a result from the last 24 hours when there is one. ${formatMoney(prices.company.price_cents)}.` },
          { value: 'live', label: 'Ask the bureaus now', hint: `Always a fresh lookup. ${formatMoney(prices.company_live.price_cents)}.` },
        ]}
      />
      <Checkbox label="Keep monitoring this supplier" hint="TshepoVet re-checks before things expire and warns you. R15,00 a month." checked={monitor} onCheckedChange={setMonitor} />
      <Field label="Your reference" optional hint="Your own supplier number, if you have one.">
        {(f) => <Input {...f} value={v.external_ref} onChange={set('external_ref')} maxLength={100} />}
      </Field>
      {needsConsent ? <ConsentBlock ids={CIDS} agreed={agreed} setAgreed={setAgreed} evidence={evidence} setEvidence={setEvidence} errors={errors} /> : null}
      <PriceLine cents={price} available={prices.available_cents} />
      <div>
        <Button type="submit" loading={busy} disabled={prices.available_cents < price}>
          {busy ? 'Checking' : `Run the check for ${formatMoney(price)}`}
        </Button>
      </div>
    </form>
  );
}

function DriverForm({ prices, onDone }: { prices: Prices; onDone: (id: string) => void }) {
  const [v, setV] = useState({ id_number: '', licence_number: '', surname: '', external_ref: '' });
  const [codes, setCodes] = useState<string[]>([]);
  const [prdp, setPrdp] = useState<string[]>([]);
  const [agreed, setAgreed] = useState(false);
  const [evidence, setEvidence] = useState('');
  const [errors, setErrors] = useState<Errors<DK>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  const toggle = (list: string[], setList: (x: string[]) => void, item: string) => (on: boolean) => setList(on ? [...list, item] : list.filter((x) => x !== item));

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    const found = check<DK>({
      id_number: [/^\d{13}$/.test(v.id_number.replace(/\s/g, '')) ? undefined : 'Enter the driver’s 13-digit South African ID number.'],
      licence_number: [v.licence_number && !/^[A-Za-z0-9]{6,20}$/.test(v.licence_number) ? 'Licence numbers are 6 to 20 letters and digits.' : undefined],
      consent: [agreed ? undefined : 'Confirm that the driver agreed to this check.'],
      evidence: [rules.required(evidence, 'Say where the evidence of consent is kept.')],
    });
    setErrors(found);
    setProblem(null);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      const r = await api<PortalVerification>('/api/checks/driver', {
        method: 'POST',
        body: {
          id_number: v.id_number.replace(/\s/g, ''),
          ...(v.licence_number ? { licence_number: v.licence_number } : {}),
          ...(v.surname ? { surname: v.surname } : {}),
          ...(v.external_ref ? { external_ref: v.external_ref } : {}),
          required_codes: codes,
          required_prdp: prdp,
          consent: { confirmed: true, evidence_reference: evidence, on_behalf_of_subject: true },
        },
      });
      onDone(r.id);
    } catch (err) {
      const p = fromProblem(err, Object.keys(DIDS) as DK[]);
      setErrors(p.errors);
      setProblem(Object.keys(p.errors).length ? null : p.message);
      setBusy(false);
    }
  }

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-6">
      <ErrorSummary errors={summary(errors, DIDS)} />
      {problem ? <Callout tone="refused" title={problem} /> : null}
      <Field id={DIDS.id_number} label="Driver’s ID number" error={errors.id_number}>
        {(f) => <Input {...f} mono inputMode="numeric" autoComplete="off" value={v.id_number} onChange={set('id_number')} />}
      </Field>
      <Field id={DIDS.licence_number} label="Licence number" optional hint="On the back of the licence card. With it, TshepoVet can also confirm the card itself." error={errors.licence_number}>
        {(f) => <Input {...f} mono autoComplete="off" value={v.licence_number} onChange={set('licence_number')} />}
      </Field>
      <Field label="Surname" optional>
        {(f) => <Input {...f} autoComplete="off" value={v.surname} onChange={set('surname')} />}
      </Field>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 font-semibold">Licence codes the work needs</legend>
        <p className="mb-1 text-sm text-ink-2">Leave all clear to check only that the licence is valid.</p>
        <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-4">
          {LICENCE_CODES.map((c) => (
            <Checkbox key={c} label={`Code ${c}`} checked={codes.includes(c)} onCheckedChange={toggle(codes, setCodes, c)} />
          ))}
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 font-semibold">
          <Term term="PrDP" /> categories the work needs
        </legend>
        <div className="flex flex-wrap gap-x-6">
          {PRDP_CATEGORIES.map((c) => (
            <Checkbox key={c} label={{ G: 'G: goods', P: 'P: passengers', D: 'D: dangerous goods' }[c]} checked={prdp.includes(c)} onCheckedChange={toggle(prdp, setPrdp, c)} />
          ))}
        </div>
      </fieldset>
      <ConsentBlock ids={DIDS} agreed={agreed} setAgreed={setAgreed} evidence={evidence} setEvidence={setEvidence} errors={errors} driver />
      <PriceLine cents={prices.driver.price_cents} available={prices.available_cents} />
      <div>
        <Button type="submit" loading={busy} disabled={prices.available_cents < prices.driver.price_cents}>
          {busy ? 'Checking' : `Run the check for ${formatMoney(prices.driver.price_cents)}`}
        </Button>
      </div>
    </form>
  );
}

// --- One check -------------------------------------------------------------------------------------
interface CheckRecordView {
  status: string;
  source: string;
  data_as_of: string | null;
  stale: boolean;
  warnings: string[];
  error_code: string | null;
  result: Record<string, unknown> | null;
}

const CHECK_STATUS: Record<string, { tone: 'verified' | 'caution' | 'refused' | 'pending' | 'neutral'; label: string }> = {
  passed: { tone: 'verified', label: 'Passed' },
  warning: { tone: 'caution', label: 'Passed, with a warning' },
  failed: { tone: 'refused', label: 'Failed' },
  not_found: { tone: 'refused', label: 'Not found' },
  pending: { tone: 'pending', label: 'Waiting' },
  error: { tone: 'neutral', label: 'Could not check' },
  skipped: { tone: 'neutral', label: 'Not checked' },
};

function resultFacts(type: string, r: Record<string, unknown>): Array<{ label: string; value: string | null }> {
  const s = (k: string) => (r[k] === null || r[k] === undefined ? null : String(r[k]));
  const d = (k: string) => (r[k] ? formatDay(String(r[k])) : null);
  switch (type) {
    case 'registration':
      return [
        { label: 'Registered name', value: s('legal_name') },
        { label: 'Status', value: r.cipc_status ? humanise(String(r.cipc_status)) : null },
        { label: 'As the register puts it', value: s('cipc_status_raw') },
        { label: 'Incorporated', value: d('incorporation_date') },
        { label: 'Type', value: s('entity_type') },
      ];
    case 'vat':
      return [
        { label: 'Registered for VAT', value: r.registered === true ? 'Yes' : r.registered === false ? 'No' : null },
        { label: 'Registered to', value: s('vendor_name') },
        { label: 'Matches the company name', value: r.name_matches_cipc === true ? 'Yes' : r.name_matches_cipc === false ? 'No' : null },
        { label: 'Since', value: d('effective_date') },
      ];
    case 'tcs':
      return [
        { label: 'Tax compliance', value: r.tcs_status ? humanise(String(r.tcs_status)) : null },
        { label: 'PIN', value: r.pin_status ? humanise(String(r.pin_status)) : null },
        { label: 'PIN expires', value: d('pin_expires_on') },
      ];
    case 'licence':
      return [
        { label: 'Status', value: r.status ? humanise(String(r.status)) : null },
        { label: 'Codes', value: Array.isArray(r.codes) ? r.codes.join(', ') : null },
        { label: 'Missing codes', value: Array.isArray(r.missing_codes) && r.missing_codes.length ? r.missing_codes.join(', ') : null },
        { label: 'Expires', value: d('expires_on') },
        { label: 'Licence number ends', value: s('licence_number_last4') },
      ];
    case 'prdp':
      return [
        { label: 'Categories', value: Array.isArray(r.categories) ? r.categories.join(', ') : null },
        { label: 'Missing categories', value: Array.isArray(r.missing_categories) && r.missing_categories.length ? r.missing_categories.join(', ') : null },
        { label: 'Expires', value: d('expires_on') },
      ];
    default:
      return [];
  }
}

export function CheckResult({ id }: { id: string }) {
  const vat = useVatRegistered();
  const [poll, setPoll] = useState<number | false>(2000);
  const q = useApi<PortalVerification>(`/api/checks/${id}`, undefined, { refetchInterval: poll });
  useEffect(() => {
    if (q.data && q.data.status !== 'processing') setPoll(false);
  }, [q.data]);
  return (
    <Loaded q={q} label="The check">
      {(v) => {
        const checks = Object.entries(v.checks as Record<string, CheckRecordView>);
        return (
          <>
            <PageHeader
              crumbs={[{ label: 'Checks', href: '/app/checks' }, { label: v.supplier_name ?? v.subject }]}
              title={v.supplier_name ?? (v.type === 'company' ? `Company ${v.subject}` : `Driver ${v.subject}`)}
              meta={
                <>
                  <OutcomeStamp outcome={v.outcome} status={v.status} />
                  <span className="text-ink-2">
                    {v.type === 'company' ? 'Company check' : 'Driver check'} by {v.requested_by.name ?? humanise(v.requested_by.type)}, <When value={v.requested_at} showExact />
                  </span>
                </>
              }
              actions={
                v.supplier_id ? (
                  <Button intent="secondary" asChild>
                    <Link href={`/app/suppliers/${v.supplier_id}`}>Open the supplier</Link>
                  </Button>
                ) : null
              }
            />
            <div aria-live="polite" className="flex flex-col gap-6">
              {v.status === 'processing' ? (
                <Callout tone="pending" title="Still checking">
                  <p>Some bureaus are slow to answer. This page updates by itself; you can also leave and come back.</p>
                </Callout>
              ) : null}
              {v.risk_flags.length ? (
                <Sheet title={v.risk_flags.length === 1 ? 'One thing to look at' : `${v.risk_flags.length} things to look at`}>
                  <ul className="flex flex-col gap-4">
                    {v.risk_flags.map((f) => {
                      const x = explainFlag(f);
                      return (
                        <li key={f} className="border-l-4 border-amber pl-4">
                          <p className="font-bold">{x.title}</p>
                          {x.action ? <p className="text-ink-2">{x.action}</p> : null}
                        </li>
                      );
                    })}
                  </ul>
                </Sheet>
              ) : v.status === 'completed' ? (
                <Callout tone="verified" title="Nothing to look at" announce={false}>
                  <p>Every check passed.</p>
                </Callout>
              ) : null}
              <div className="grid gap-6 xl:grid-cols-2">
                {checks.map(([type, c]) => {
                  const st = CHECK_STATUS[c.status] ?? { tone: 'neutral' as const, label: humanise(c.status) };
                  const directors = type === 'directors' && c.result && Array.isArray(c.result.active) ? (c.result.active as Array<{ full_name: string; role: string; appointed_on: string | null; id_number_last4: string | null }>) : null;
                  return (
                    <Sheet
                      key={type}
                      title={CHECK_LABELS[type] ?? humanise(type)}
                      description={`${c.source === 'mock' ? 'Sandbox test data' : `Source: ${c.source}`}${c.data_as_of ? `, as of ${formatDay(c.data_as_of)}` : ''}${c.stale ? ' (an older result)' : ''}`}
                      actions={<Stamp tone={st.tone}>{st.label}</Stamp>}
                    >
                      {directors ? (
                        <ul className="flex flex-col divide-y divide-rule">
                          {directors.map((d) => (
                            <li key={`${d.full_name}-${d.appointed_on}`} className="py-2">
                              <p className="font-semibold">{d.full_name}</p>
                              <p className="text-sm text-ink-2">
                                {humanise(d.role)}
                                {d.appointed_on ? `, appointed ${formatDay(d.appointed_on)}` : ''}
                                {d.id_number_last4 ? `, ID ending ${d.id_number_last4}` : ''}
                              </p>
                            </li>
                          ))}
                        </ul>
                      ) : c.result ? (
                        <RecordList columns={1} items={resultFacts(type, c.result).map((x) => ({ label: x.label, value: x.value }))} />
                      ) : (
                        <p className="text-ink-2">{c.error_code ? 'The source did not answer. You were not charged for this part.' : 'No details.'}</p>
                      )}
                      {c.warnings.length ? (
                        <ul className="mt-4 flex flex-col gap-1 text-sm">
                          {c.warnings.map((w) => (
                            <li key={w} className="text-amber">
                              {explainWarning(w)}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </Sheet>
                  );
                })}
              </div>
              <p className="text-sm text-ink-2">
                {v.billing.charged ? (
                  <>
                    Charged <Money cents={v.billing.price_cents} />
                    {vat ? ' (excluding VAT)' : ''} from the wallet.
                  </>
                ) : (
                  'Not charged.'
                )}
              </p>
            </div>
          </>
        );
      }}
    </Loaded>
  );
}
