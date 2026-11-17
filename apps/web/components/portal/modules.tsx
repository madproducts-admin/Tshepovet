'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { z } from 'zod';
import type { ModuleChangeSchema, ModuleSchema, ScorecardSchema, SpendLineSchema, SupplierPageSchema } from '@tshepovet/contracts';
import { Button } from '@/components/ui/button';
import { type Column, DataTable, Money, Term } from '@/components/ui/data';
import { Callout, EmptyState, Stamp } from '@/components/ui/feedback';
import { ErrorSummary, Field, Input, Select } from '@/components/ui/form';
import { PageHeader, RecordList, Sheet, Stat } from '@/components/ui/layout';
import { ConfirmDialog } from '@/components/ui/overlay';
import { api, ApiProblem } from '@/lib/api';
import { formatDay, formatMoney, formatPercent } from '@/lib/format';
import { useApi, useChange, useSession, useVatRegistered } from '@/lib/queries';
import { Loaded } from './common';

type Module = z.infer<typeof ModuleSchema>;
type ModuleChange = z.infer<typeof ModuleChangeSchema>;
type SpendLine = z.infer<typeof SpendLineSchema>;
type Scorecard = z.infer<typeof ScorecardSchema>;
type SupplierPage = z.infer<typeof SupplierPageSchema>;

export function ModulesPage() {
  const { can } = useSession();
  const vat = useVatRegistered();
  const q = useApi<Module[]>('/api/modules');
  return (
    <>
      <PageHeader title="Modules" description="Extra tools, paid monthly from your wallet. Turn one off and it stays on until the end of the month you paid for." />
      <Loaded q={q} label="Modules">
        {(mods) => (
          <ul className="grid gap-6 lg:grid-cols-2">
            {mods.map((m) => (
              <li key={m.sku}>
                <Sheet
                  title={m.name}
                  headingLevel={2}
                  actions={
                    m.state === 'on' ? (
                      <Stamp tone="verified">On</Stamp>
                    ) : m.state === 'ending' ? (
                      <Stamp tone="caution">Ends {formatDay(m.current_period_end!, true)}</Stamp>
                    ) : (
                      <Stamp tone="neutral">Off</Stamp>
                    )
                  }
                >
                  <p>{m.description}</p>
                  <p className="mt-3 font-semibold tabular">{formatMoney(m.price_cents)} a month{vat ? ', excluding VAT' : ''}</p>
                  {!m.available ? (
                    <Callout tone="info" title="Not available yet" className="mt-4" announce={false}>
                      <p>{m.unavailable_reason}</p>
                    </Callout>
                  ) : null}
                  <div className="mt-5 flex flex-wrap gap-3">
                    {m.sku === 'MOD_BBBEE' && m.state !== 'off' && can('modules:use') ? (
                      <Button asChild>
                        <Link href="/app/modules/bbbee">Open the scorecard</Link>
                      </Button>
                    ) : null}
                    {can('settings:manage') && m.available ? <ModuleSwitch m={m} /> : null}
                  </div>
                </Sheet>
              </li>
            ))}
          </ul>
        )}
      </Loaded>
    </>
  );
}

function ModuleSwitch({ m }: { m: Module }) {
  const [error, setError] = useState<string | null>(null);
  const on = useChange(() => api<ModuleChange>(`/api/modules/${m.sku}`, { method: 'POST' }), {
    invalidate: ['/api/modules', '/api/wallet', '/api/overview'],
    success: (r) => (r.charged_cents ? `${m.name} turned on: ${formatMoney(r.charged_cents)} charged` : `${m.name} stays on`),
  });
  const off = useChange(() => api<ModuleChange>(`/api/modules/${m.sku}`, { method: 'DELETE' }), { invalidate: ['/api/modules'], success: `${m.name} will turn off at the end of the month` });
  const run = async (fn: typeof on) => {
    setError(null);
    try {
      await fn.mutateAsync(undefined);
    } catch (e) {
      setError(e instanceof ApiProblem && e.code === 'insufficient_funds' ? 'Your wallet does not have enough. Top it up first.' : e instanceof ApiProblem ? e.message : 'That did not work. Try again.');
    }
  };
  return (
    <>
      {m.state === 'on' ? (
        <ConfirmDialog
          trigger={<Button intent="secondary">Turn off</Button>}
          title={`Turn off ${m.name}?`}
          consequence={<p>It stays on until {formatDay(m.current_period_end!)}, the end of the month you paid for, and is not charged again.</p>}
          confirmLabel="Turn off at month end"
          busy={off.isPending}
          onConfirm={() => run(off)}
        />
      ) : (
        <ConfirmDialog
          trigger={<Button>{m.state === 'ending' ? 'Keep it on' : 'Turn on'}</Button>}
          title={m.state === 'ending' ? `Keep ${m.name} on?` : `Turn on ${m.name}?`}
          consequence={
            m.state === 'ending' ? (
              <p>It renews at the end of the month as normal. Nothing is charged now.</p>
            ) : (
              <p>
                {formatMoney(m.price_cents)} is charged from your wallet now for the first month, then monthly until you turn it off.
              </p>
            )
          }
          confirmLabel={m.state === 'ending' ? 'Keep it on' : `Turn on for ${formatMoney(m.price_cents)}`}
          cancelLabel="Not now"
          busy={on.isPending}
          onConfirm={() => run(on)}
        />
      )}
      {error ? <Callout tone="refused" title={error} className="w-full" /> : null}
    </>
  );
}

