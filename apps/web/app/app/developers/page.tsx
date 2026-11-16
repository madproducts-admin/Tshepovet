import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RequirePermission } from '@/components/portal/shell';
import { DevelopersPage } from '@/components/portal/developers';

export const metadata: Metadata = { title: 'Developers' };

export default function Page() {
  return (
    <RequirePermission permission="developers:manage">
      <Suspense>
        <DevelopersPage />
      </Suspense>
    </RequirePermission>
  );
}
