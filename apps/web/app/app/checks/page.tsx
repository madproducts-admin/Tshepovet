import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ChecksPage } from '@/components/portal/checks';
import { RequirePermission } from '@/components/portal/shell';

export const metadata: Metadata = { title: 'Checks' };

export default function Page() {
  return (
    <RequirePermission permission="suppliers:read">
      <Suspense>
        <ChecksPage />
      </Suspense>
    </RequirePermission>
  );
}
