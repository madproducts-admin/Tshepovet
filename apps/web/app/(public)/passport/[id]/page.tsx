import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import QRCode from 'qrcode';
import { cache } from 'react';
import { Callout, Stamp } from '@/components/ui/feedback';
import { Sheet } from '@/components/ui/layout';
import { PassportSheet } from '@/components/supplier/passport-sheet';
import { PrintButton } from '@/components/supplier/print-button';
import { getPassport, PUBLIC_ORIGIN } from '@/lib/server';

/**
 * A supplier's public Verified Vendor Passport. No sign-in; shown only while the supplier keeps
 * it published (the API answers 410 once withdrawn, and this page says so). Not indexed by
 * search engines: the supplier shares the link, it is not a directory.
 */
const load = cache(getPassport);

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const r = await load((await params).id);
  const robots = { index: false, follow: false };
  if (r.kind === 'ok') return { title: `${r.passport.legal_name ?? 'Supplier'}: Verified Vendor Passport`, robots };
  return { title: r.kind === 'withdrawn' ? 'Passport withdrawn' : 'Verified Vendor Passport', robots };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await load(id);
  if (r.kind === 'missing') notFound();
  return <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 print:max-w-none print:p-0">{await body(id, r)}</div>;
}

async function body(id: string, r: Exclude<Awaited<ReturnType<typeof getPassport>>, { kind: 'missing' }>) {
  if (r.kind === 'withdrawn') {
    return (
      <Sheet>
        <div className="flex flex-col items-start gap-3">
          <Stamp tone="neutral">Withdrawn</Stamp>
          <h1 className="text-3xl font-bold">This passport was withdrawn</h1>
          <p>The supplier has withdrawn it, or TshepoVet suspended it. A printed copy of it is no longer current.</p>
          <p>Ask the supplier for their current details, or check them yourself with a TshepoVet account.</p>
        </div>
      </Sheet>
    );
  }
  if (r.kind === 'unavailable') {
    return (
      <Callout tone="caution" title="The passport could not be loaded">
        <p>TshepoVet could not be reached just now. Reload the page in a minute.</p>
      </Callout>
    );
  }
  const url = `${PUBLIC_ORIGIN}/passport/${id.toLowerCase()}`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#10242c', light: '#ffffff' } });
  return (
    <div className="flex flex-col gap-6">
      <PassportSheet p={r.passport} qr={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`} />
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 print:hidden">
        <PrintButton />
        <Link href="/verify-passport" className="inline-flex min-h-11 items-center font-semibold">
          Check a printed copy
        </Link>
      </div>
      <p className="max-w-[68ch] text-sm text-ink-2 print:hidden">
        TshepoVet verified these facts with the CIPC register, SARS and licensed South African bureaus on the date shown. They describe the company on that date; for
        decisions that depend on today’s facts, check the supplier yourself.
      </p>
    </div>
  );
}
