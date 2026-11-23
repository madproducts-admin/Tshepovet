import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { connection } from 'next/server';
import { Seal } from '@/components/brand/seal';
import { SpecimenBand } from '@/components/brand/specimen';
import { Callout, EmptyState, Meter, OutcomeStamp, Skeleton, Spinner, Stamp, SupplierStatusStamp } from '@/components/ui/feedback';
import { PageHeader, RecordList, Sheet, SkipLink, Stat, Steps, Timeline } from '@/components/ui/layout';
import { Toaster } from '@/components/ui/toast';
import { THEME_COOKIE, type ThemeChoice } from '@/lib/theme';
import { InteractiveCatalogue } from './catalogue';

export const metadata: Metadata = { title: 'Design system' };

const COLOURS: Array<{ name: string; token: string; use: string; pair: string; ratio: string }> = [
  { name: 'Paper', token: '--paper', use: 'The page', pair: 'Ink on paper', ratio: '14.7:1' },
  { name: 'Sheet', token: '--sheet', use: 'Records lifted off the page', pair: 'Ink on sheet', ratio: '16.0:1' },
  { name: 'Ink', token: '--ink', use: 'Text', pair: 'Secondary ink on paper', ratio: '7.9:1' },
  { name: 'Stamp violet', token: '--violet', use: 'What you can do: buttons, links, focus', pair: 'White on violet', ratio: '10.5:1' },
  { name: 'Verified green', token: '--green', use: 'Verified, approved, paid up', pair: 'Green on its tint', ratio: '8.4:1' },
  { name: 'Caution amber', token: '--amber', use: 'Needs attention, expiring', pair: 'Amber on its tint', ratio: '7.6:1' },
  { name: 'Refusal red', token: '--red', use: 'Failed, refused, cannot be undone', pair: 'Red on its tint', ratio: '7.2:1' },
  { name: 'Petrol', token: '--petrol', use: 'Pending, for information', pair: 'Petrol on its tint', ratio: '7.4:1' },
];

const TYPE: Array<{ cls: string; px: string; use: string }> = [
  { cls: 'text-5xl', px: '64', use: 'Public pages only' },
  { cls: 'text-4xl', px: '48', use: 'Public headlines' },
  { cls: 'text-3xl', px: '36', use: 'Page titles' },
  { cls: 'text-2xl', px: '28', use: 'Section headings' },
  { cls: 'text-xl', px: '22', use: 'Record headings' },
  { cls: 'text-lg', px: '18', use: 'Lead paragraphs' },
  { cls: 'text-base', px: '16', use: 'Body text, controls' },
  { cls: 'text-sm', px: '15', use: 'Hints, table detail' },
];

