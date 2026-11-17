import type { Metadata } from 'next';
import { Bureaus } from '@/components/staff/console';

export const metadata: Metadata = { title: 'Bureaus and prices' };

export default function Page() {
  return <Bureaus />;
}
