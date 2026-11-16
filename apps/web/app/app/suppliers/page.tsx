import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RequirePermission } from '@/components/portal/shell';
import { SuppliersPage } from '@/components/portal/suppliers';

export const metadata: Metadata = { title: 'Suppliers' };

export default function Page() {
  return (
    <RequirePermission permission="suppliers:read">
      <Suspense>
        <SuppliersPage />
      </Suspense>
    </RequirePermission>
  );
}
