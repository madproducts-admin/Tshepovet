import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RunCheck } from '@/components/portal/checks';
import { RequirePermission } from '@/components/portal/shell';

export const metadata: Metadata = { title: 'Run a check' };

export default function Page() {
  return (
    <RequirePermission permission="checks:run">
      <Suspense>
        <RunCheck />
      </Suspense>
    </RequirePermission>
  );
}
