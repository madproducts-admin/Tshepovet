import type { Metadata } from 'next';
import { Tenants } from '@/components/staff/console';

export const metadata: Metadata = { title: 'Tenants' };

export default function Page() {
  return <Tenants />;
}
