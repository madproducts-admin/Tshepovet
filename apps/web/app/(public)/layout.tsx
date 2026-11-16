import Link from 'next/link';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { Seal } from '@/components/brand/seal';
import { SpecimenBand } from '@/components/brand/specimen';
import { SkipLink } from '@/components/ui/layout';
import { getMeta } from '@/lib/server';

/** Public pages: the landing page, pricing, the glossary, legal text, supplier passports. */
export default async function PublicLayout({ children }: { children: ReactNode }) {
  await connection();
  const meta = await getMeta();
  return (
    <>
      <SkipLink />
      <header className="border-b border-rule bg-sheet">
        {meta.sandbox ? <SpecimenBand /> : null}
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link href="/" className="inline-flex min-h-11 items-center gap-3 text-ink no-underline">
            <Seal size={36} />
            <span className="text-lg font-bold">TshepoVet</span>
          </Link>
          <nav aria-label="Site">
            <ul className="flex flex-wrap items-center gap-x-5 gap-y-1">
              <li>
                <Link href="/pricing" className="inline-flex min-h-11 items-center font-semibold">
                  Pricing
                </Link>
              </li>
              <li>
                <a href="/docs/" className="inline-flex min-h-11 items-center font-semibold">
                  API documentation
                </a>
              </li>
              <li>
                <Link href="/sign-in" className="inline-flex min-h-11 items-center font-semibold">
                  Sign in
                </Link>
              </li>
              <li>
                <Link href="/sign-up" className="inline-flex min-h-11 items-center rounded-control bg-violet px-4 font-semibold text-on-violet no-underline hover:bg-violet-strong">
                  Create an account
                </Link>
              </li>
            </ul>
          </nav>
        </div>
      </header>
      <main id="main">{children}</main>
      <footer className="mt-16 border-t border-rule bg-sheet">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-ink-2 sm:px-6">
          <nav aria-label="Footer">
            <ul className="flex flex-wrap gap-x-6">
              <li>
                <Link href="/glossary" className="inline-flex min-h-11 items-center">
                  Words we use
                </Link>
              </li>
              <li>
                <Link href="/legal/privacy" className="inline-flex min-h-11 items-center">
                  Privacy notice
                </Link>
              </li>
              <li>
                <Link href="/legal/terms" className="inline-flex min-h-11 items-center">
                  Terms of use
                </Link>
              </li>
              <li>
                <Link href="/verify-passport" className="inline-flex min-h-11 items-center">
                  Check a supplier passport
                </Link>
              </li>
              <li>
                <Link href="/design-system" className="inline-flex min-h-11 items-center">
                  Design system
                </Link>
              </li>
            </ul>
          </nav>
          <p>TshepoVet checks South African suppliers. Information is processed in line with POPIA.</p>
        </div>
      </footer>
    </>
  );
}
