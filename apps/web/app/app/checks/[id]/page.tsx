import type { Metadata } from 'next';
import { CheckResult } from '@/components/portal/checks';
import { RequirePermission } from '@/components/portal/shell';

export const metadata: Metadata = { title: 'Check result' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequirePermission permission="suppliers:read">
      <CheckResult id={id} />
    </RequirePermission>
  );
}
