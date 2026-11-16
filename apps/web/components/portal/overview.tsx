'use client';

import Link from 'next/link';
import type { z } from 'zod';
import type { OverviewSchema } from '@tshepovet/contracts';
import { Button } from '@/components/ui/button';
import { Money, When } from '@/components/ui/data';
import { Callout, EmptyState, OutcomeStamp } from '@/components/ui/feedback';
import { PageHeader, Sheet, Stat } from '@/components/ui/layout';
import { formatCount, formatPercent } from '@/lib/format';
import { useApi, useSession } from '@/lib/queries';
import { humanise, Loaded } from './common';

type Overview = z.infer<typeof OverviewSchema>;

const ACTIVITY: Record<string, string> = {
  'supplier.added': 'Supplier added',
  'supplier.approved': 'Supplier approved',
  'supplier.rejected': 'Supplier rejected',
  'supplier.suspended': 'Supplier suspended',
  'verification.created': 'Check started',
  'verification.completed': 'Check finished',
  'wallet.topped_up': 'Wallet topped up',
  'team.invited': 'Someone was invited',
  'api_key.created': 'API key created',
};

export function OverviewPage() {
  const { session, can } = useSession();
  const q = useApi<Overview>('/api/overview');
  return (
    <>
      <PageHeader
        title={`Good to see you, ${session.user.full_name.split(' ')[0]}`}
        description={session.organisation.legal_name}
        actions={
          can('checks:run') ? (
            <Button asChild>
              <Link href="/app/checks/new">Run a check</Link>
            </Button>
          ) : null
        }
      />
      <Loaded q={q} label="The overview">
        {(o) => (
          <div className="flex flex-col gap-8">
            {o.wallet.low_balance && can('wallet:read') ? (
              <Callout tone="caution" title="Your wallet is running low">
                <p>
                  <Money cents={o.wallet.available_cents} /> is available. Checks stop when it runs out. <Link href="/app/wallet">Top up the wallet</Link>
                </p>
              </Callout>
            ) : null}
            {o.alerts > 0 ? (
              <Callout tone="caution" title={`${formatCount(o.alerts)} ${o.alerts === 1 ? 'thing needs' : 'things need'} attention`}>
                <p>
                  Expired documents, locked payments or suspended suppliers. <Link href="/app/monitoring">See the alerts</Link>
                </p>
              </Callout>
            ) : null}
            <section aria-labelledby="month" className="flex flex-col gap-4">
              <h2 id="month" className="text-2xl font-bold">
                This month
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Stat
                  label="Checks run"
                  value={formatCount(o.checks_this_month.total)}
                  detail={o.verified_rate === null ? 'None finished yet' : `${formatPercent(o.verified_rate)} verified`}
                  href="/app/checks"
                  linkLabel="See all checks"
                />
                <Stat
                  label="Suppliers"
                  value={formatCount(o.suppliers.total)}
                  detail={`${formatCount(o.suppliers.approved)} approved, ${formatCount(o.suppliers.in_progress)} in progress`}
                  href="/app/suppliers"
                  linkLabel="See suppliers"
                />
                <Stat label="Expiring in 30 days" value={formatCount(o.expiries_due_30d)} href="/app/monitoring" linkLabel="See the calendar" />
                <Stat label="Wallet available" value={<Money cents={o.wallet.available_cents} />} detail={o.wallet.held_cents ? <>Holding <Money cents={o.wallet.held_cents} /> for checks in progress</> : undefined} href={can('wallet:read') ? '/app/wallet' : undefined} linkLabel="Open the wallet" />
              </div>
            </section>
            <div className="grid gap-6 xl:grid-cols-2">
              <Sheet title="Latest checks" id="latest">
                {o.recent_checks.length === 0 ? (
                  <EmptyState title="No checks yet" action={can('checks:run') ? <Button asChild><Link href="/app/checks/new">Run your first check</Link></Button> : undefined}>
                    <p>A company check costs a few rand and takes seconds. Start with a supplier you already pay.</p>
                  </EmptyState>
                ) : (
                  <ul className="flex flex-col divide-y divide-rule">
                    {o.recent_checks.map((c) => (
                      <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                        <div className="min-w-0">
                          <Link href={`/app/checks/${c.id}`} className="font-semibold">
                            {c.supplier_name ?? c.subject}
                          </Link>
                          <p className="text-sm text-ink-2">
                            {c.type === 'company' ? 'Company check' : 'Driver check'}, <When value={c.requested_at} />
                          </p>
                        </div>
                        <OutcomeStamp outcome={c.outcome} status={c.status} />
                      </li>
                    ))}
                  </ul>
                )}
              </Sheet>
              {can('audit:read') ? (
                <Sheet title="Recent activity" id="activity" actions={<Link href="/app/compliance/audit" className="inline-flex min-h-11 items-center font-semibold">Audit log</Link>}>
                  <ul className="flex flex-col divide-y divide-rule">
                    {o.recent_activity.map((a) => (
                      <li key={a.id} className="py-3">
                        <p className="font-semibold">{ACTIVITY[a.action] ?? humanise(a.action.replace('.', ': '))}</p>
                        <p className="text-sm text-ink-2">
                          {a.actor.name ?? humanise(a.actor.type)}, <When value={a.occurred_at} />
                        </p>
                      </li>
                    ))}
                  </ul>
                </Sheet>
              ) : null}
            </div>
          </div>
        )}
      </Loaded>
    </>
  );
}
