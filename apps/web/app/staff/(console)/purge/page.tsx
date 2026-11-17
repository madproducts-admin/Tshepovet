import type { Metadata } from 'next';
import { PurgeRuns } from '@/components/staff/console';

export const metadata: Metadata = { title: 'Purge runs' };

export default function Page() {
  return <PurgeRuns />;
}
