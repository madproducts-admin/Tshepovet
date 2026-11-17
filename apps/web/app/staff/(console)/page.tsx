import type { Metadata } from 'next';
import { StaffOverview } from '@/components/staff/console';

export const metadata: Metadata = { title: 'Overview' };

export default function Page() {
  return <StaffOverview />;
}
