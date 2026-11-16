'use client';

import { Download } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import type { HoldSchema, LedgerPageSchema, TopupPageSchema, TopupResultSchema, WalletSchema } from '@tshepovet/contracts';
import { Button } from '@/components/ui/button';
import { type Column, DataTable, Money, Pagination, When } from '@/components/ui/data';
import { Callout, Stamp } from '@/components/ui/feedback';
import { Field, Input, RadioGroup, Select } from '@/components/ui/form';
import { PageHeader, RecordList, Sheet } from '@/components/ui/layout';
import { Dialog, DialogClose } from '@/components/ui/overlay';
import { api, ApiProblem, withQuery } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useApi, useChange, useSession } from '@/lib/queries';
import { FilterBar, humanise, Loaded, useListParams } from './common';

type Wallet = z.infer<typeof WalletSchema>;
type Hold = z.infer<typeof HoldSchema>;
type LedgerPage = z.infer<typeof LedgerPageSchema>;
type TopupPage = z.infer<typeof TopupPageSchema>;
type TopupResult = z.infer<typeof TopupResultSchema>;

const KIND_LABEL: Record<string, string> = {
  topup: 'Top-up',
  usage_capture: 'Check',
  refund: 'Refund',
  adjustment: 'Adjustment',
  subscription_charge: 'Module',
  monitoring_charge: 'Monitoring',
  promo_credit: 'Free credit',
};

