import type { Metadata } from 'next';
import { WebhookDetail } from '@/components/portal/developers';
import { RequirePermission } from '@/components/portal/shell';

export const metadata: Metadata = { title: 'Webhook endpoint' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequirePermission permission="developers:manage">
      <WebhookDetail id={id} />
    </RequirePermission>
  );
}
