import type { Metadata } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { SpecimenBand } from '@/components/brand/specimen';
import { PortalShell } from '@/components/portal/shell';
import { AreaProviders } from '@/lib/queries';
import { getMeta } from '@/lib/server';

export const metadata: Metadata = { title: { default: 'Overview', template: '%s | TshepoVet' } };

/** The buyer portal (/app): the shell is rendered here, each page fetches its own data. */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  await connection();
  const meta = await getMeta();
  return (
    <AreaProviders>
      <PortalShell band={meta.sandbox ? <SpecimenBand /> : null}>{children}</PortalShell>
    </AreaProviders>
  );
}
