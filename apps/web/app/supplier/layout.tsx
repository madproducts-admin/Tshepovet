import Link from 'next/link';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { Seal } from '@/components/brand/seal';
import { SpecimenBand } from '@/components/brand/specimen';
import { SkipLink } from '@/components/ui/layout';
import { getMeta } from '@/lib/server';

/** Supplier self-service: its own quiet chrome, so it is never mistaken for the buyer portal. */
export default async function SupplierLayout({ children }: { children: ReactNode }) {
  await connection();
  const meta = await getMeta();
  return (
    <>
      <SkipLink />
      <header className="border-b border-rule bg-sheet">
        {meta.sandbox ? <SpecimenBand /> : null}
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 sm:px-6">
          <Link href="/" className="inline-flex min-h-11 items-center gap-3 font-bold text-ink no-underline">
            <Seal size={36} />
            <span className="text-lg">TshepoVet</span>
          </Link>
          <span className="text-ink-2">for suppliers</span>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl px-4 pt-8 pb-16 sm:px-6">
        {children}
      </main>
      <footer className="mx-auto max-w-6xl px-4 pb-10 text-sm text-ink-2 sm:px-6">
        <nav aria-label="Help" className="flex flex-wrap gap-x-5">
          <Link href="/legal/privacy" className="inline-flex min-h-11 items-center">
            Privacy notice
          </Link>
          <Link href="/glossary" className="inline-flex min-h-11 items-center">
            Words we use
          </Link>
          <Link href="/verify-passport" className="inline-flex min-h-11 items-center">
            Check a supplier passport
          </Link>
        </nav>
      </footer>
    </>
  );
}