// --- B-BBEE spend and scorecard ----------------------------------------------------------------
function defaultPeriod() {
  const now = new Date();
  const y = now.getMonth() >= 2 ? now.getFullYear() : now.getFullYear() - 1; // March to February
  return { from: `${y}-03-01`, to: `${y + 1}-02-${new Date(y + 1, 2, 0).getDate()}` };
}

export function BbbeePage() {
  const [period, setPeriod] = useState(defaultPeriod);
  const score = useApi<Scorecard>('/api/modules/bbbee/scorecard', period);
  const spend = useApi<SpendLine[]>('/api/modules/bbbee/spend', period);
  type Row = Scorecard['suppliers'][number];
  const cols: Column<Row>[] = [
    { key: 'name', header: 'Supplier', rowHeader: true, cell: (r) => <Link href={`/app/suppliers/${r.supplier_id}`} className="font-semibold">{r.legal_name}</Link> },
    { key: 'level', header: 'Level', cell: (r) => (r.level === null ? (r.flags.length ? 'Unverified' : 'Non-compliant') : `Level ${r.level}`) },
    { key: 'spend', header: 'Spend', align: 'end', cell: (r) => <Money cents={r.spend_cents} /> },
    { key: 'pct', header: 'Recognised at', align: 'end', cell: (r) => `${r.recognition_pct}%` },
    { key: 'rec', header: 'Recognised spend', align: 'end', cell: (r) => <Money cents={r.recognised_cents} /> },
    {
      key: 'flags',
      header: 'Evidence',
      cell: (r) =>
        r.flags.length ? (
          <Stamp tone="caution">{{ no_evidence: 'None on file', evidence_expired: 'Expired', evidence_not_accepted: 'Not accepted' }[r.flags[0]!]}</Stamp>
        ) : (
          <Stamp tone="verified">Valid to {formatDay(r.valid_until!, true)}</Stamp>
        ),
    },
  ];
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Modules', href: '/app/modules' }, { label: 'B-BBEE scorecard' }]}
        title={<>Preferential procurement</>}
        description="How much of your spend counts towards your own B-BBEE scorecard, from each supplier’s verified level."
      />
      <div className="flex flex-col gap-8">
        <Sheet title="Measurement period">
          <div className="flex flex-wrap items-end gap-4">
            <Field label="From">{(p) => <Input {...p} type="date" value={period.from} onChange={(e) => setPeriod((x) => ({ ...x, from: e.target.value }))} className="w-48" />}</Field>
            <Field label="To">{(p) => <Input {...p} type="date" value={period.to} onChange={(e) => setPeriod((x) => ({ ...x, to: e.target.value }))} className="w-48" />}</Field>
          </div>
        </Sheet>
        <Loaded q={score} label="The scorecard">
          {(s) => (
            <>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Stat label="Measured spend" value={<Money cents={s.total_measured_spend_cents} whole />} />
                <Stat
                  label="Recognised spend"
                  value={<Money cents={s.recognised_spend_cents} whole />}
                  detail={s.total_measured_spend_cents ? `${formatPercent(s.recognised_spend_cents / s.total_measured_spend_cents)} of measured spend` : undefined}
                />
                <Stat label="Spend with EMEs and QSEs" value={<Money cents={s.eme_spend_cents + s.qse_spend_cents} whole />} detail={<><Term term="EME" /> and <Term term="QSE" /> suppliers</>} />
                <Stat label="Unverified spend" value={<Money cents={s.unverified_spend_cents} whole />} detail="No valid evidence: recognised at 0%" />
              </div>
              <Sheet title="Targets that count ownership" description="From each supplier’s verified ownership, as the Codes measure it.">
                <RecordList
                  columns={3}
                  items={[
                    { label: 'With 51% black-owned suppliers', value: <Money cents={s.black_owned_51_spend_cents} whole /> },
                    { label: 'With 30% black women-owned suppliers', value: <Money cents={s.black_women_owned_30_spend_cents} whole /> },
                    { label: 'With empowering suppliers', value: <Money cents={s.empowering_supplier_spend_cents} whole /> },
                  ]}
                />
              </Sheet>
              <Sheet title="By supplier" flush>
                <DataTable caption="Spend by supplier" captionHidden columns={cols} rows={s.suppliers} rowKey={(r) => r.supplier_id} empty="No spend recorded in this period. Add it below." />
              </Sheet>
            </>
          )}
        </Loaded>
        <AddSpend onAdded={() => undefined} />
        <Sheet title="Spend lines in this period">
          <Loaded q={spend} label="Spend lines">
            {(lines) =>
              lines.length ? (
                <ul className="flex flex-col divide-y divide-rule">
                  {lines.map((l) => (
                    <SpendRow key={l.id} l={l} />
                  ))}
                </ul>
              ) : (
                <p className="text-ink-2">None yet.</p>
              )
            }
          </Loaded>
        </Sheet>
      </div>
    </>
  );
}

