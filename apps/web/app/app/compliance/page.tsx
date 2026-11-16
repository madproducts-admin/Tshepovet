import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RequirePermission } from '@/components/portal/shell';
import { CompliancePage } from '@/components/portal/compliance';

export const metadata: Metadata = { title: 'Compliance' };

export default function Page() {
  return (
    <RequirePermission permission="compliance:read">
      <Suspense>
        <CompliancePage />
      </Suspense>
    </RequirePermission>
  );
}
