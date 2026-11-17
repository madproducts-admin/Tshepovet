import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RequirePermission } from '@/components/portal/shell';
import { AuditPage } from '@/components/portal/compliance';

export const metadata: Metadata = { title: 'Audit log' };

export default function Page() {
  return (
    <RequirePermission permission="audit:read">
      <Suspense>
        <AuditPage />
      </Suspense>
    </RequirePermission>
  );
}
