import Link from 'next/link';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { CompanyDisclosure } from '@/components/brand/company';
import { Seal } from '@/components/brand/seal';
import { SpecimenBand } from '@/components/brand/specimen';
import { SkipLink } from '@/components/ui/layout';
import { getMeta } from '@/lib/server';

/** Signing in, signing up and recovering an account: one quiet column on the paper. */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  await connection();
  const meta = await getMeta();
  return (
    <>
      <SkipLink />
      <header>
        {meta.sandbox ? <SpecimenBand /> : null}
        <div className="mx-auto flex max-w-6xl items-center px-4 py-4 sm:px-6">
          <Link href="/" className="inline-flex min-h-11 items-center gap-3 font-bold text-ink no-underline">
            <Seal size={36} />
            <span className="text-lg">TshepoVet</span>
          </Link>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-md px-4 pt-6 pb-16 sm:px-6">
        {children}
      </main>
      <footer className="mx-auto max-w-md px-4 pb-10 text-sm text-ink-2 sm:px-6">
        <nav aria-label="Help" className="flex flex-wrap gap-x-5">
          <Link href="/glossary" className="inline-flex min-h-11 items-center">
            Words we use
          </Link>
          <Link href="/legal/privacy" className="inline-flex min-h-11 items-center">
            Privacy notice
          </Link>
          <a href="/docs/" className="inline-flex min-h-11 items-center">
            API documentation
          </a>
        </nav>
        <CompanyDisclosure seller={meta.seller} className="mt-3" />
      </footer>
    </>
  );
}
