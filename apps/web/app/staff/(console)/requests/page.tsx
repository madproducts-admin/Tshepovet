import type { Metadata } from 'next';
import { Requests } from '@/components/staff/console';

export const metadata: Metadata = { title: 'Data requests' };

export default function Page() {
  return <Requests />;
}
