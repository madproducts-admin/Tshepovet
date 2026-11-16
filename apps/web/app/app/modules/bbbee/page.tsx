import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RequirePermission } from '@/components/portal/shell';
import { BbbeePage } from '@/components/portal/modules';

export const metadata: Metadata = { title: 'B-BBEE scorecard' };

export default function Page() {
  return (
    <RequirePermission permission="modules:use">
      <Suspense>
        <BbbeePage />
      </Suspense>
    </RequirePermission>
  );
}
