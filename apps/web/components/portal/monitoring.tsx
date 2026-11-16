'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { z } from 'zod';
import type { AlertSchema, MonitoringOverviewSchema, ScheduleItemSchema } from '@tshepovet/contracts';
import { Button } from '@/components/ui/button';
import { type Column, DataTable } from '@/components/ui/data';
import { EmptyState, Stamp } from '@/components/ui/feedback';
import { PageHeader, Sheet, Stat } from '@/components/ui/layout';
import { formatCount, formatDay } from '@/lib/format';
import { useApi } from '@/lib/queries';
import { humanise, Loaded, SUBJECT_LABELS } from './common';

type Overview = z.infer<typeof MonitoringOverviewSchema>;
type Alert = z.infer<typeof AlertSchema>;
type Schedule = z.infer<typeof ScheduleItemSchema>;

const iso = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
function monthRange(offset: number) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + offset + 3, 0);
  return { from: iso(start), to: iso(end), label: `${start.toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' })} to ${end.toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' })}` };
}

export function MonitoringPage() {
  const overview = useApi<Overview>('/api/monitoring');
  const alerts = useApi<Alert[]>('/api/monitoring/alerts');
  const [offset, setOffset] = useState(0);
  const range = monthRange(offset);
  const calendar = useApi<Schedule[]>('/api/monitoring/calendar', { from: range.from, to: range.to });

  const enrolColumns: Column<Overview['enrolments'][number]>[] = [
    { key: 'name', header: 'Supplier', rowHeader: true, cell: (e) => <Link href={`/app/suppliers/${e.supplier_id}`} className="font-semibold">{e.legal_name}</Link> },
    { key: 'since', header: 'Monitored since', cell: (e) => formatDay(e.since, true) },
    { key: 'lock', header: 'Accounting lock', cell: (e) => (e.erp_lock_enabled ? 'On' : 'Off') },
    {
      key: 'payments',
      header: 'Payments',
      cell: (e) => (e.payment_lock_status === 'locked' ? <Stamp tone="refused">Locked</Stamp> : e.payment_lock_status === 'override' ? <Stamp tone="caution">Lock overridden</Stamp> : <Stamp tone="verified">Not locked</Stamp>),
    },
    { key: 'next', header: 'Next expiry', cell: (e) => (e.next_expiry_on ? formatDay(e.next_expiry_on, true) : <span className="text-ink-2">None</span>) },
  ];

  const byMonth = new Map<string, Schedule[]>();
  for (const s of calendar.data ?? []) {
    const k = s.expires_on.slice(0, 7);
    byMonth.set(k, [...(byMonth.get(k) ?? []), s]);
  }

  return (
    <>
      <PageHeader title="Monitoring" description="Suppliers TshepoVet keeps watching, what lapses next, and whose payments are locked." />
      <div className="flex flex-col gap-8">
        <Loaded q={overview} label="Monitoring">
          {(o) => (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Stat label="Monitored suppliers" value={formatCount(o.counts.enrolled)} />
              <Stat label="Expiring in 30 days" value={formatCount(o.counts.expiring_30d)} />
              <Stat label="Expired" value={formatCount(o.counts.expired)} />
              <Stat label="Payments locked" value={formatCount(o.counts.locked)} />
            </div>
          )}
        </Loaded>

        <Sheet title="Needs attention" id="alerts">
          <Loaded q={alerts} label="Alerts">
            {(list) =>
              list.length === 0 ? (
                <p className="text-ink-2">Nothing has lapsed or is about to. TshepoVet reminds suppliers 30, 14 and 7 days before an expiry.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-rule">
                  {list.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <div>
                        <Link href={`/app/suppliers/${a.supplier_id}`} className="font-semibold">
                          {a.legal_name}
                        </Link>
                        <p className="text-sm text-ink-2">
                          {a.kind === 'locked' && !a.subject_type
                            ? `Payments locked${a.reason ? `: ${a.reason}` : ''}`
                            : `${SUBJECT_LABELS[a.subject_type ?? ''] ?? humanise(a.subject_type ?? '')}${a.expires_on ? `, ${a.kind === 'expiring' ? 'expires' : 'expired'} ${formatDay(a.expires_on)}` : ''}`}
                        </p>
                      </div>
                      {a.kind === 'expiring' ? (
                        <Stamp tone="caution">{a.days === 0 ? 'Expires today' : `${a.days} days left`}</Stamp>
                      ) : a.kind === 'expired' ? (
                        <Stamp tone="refused">Expired</Stamp>
                      ) : (
                        <Stamp tone="refused">Locked</Stamp>
                      )}
                    </li>
                  ))}
                </ul>
              )
            }
          </Loaded>
        </Sheet>

        <Sheet
          title="Expiry calendar"
          id="calendar"
          description={range.label}
          actions={
            <>
              <Button intent="secondary" size="sm" onClick={() => setOffset((x) => x - 3)}>
                Earlier
              </Button>
              <Button intent="secondary" size="sm" onClick={() => setOffset((x) => x + 3)}>
                Later
              </Button>
            </>
          }
        >
          <Loaded q={calendar} label="The calendar">
            {() =>
              byMonth.size === 0 ? (
                <p className="text-ink-2">Nothing expires in these three months.</p>
              ) : (
                <div className="flex flex-col gap-6">
                  {[...byMonth.entries()].map(([month, items]) => (
                    <section key={month} aria-labelledby={`m-${month}`}>
                      <h3 id={`m-${month}`} className="mb-2 text-lg font-bold">
                        {new Date(`${month}-15`).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' })}
                      </h3>
                      <ul className="flex flex-col divide-y divide-rule">
                        {items.map((s) => (
                          <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                            <span>
                              <span className="font-semibold tabular">{formatDay(s.expires_on, true)}</span>{' '}
                              <Link href={`/app/suppliers/${s.supplier_id}`}>{s.legal_name}</Link>
                            </span>
                            <span className="text-ink-2">{SUBJECT_LABELS[s.subject_type] ?? humanise(s.subject_type)}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              )
            }
          </Loaded>
        </Sheet>

        <Sheet title="Monitored suppliers" flush>
          <Loaded q={overview} label="Monitored suppliers">
            {(o) =>
              o.enrolments.length ? (
                <DataTable caption="Monitored suppliers" captionHidden columns={enrolColumns} rows={o.enrolments} rowKey={(e) => e.supplier_id} />
              ) : (
                <div className="p-5 sm:p-6">
                  <EmptyState title="No suppliers are monitored yet">
                    <p>
                      Open a supplier and choose <strong>Start monitoring</strong>, or tick “Keep monitoring” when you run a check.{' '}
                      <Link href="/app/suppliers">Go to suppliers</Link>
                    </p>
                  </EmptyState>
                </div>
              )
            }
          </Loaded>
        </Sheet>
      </div>
    </>
  );
}
