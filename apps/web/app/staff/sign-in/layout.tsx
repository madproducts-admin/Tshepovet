import type { Metadata } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { Seal } from '@/components/brand/seal';
import { SpecimenBand } from '@/components/brand/specimen';
import { SkipLink } from '@/components/ui/layout';
import { getMeta } from '@/lib/server';

export const metadata: Metadata = { title: 'Staff sign-in', robots: { index: false, follow: false } };

/** The staff sign-in: one quiet column, labelled as the staff console. */
export default async function StaffSignInLayout({ children }: { children: ReactNode }) {
  await connection();
  const meta = await getMeta();
  return (
    <>
      <SkipLink />
      <header>
        {meta.sandbox ? <SpecimenBand /> : null}
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-4 sm:px-6">
          <Seal size={36} />
          <span>
            <span className="block text-lg leading-tight font-bold">TshepoVet</span>
            <span className="block text-sm font-semibold text-petrol">Staff console</span>
          </span>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-md px-4 pt-6 pb-16 sm:px-6">
        {children}
      </main>
    </>
  );
}
