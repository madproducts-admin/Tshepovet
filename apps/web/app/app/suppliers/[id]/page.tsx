import type { Metadata } from 'next';
import { RequirePermission } from '@/components/portal/shell';
import { SupplierRecord } from '@/components/portal/supplier-record';

export const metadata: Metadata = { title: 'Supplier' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequirePermission permission="suppliers:read">
      <SupplierRecord id={id} />
    </RequirePermission>
  );
}
