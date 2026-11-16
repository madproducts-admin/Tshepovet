import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RequirePermission } from '@/components/portal/shell';
import { MonitoringPage } from '@/components/portal/monitoring';

export const metadata: Metadata = { title: 'Monitoring' };

export default function Page() {
  return (
    <RequirePermission permission="suppliers:read">
      <Suspense>
        <MonitoringPage />
      </Suspense>
    </RequirePermission>
  );
}