export default async function DesignSystemPage() {
  await connection();
  const theme = ((await cookies()).get(THEME_COOKIE)?.value ?? 'system') as ThemeChoice;
  return (
    <>
      <SkipLink />
      <header className="border-b border-rule bg-sheet">
        <SpecimenBand />
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <Seal size={36} />
          <span className="text-lg font-bold">TshepoVet</span>
        </div>
      </header>
      <main id="main" className="mx-auto flex max-w-6xl flex-col gap-12 px-4 py-10 sm:px-6">
        <PageHeader
          crumbs={[{ label: 'TshepoVet', href: '/' }, { label: 'Design system' }]}
          title="Design system"
          description="The parts every TshepoVet screen is built from. Each one meets WCAG 2.2 AAA where AAA applies: 7:1 contrast, 44-pixel targets, a visible focus ring, no time limits."
        />

        <section aria-labelledby="seal" className="flex flex-col gap-4">
          <h2 id="seal" className="text-2xl font-bold">
            The seal
          </h2>
          <p className="text-ink-2">
            Engraved line-work, as on a banknote or a passport page. It is the only ornament in the system: the brand, a verified supplier passport, and the
            sandbox band. Nothing else is decorated.
          </p>
          <div className="flex flex-wrap items-end gap-8">
            <Seal size={160} label="TshepoVet seal" />
            <Seal size={96} verified label="Verified seal" />
            <Seal size={40} label="TshepoVet seal, small" />
          </div>
        </section>

        <section aria-labelledby="colour" className="flex flex-col gap-4">
          <h2 id="colour" className="text-2xl font-bold">
            Colour
          </h2>
          <p className="text-ink-2">Every text pair below is measured, in both themes, at 7:1 or better. Colour always comes with words or an icon.</p>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {COLOURS.map((c) => (
              <li key={c.token} className="overflow-hidden rounded-sheet border border-rule bg-sheet">
                <div className="h-16 border-b border-rule" style={{ background: `var(${c.token})` }} aria-hidden="true" />
                <div className="p-4">
                  <p className="font-bold">{c.name}</p>
                  <p className="text-sm text-ink-2">{c.use}</p>
                  <p className="mt-2 text-sm">
                    {c.pair}: <span className="font-semibold tabular">{c.ratio}</span>
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="type" className="flex flex-col gap-4">
          <h2 id="type" className="text-2xl font-bold">
            Type
          </h2>
          <p className="text-ink-2">
            Atkinson Hyperlegible Next, drawn by the Braille Institute so that characters that look alike never do. Registration numbers, PINs and keys use
            its monospaced cut: <span className="font-mono">2019/123456/07, O0 and Il1</span>.
          </p>
          <ul className="flex flex-col divide-y divide-rule rounded-sheet border border-rule bg-sheet">
            {TYPE.map((t) => (
              <li key={t.cls} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-5 py-3">
                <span className={`${t.cls} font-bold`}>Know who you are paying</span>
                <span className="text-sm text-ink-2 tabular">
                  {t.px}px: {t.use}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="stamps" className="flex flex-col gap-4">
          <h2 id="stamps" className="text-2xl font-bold">
            Stamps
          </h2>
          <p className="text-ink-2">A verdict is stamped, the way an official office stamps a document: a double rule, an icon, and the word.</p>
          <div className="flex flex-wrap gap-3">
            <OutcomeStamp outcome="verified" />
            <OutcomeStamp outcome="verified_with_warnings" />
            <OutcomeStamp outcome="failed_checks" />
            <OutcomeStamp outcome="not_found" />
            <OutcomeStamp outcome="unable_to_verify" />
            <OutcomeStamp outcome={null} status="processing" />
          </div>
          <div className="flex flex-wrap gap-3">
            {['invited', 'onboarding', 'pending_review', 'approved', 'rejected', 'suspended', 'offboarded'].map((s) => (
              <SupplierStatusStamp key={s} status={s} />
            ))}
            <Stamp tone="caution">Expires in 9 days</Stamp>
          </div>
        </section>

        <section aria-labelledby="messages" className="flex flex-col gap-4">
          <h2 id="messages" className="text-2xl font-bold">
            Messages
          </h2>
          <Callout tone="verified" title="Acme Trading is verified" announce={false}>
            Registered and in business on the CIPC register, VAT-registered, and tax compliant as of 16 November 2026.
          </Callout>
          <Callout tone="caution" title="The tax compliance PIN expires in 9 days" announce={false}>
            Ask the supplier for a new PIN before 25 November so payments are not locked.
          </Callout>
          <Callout tone="refused" title="This supplier was not found on the CIPC register" announce={false}>
            Check the registration number with the supplier. If it is right, the company may have been deregistered.
          </Callout>
          <Callout tone="info" title="Checks are answered by test data in the sandbox" announce={false} />
        </section>

        <section aria-labelledby="records" className="flex flex-col gap-4">
          <h2 id="records" className="text-2xl font-bold">
            Records
          </h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Checks this month" value="128" detail="94% verified" href="/design-system#records" linkLabel="See the checks" />
            <Stat label="Expiring in 30 days" value="7" detail="3 tax compliance PINs, 4 B-BBEE affidavits" />
            <Stat label="Wallet balance" value="R1 250,00" detail="About 416 company checks" />
          </div>
          <Sheet title="Acme Trading (Pty) Ltd" description="Facts as of 16 November 2026, 09:30" id="record-demo">
            <RecordList
              items={[
                { label: 'Registration number', value: <span className="font-mono">2019/123456/07</span> },
                { label: 'Status on the CIPC register', value: 'In business', note: 'As of 16 Nov 2026' },
                { label: 'VAT number', value: <span className="font-mono">4123456789</span> },
                { label: 'Tax compliance', value: 'Compliant', note: 'PIN expires 4 June 2027' },
                { label: 'B-BBEE level', value: 'Level 2 (125% recognition)' },
                { label: 'Trading name', value: null },
              ]}
            />
          </Sheet>
          <div className="grid gap-6 lg:grid-cols-2">
            <Sheet title="Onboarding" headingLevel={2}>
              <Steps steps={['Consent', 'Company', 'Documents', 'Tax PIN', 'Review']} current={2} />
            </Sheet>
            <Sheet title="Recent activity">
              <Timeline
                items={[
                  { id: 1, title: 'Supplier approved by Thandi Mokoena', when: '16 Nov 2026, 09:41' },
                  { id: 2, title: 'Company check: verified', when: '16 Nov 2026, 09:30', detail: 'R3,00 from the wallet' },
                  { id: 3, title: 'Supplier added', when: '16 Nov 2026, 09:29' },
                ]}
              />
            </Sheet>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <Sheet title="Progress">
              <div className="flex flex-col gap-5">
                <Meter label="Data-subject request clock" value={9} max={30} valueText="9 of 30 days used" tone="pending" />
                <Meter label="Wallet held for checks in progress" value={6} max={100} valueText="R6,00 held" tone="caution" />
                <Spinner label="Checking the CIPC register" />
                <div className="flex flex-col gap-2" aria-hidden="true">
                  <Skeleton className="h-5 w-2/3" />
                  <Skeleton className="h-5 w-1/2" />
                </div>
              </div>
            </Sheet>
            <EmptyState title="No suppliers yet">
              <p>Add a supplier by registration number, or send an onboarding link and let them fill in the details.</p>
            </EmptyState>
          </div>
        </section>

        <InteractiveCatalogue theme={theme} />
      </main>
      {/* The catalogue demonstrates toasts; the root layout no longer mounts a toaster. */}
      <Toaster />
    </>
  );
}