export function WalletPage() {
  const { can } = useSession();
  const wallet = useApi<Wallet>('/api/wallet');
  const holds = useApi<Hold[]>('/api/wallet/holds');
  const { values, set } = useListParams({ kind: 'all', page: '1' });
  const ledgerQuery = { kind: values.kind === 'all' ? undefined : values.kind, page: Number(values.page), page_size: 20 };
  const ledger = useApi<LedgerPage>('/api/wallet/ledger', ledgerQuery);
  const topups = useApi<TopupPage>('/api/wallet/topups', { page: 1, page_size: 10 });
  type L = LedgerPage['items'][number];
  const cols: Column<L>[] = [
    { key: 'when', header: 'When', cell: (l) => <When value={l.created_at} showExact /> },
    { key: 'kind', header: 'What', rowHeader: true, cell: (l) => <span className="font-semibold">{KIND_LABEL[l.kind] ?? humanise(l.kind)}</span> },
    { key: 'memo', header: 'Details', cell: (l) => l.memo ?? '' },
    { key: 'amount', header: 'Amount', align: 'end', cell: (l) => <Money cents={l.amount_cents} signed className={l.amount_cents > 0 ? 'font-semibold text-green' : ''} /> },
  ];
  return (
    <>
      <PageHeader
        title="Wallet"
        description="Checks and modules are paid from this prepaid balance. Amounts exclude VAT; each top-up has a tax invoice."
        actions={can('wallet:topup') ? <TopUp /> : null}
      />
      <div className="flex flex-col gap-8">
        <Loaded q={wallet} label="The wallet">
          {(w) => (
            <div className="grid gap-6 xl:grid-cols-[1.2fr_1fr]">
              <Sheet title="Balance">
                <p className="text-4xl font-bold tabular">
                  <Money cents={w.available_cents} />
                </p>
                <p className="mt-1 text-ink-2">available now</p>
                <div className="mt-5">
                  <RecordList
                    items={[
                      { label: 'Balance', value: <Money cents={w.balance_cents} /> },
                      { label: 'Held for checks in progress', value: <Money cents={w.held_cents} /> },
                      { label: 'Warn me below', value: <Money cents={w.low_balance_threshold_cents} />, note: can('wallet:topup') ? <ThresholdEdit current={w.low_balance_threshold_cents} /> : undefined },
                      { label: 'Status', value: w.status === 'active' ? 'Active' : 'Frozen' },
                    ]}
                  />
                </div>
                {w.low_balance ? (
                  <Callout tone="caution" title="Your balance is below your warning level" className="mt-5" announce={false}>
                    <p>Checks stop when the wallet runs out.</p>
                  </Callout>
                ) : null}
              </Sheet>
              <Sheet title="Held right now" description="Money reserved for checks still running. It is charged or released when each finishes.">
                <Loaded q={holds} label="Holds">
                  {(h) =>
                    h.length ? (
                      <ul className="flex flex-col divide-y divide-rule">
                        {h.map((x) => (
                          <li key={x.id} className="flex justify-between gap-3 py-2">
                            <span>{x.sku === 'DRIVER_LICENCE_CHECK' ? 'Driver check' : 'Company check'}</span>
                            <Money cents={x.amount_cents} />
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-ink-2">Nothing is held.</p>
                    )
                  }
                </Loaded>
              </Sheet>
            </div>
          )}
        </Loaded>

        <Sheet title="Movements" flush>
          <FilterBar>
            <Field label="Show" className="w-56">
              {(p) => (
                <Select
                  {...p}
                  value={values.kind}
                  onValueChange={(v) => set({ kind: v })}
                  options={[{ value: 'all', label: 'Everything' }, ...Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))]}
                />
              )}
            </Field>
            <Button intent="secondary" asChild>
              <a href={withQuery('/api/wallet/ledger.csv', { kind: ledgerQuery.kind })} download>
                <Download aria-hidden="true" />
                Export CSV
              </a>
            </Button>
          </FilterBar>
          <div className="border-t border-rule">
            <Loaded q={ledger} label="Movements">
              {(page) => (
                <>
                  <DataTable caption="Wallet movements" captionHidden columns={cols} rows={page.items} rowKey={(l) => `${l.id}`} empty="No movements yet. A top-up is the first." />
                  <div className="border-t border-rule">
                    <Pagination page={page.page} pageSize={page.page_size} total={page.total} noun={['movement', 'movements']} onPage={(p) => set({ page: p }, false)} />
                  </div>
                </>
              )}
            </Loaded>
          </div>
        </Sheet>

        <Sheet title="Top-ups and tax invoices">
          <Loaded q={topups} label="Top-ups">
            {(t) =>
              t.items.length ? (
                <ul className="flex flex-col divide-y divide-rule">
                  {t.items.map((x) => (
                    <li key={x.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <div>
                        <p className="font-semibold">
                          Tax invoice <span className="font-mono">{x.tax_invoice_number ?? 'pending'}</span>
                        </p>
                        <p className="text-sm text-ink-2">
                          <When value={x.created_at} showExact />, {x.payment_provider === 'sandbox' ? 'sandbox payment' : humanise(x.payment_provider)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold tabular">{formatMoney(x.gross_cents)} paid</p>
                        <p className="text-sm text-ink-2 tabular">
                          {formatMoney(x.credit_cents)} credit + {formatMoney(x.vat_cents)} VAT
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-ink-2">No top-ups yet.</p>
              )
            }
          </Loaded>
        </Sheet>
      </div>
    </>
  );
}

function ThresholdEdit({ current }: { current: number }) {
  const [open, setOpen] = useState(false);
  const [rand, setRand] = useState(String(current / 100));
  const [error, setError] = useState<string>();
  const save = useChange((b: unknown) => api('/api/wallet', { method: 'PATCH', body: b }), { invalidate: ['/api/wallet', '/api/overview'], success: 'Warning level saved' });
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Warn me when the balance is low"
      trigger={
        <Button intent="quiet" size="sm" className="-ml-3.5">
          Change
        </Button>
      }
      footer={
        <>
          <DialogClose asChild>
            <Button intent="secondary">Cancel</Button>
          </DialogClose>
          <Button
            loading={save.isPending}
            onClick={async () => {
              const n = Number(rand.replace(/[\s,]/g, '.').replace(/\.(?=.*\.)/g, ''));
              if (!Number.isFinite(n) || n < 0) {
                setError('Enter an amount in rand, for example 500.');
                return;
              }
              await save.mutateAsync({ low_balance_threshold_cents: Math.round(n * 100) });
              setOpen(false);
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <Field label="Amount in rand" hint="Your administrators are emailed, and a webhook is sent, when the balance drops below it." error={error}>
        {(p) => <Input {...p} inputMode="decimal" value={rand} onChange={(e) => setRand(e.target.value)} />}
      </Field>
    </Dialog>
  );
}

const AMOUNTS = [50_000, 100_000, 250_000, 1_000_000];

function TopUp() {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(String(AMOUNTS[1]));
  const [custom, setCustom] = useState('');
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<TopupResult | null>(null);
  const top = useChange((b: unknown) => api<TopupResult>('/api/wallet/topups', { method: 'POST', body: b }), { invalidate: ['/api/wallet', '/api/overview', '/api/checks/prices'] });
  const credit = choice === 'other' ? Math.round(Number(custom.replace(/\s/g, '').replace(',', '.')) * 100) : Number(choice);
  const valid = Number.isFinite(credit) && credit >= 10_000 && credit <= 10_000_000;
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setDone(null);
      }}
      title={done ? 'Wallet topped up' : 'Top up the wallet'}
      description={done ? undefined : 'Sandbox: no money moves. The credit lands at once, with a tax invoice, exactly as a real payment will.'}
      trigger={<Button>Top up</Button>}
      footer={
        done ? (
          <DialogClose asChild>
            <Button>Done</Button>
          </DialogClose>
        ) : (
          <>
            <DialogClose asChild>
              <Button intent="secondary">Cancel</Button>
            </DialogClose>
            <Button
              loading={top.isPending}
              onClick={async () => {
                if (!valid) {
                  setError('Choose an amount from R100 to R100 000.');
                  return;
                }
                setError(undefined);
                try {
                  setDone(await top.mutateAsync({ credit_cents: credit }));
                } catch (e) {
                  setError(e instanceof ApiProblem ? e.message : 'The top-up did not go through. Nothing was charged.');
                }
              }}
            >
              {valid ? `Pay ${formatMoney(Math.round(credit * 1.15))}` : 'Pay'}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <div className="flex flex-col gap-3">
          <Stamp tone="verified">Paid</Stamp>
          <RecordList
            columns={1}
            items={[
              { label: 'Credit added', value: <Money cents={done.topup.credit_cents} /> },
              { label: 'VAT', value: <Money cents={done.topup.vat_cents} /> },
              { label: 'Paid', value: <Money cents={done.topup.gross_cents} /> },
              { label: 'Tax invoice', value: <span className="font-mono">{done.topup.tax_invoice_number}</span> },
              { label: 'New balance', value: <Money cents={done.balance_cents} /> },
            ]}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {error ? <Callout tone="refused" title={error} /> : null}
          <RadioGroup
            legend="Credit to add (excluding VAT)"
            value={choice}
            onValueChange={setChoice}
            options={[
              ...AMOUNTS.map((a) => ({ value: String(a), label: formatMoney(a, true), hint: `About ${Math.floor(a / 300)} company checks` })),
              { value: 'other', label: 'Another amount' },
            ]}
          />
          {choice === 'other' ? (
            <Field label="Amount in rand" hint="From R100 to R100 000.">
              {(p) => <Input {...p} inputMode="decimal" value={custom} onChange={(e) => setCustom(e.target.value)} />}
            </Field>
          ) : null}
          {valid ? (
            <p className="text-ink-2">
              You pay <strong className="text-ink tabular">{formatMoney(Math.round(credit * 1.15))}</strong>: {formatMoney(credit)} credit and {formatMoney(Math.round(credit * 0.15))} VAT.
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
