import type { Metadata } from 'next';
import { ReviewQueue } from '@/components/staff/console';

export const metadata: Metadata = { title: 'Review queue' };

export default function Page() {
  return <ReviewQueue />;
}
