import type { Metadata } from 'next';
import { TenantDetail } from '@/components/staff/console';

export const metadata: Metadata = { title: 'Tenant' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <TenantDetail id={(await params).id} />;
}
