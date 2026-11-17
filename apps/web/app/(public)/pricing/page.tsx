import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Term } from '@/components/ui/data';
import { Callout } from '@/components/ui/feedback';
import { formatMoney, formatPercent } from '@/lib/format';
import { getMeta } from '@/lib/server';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'Pay per check from a prepaid wallet in rand. No subscription, no minimum.',
};

/** One priced item: its name, the price beside it, what it covers below the name. dt and dd
 *  sit directly in the group (a dl allows one wrapping div, no deeper). */
function PriceRow({ name, price, unit, children }: { name: React.ReactNode; price: string; unit: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-8 gap-y-1 py-5 sm:grid-cols-[minmax(0,1fr)_12rem]">
      <dt className="text-lg font-bold">{name}</dt>
      <dd className="sm:col-start-2 sm:row-span-3 sm:row-start-1 sm:text-right">
        <span className="text-2xl font-bold tabular">{price}</span>
        <span className="block text-sm text-ink-2">{unit}</span>
      </dd>
      {children}
    </div>
  );
}

export default async function Pricing() {
  const meta = await getMeta();
  const p = meta.check_prices;
  const checks: Array<[React.ReactNode, React.ReactNode, number, string]> = [
    [
      'Company check',
      <>
        Registration and status on the <Term term="CIPC" /> register, directors, <Term term="VAT" />, and tax compliance with the supplier’s PIN. A recent result may be
        reused instead of asking the bureau again.
      </>,
      p.company_cents,
      'a check',
    ],
    ['Company check, fresh from the bureau', 'The same check, always asked of the bureau again: for a decision on the day.', p.company_live_cents, 'a check'],
    [
      'Driving licence check',
      <>
        Licence and <Term term="PrDP" /> for a driver.
      </>,
      p.driver_cents,
      'a check',
    ],
    ['Monitoring', 'Re-checks before documents and tax PINs lapse, tells you, and can lock payments in your accounting system.', p.monitoring_per_supplier_month_cents, 'a supplier a month'],
  ];
  return (
    <div className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
      <h1 className="text-4xl font-bold">Pricing</h1>
      <p className="mt-4 max-w-[60ch] text-xl text-ink-2">
        Top up a wallet in rand and pay for each check you run. There is no subscription and no minimum. Prices exclude VAT, which is added to each top-up at{' '}
        {formatPercent(meta.vat_rate)}.
      </p>
      {meta.sandbox ? (
        <Callout tone="info" title="This is the sandbox" className="mt-6" announce={false}>
          <p>Top-ups here are pretend money and checks answer from sample data, at the same prices.</p>
        </Callout>
      ) : null}

      <section aria-labelledby="checks" className="mt-10">
        <h2 id="checks" className="text-2xl font-bold">
          Checks
        </h2>
        <dl className="mt-4 flex flex-col divide-y divide-rule border-y border-rule">
          {checks.map(([name, what, cents, unit], i) => (
            <PriceRow key={i} name={name} price={formatMoney(cents)} unit={unit}>
              <dd className="text-ink-2 sm:col-start-1">{what}</dd>
            </PriceRow>
          ))}
        </dl>
        <p className="mt-4 max-w-[60ch] text-ink-2">
          Onboarding costs a supplier nothing: the checks run while it onboards are charged to the customer who invited it, at the prices above.
        </p>
      </section>

      {meta.modules.length ? (
        <section aria-labelledby="modules" className="mt-12">
          <h2 id="modules" className="text-2xl font-bold">
            Modules
          </h2>
          <p className="mt-2 text-ink-2">Monthly, for the whole organisation. Turn one on or off from the portal; it is paid from the wallet.</p>
          <dl className="mt-4 flex flex-col divide-y divide-rule border-y border-rule">
            {meta.modules.map((m) => (
              <PriceRow key={m.sku} name={m.name} price={formatMoney(m.price_cents, true)} unit="a month">
                <dd className="text-ink-2 sm:col-start-1">{m.description}</dd>
                {!m.available && m.unavailable_reason ? <dd className="text-sm font-semibold text-amber sm:col-start-1">Not available yet: {m.unavailable_reason}</dd> : null}
              </PriceRow>
            ))}
          </dl>
        </section>
      ) : null}

      <div className="mt-12 flex flex-wrap gap-3">
        <Button asChild>
          <Link href="/sign-up">Create an account</Link>
        </Button>
        <Button asChild intent="secondary">
          <a href="/docs/">Read the API documentation</a>
        </Button>
      </div>
    </div>
  );
}