function SpendRow({ l }: { l: SpendLine }) {
  const del = useChange(() => api(`/api/modules/bbbee/spend/${l.id}`, { method: 'DELETE' }), { invalidate: ['/api/modules/bbbee'], success: 'Spend line deleted' });
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-2">
      <span>
        <span className="font-semibold">{l.legal_name}</span>
        <span className="text-ink-2">
          {' '}
          {formatDay(l.period_start, true)} to {formatDay(l.period_end, true)}
          {l.description ? `, ${l.description}` : ''}
        </span>
      </span>
      <span className="flex items-center gap-3">
        <Money cents={l.amount_cents} />
        <ConfirmDialog
          trigger={<Button intent="quiet" size="sm">Delete</Button>}
          title="Delete this spend line?"
          consequence={<p>{formatMoney(l.amount_cents)} with {l.legal_name} stops counting. You can add it again.</p>}
          confirmLabel="Delete line"
          destructive
          busy={del.isPending}
          onConfirm={() => del.mutate(undefined)}
        />
      </span>
    </li>
  );
}

function AddSpend({ onAdded }: { onAdded: () => void }) {
  const suppliers = useApi<SupplierPage>('/api/suppliers', { page_size: 100, sort: 'legal_name', order: 'asc' });
  const [v, setV] = useState({ supplier_id: '', period_start: '', period_end: '', amount: '', description: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const add = useChange((b: unknown) => api('/api/modules/bbbee/spend', { method: 'POST', body: b }), { invalidate: ['/api/modules/bbbee'], success: 'Spend recorded', onSuccess: onAdded });
  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    const amount = Math.round(Number(v.amount.replace(/\s/g, '').replace(',', '.')) * 100);
    const found: Record<string, string> = {};
    if (!v.supplier_id) found['sp-supplier'] = 'Choose the supplier.';
    if (!v.period_start) found['sp-start'] = 'Enter the first day of the spend.';
    if (!v.period_end) found['sp-end'] = 'Enter the last day of the spend.';
    else if (v.period_start && v.period_end < v.period_start) found['sp-end'] = 'The period cannot end before it starts.';
    if (!Number.isFinite(amount) || amount < 1) found['sp-amount'] = 'Enter the amount in rand, excluding VAT.';
    setErrors(found);
    if (Object.keys(found).length) return;
    try {
      await add.mutateAsync({ lines: [{ supplier_id: v.supplier_id, period_start: v.period_start, period_end: v.period_end, amount_cents: amount, ...(v.description ? { description: v.description } : {}) }] });
      setV({ supplier_id: v.supplier_id, period_start: '', period_end: '', amount: '', description: '' });
    } catch (err) {
      setErrors({ 'sp-amount': err instanceof ApiProblem ? err.message : 'The spend could not be recorded.' });
    }
  };
  return (
    <Sheet title="Record spend" description="Amounts excluding VAT, per supplier and period. Import from your accounting system through the API to save typing.">
      {suppliers.data && suppliers.data.items.length === 0 ? (
        <EmptyState title="Add suppliers first">
          <p>
            Spend is recorded against suppliers on your list. <Link href="/app/suppliers">Go to suppliers</Link>
          </p>
        </EmptyState>
      ) : (
        <form noValidate onSubmit={submit} className="grid gap-5 lg:grid-cols-2">
          <div className="lg:col-span-2">
            <ErrorSummary errors={Object.entries(errors).map(([field, message]) => ({ field, message }))} />
          </div>
          <Field id="sp-supplier" label="Supplier" error={errors['sp-supplier']}>
            {(p) => <Select {...p} value={v.supplier_id} onValueChange={(x) => setV((s) => ({ ...s, supplier_id: x }))} options={(suppliers.data?.items ?? []).map((s) => ({ value: s.id, label: s.legal_name }))} />}
          </Field>
          <Field id="sp-amount" label="Amount in rand" error={errors['sp-amount']}>
            {(p) => <Input {...p} inputMode="decimal" value={v.amount} onChange={(e) => setV((s) => ({ ...s, amount: e.target.value }))} />}
          </Field>
          <Field id="sp-start" label="From" error={errors['sp-start']}>
            {(p) => <Input {...p} type="date" value={v.period_start} onChange={(e) => setV((s) => ({ ...s, period_start: e.target.value }))} />}
          </Field>
          <Field id="sp-end" label="To" error={errors['sp-end']}>
            {(p) => <Input {...p} type="date" value={v.period_end} onChange={(e) => setV((s) => ({ ...s, period_end: e.target.value }))} />}
          </Field>
          <Field label="Description" optional className="lg:col-span-2">
            {(p) => <Input {...p} value={v.description} onChange={(e) => setV((s) => ({ ...s, description: e.target.value }))} maxLength={200} />}
          </Field>
          <div>
            <Button type="submit" loading={add.isPending}>
              Record spend
            </Button>
          </div>
        </form>
      )}
    </Sheet>
  );
}
