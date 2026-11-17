import type { ReactNode } from 'react';
import type { PublicPassport } from '@tshepovet/contracts';
import { GuillocheBand, Seal } from '@/components/brand/seal';
import { Stamp, type Tone } from '@/components/ui/feedback';
import { cn } from '@/lib/cn';
import { formatDay } from '@/lib/format';

/**
 * The Verified Vendor Passport as a document: the one place outside the brand mark where the
 * security-print vocabulary is used in full (the seal, an engraved border, a printed code).
 * Server-rendered and printable; the same sheet, overprinted "Specimen", shows the idea on
 * the landing page.
 */
const CIPC: Record<string, { tone: Tone; label: string }> = {
  in_business: { tone: 'verified', label: 'In business' },
  deregistration_process: { tone: 'caution', label: 'Being deregistered' },
  deregistered: { tone: 'refused', label: 'Deregistered' },
  in_liquidation: { tone: 'refused', label: 'In liquidation' },
  voluntary_liquidation: { tone: 'refused', label: 'In voluntary liquidation' },
  business_rescue: { tone: 'caution', label: 'In business rescue' },
  reinstatement_process: { tone: 'caution', label: 'Being reinstated' },
  ar_restoration: { tone: 'caution', label: 'Being restored' },
  converted: { tone: 'neutral', label: 'Converted' },
  dissolved: { tone: 'refused', label: 'Dissolved' },
  unknown: { tone: 'neutral', label: 'Not known' },
};
const TCS: Record<string, { tone: Tone; label: string }> = {
  compliant: { tone: 'verified', label: 'Tax compliant' },
  non_compliant: { tone: 'refused', label: 'Not tax compliant' },
};

/** "AB12…": the code in groups of four, so it can be read aloud and typed. */
export function groupCode(code: string): string {
  return code.replace(/-/g, '').replace(/(.{4})(?=.)/g, '$1 ');
}

function Fact({ label, children, note }: { label: ReactNode; children: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-t border-rule pt-3">
      <dt className="text-sm text-ink-2">{label}</dt>
      <dd className="font-semibold break-words">{children}</dd>
      {note ? <dd className="text-sm text-ink-2">{note}</dd> : null}
    </div>
  );
}

export function PassportSheet({
  p,
  qr,
  specimen,
  headingLevel = 1,
  footer,
}: {
  p: PublicPassport;
  /** An image of the QR code that opens this page (a data: URL). */
  qr?: string;
  /** Overprint "Specimen": sample data, not a real passport. */
  specimen?: boolean;
  headingLevel?: 1 | 2;
  footer?: ReactNode;
}) {
  const H = headingLevel === 1 ? 'h1' : 'h2';
  const cipc = p.cipc_status ? (CIPC[p.cipc_status] ?? { tone: 'neutral' as const, label: p.cipc_status }) : null;
  const tcs = p.tcs?.status ? (TCS[p.tcs.status] ?? { tone: 'caution' as const, label: 'Could not be confirmed' }) : null;
  return (
    <article
      aria-labelledby="passport-title"
      className="relative overflow-hidden rounded-sheet border-2 border-seal-1/40 bg-sheet shadow-sheet [print-color-adjust:exact] print:shadow-none"
    >
      <GuillocheBand width={960} height={28} className="h-7 w-full text-seal-1/45" />
      {specimen ? (
        <p
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 -rotate-12 text-[clamp(3rem,12vw,7rem)] font-bold whitespace-nowrap text-amber/15 select-none"
        >
          Specimen
        </p>
      ) : null}
      <div className="relative flex flex-col gap-6 px-5 py-6 sm:px-8 sm:py-8">
        <header className="flex flex-wrap items-center gap-5 sm:gap-7">
          <Seal size={112} verified label={specimen ? 'Specimen seal' : 'Verified by TshepoVet'} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="text-ink-2">{specimen ? 'Verified Vendor Passport (specimen)' : 'Verified Vendor Passport'}</p>
            <H id="passport-title" className="text-3xl font-bold break-words sm:text-4xl">
              {p.legal_name ?? 'A South African supplier'}
            </H>
            {p.registration_number ? <p className="font-mono text-lg">{p.registration_number}</p> : null}
          </div>
        </header>

        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {cipc ? (
            <Fact label="Status on the CIPC register">
              <Stamp tone={cipc.tone}>{cipc.label}</Stamp>
            </Fact>
          ) : null}
          {p.tcs ? (
            <Fact
              label="Tax compliance (SARS)"
              note={[p.tcs.expires_on ? `PIN valid until ${formatDay(p.tcs.expires_on)}` : null, p.tcs.checked_at ? `checked ${formatDay(p.tcs.checked_at)}` : null].filter(Boolean).join(', ') || undefined}
            >
              {tcs ? <Stamp tone={tcs.tone}>{tcs.label}</Stamp> : 'Not checked'}
            </Fact>
          ) : null}
          {p.vat_registered !== null ? <Fact label="VAT">{p.vat_registered ? 'Registered for VAT' : 'Not registered for VAT'}</Fact> : null}
          {p.bbbee ? (
            <Fact label="B-BBEE" note={`Evidence valid until ${formatDay(p.bbbee.valid_until)}`}>
              {p.bbbee.level ? `Level ${p.bbbee.level} contributor` : 'Non-compliant'}
            </Fact>
          ) : null}
          {p.directors ? (
            <Fact label="Directors (initials)" note="From the CIPC register.">
              {p.directors.length ? p.directors.join(', ') : 'None listed'}
            </Fact>
          ) : null}
          {p.verified_at ? <Fact label="Verified">{formatDay(p.verified_at)}</Fact> : null}
        </dl>

        <footer className="flex flex-wrap items-center gap-5 border-t-2 border-double border-rule pt-5">
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element -- a generated data: URL, nothing to optimise
            <img src={qr} alt="QR code that opens this passport" width={112} height={112} className="shrink-0 rounded-[3px] bg-white p-1" />
          ) : null}
          <div className={cn('flex min-w-0 flex-1 flex-col gap-1')}>
            <p className="text-sm text-ink-2">Verification code</p>
            <p className="font-mono text-lg font-bold tracking-wide break-all">{groupCode(p.verification_code)}</p>
            <p className="text-sm text-ink-2">
              To check a printed copy, enter this code at <span className="font-semibold text-ink">tshepovet.madproducts.ai/verify-passport</span>. The supplier chose
              what this passport shows and can withdraw it at any time.
            </p>
          </div>
        </footer>
        {footer}
      </div>
    </article>
  );
}
