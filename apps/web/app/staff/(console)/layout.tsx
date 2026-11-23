import type { Metadata } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { SpecimenBand } from '@/components/brand/specimen';
import { StaffShell } from '@/components/staff/shell';
import { AreaProviders } from '@/lib/queries';
import { getMeta } from '@/lib/server';

export const metadata: Metadata = { title: { default: 'Staff console', template: '%s | TshepoVet staff' }, robots: { index: false, follow: false } };

/** The staff console (/staff, docs/PLAN.md M8). */
export default async function StaffLayout({ children }: { children: ReactNode }) {
  await connection();
  const meta = await getMeta();
  return (
    <AreaProviders>
      <StaffShell band={meta.sandbox ? <SpecimenBand /> : null}>{children}</StaffShell>
    </AreaProviders>
  );
}
