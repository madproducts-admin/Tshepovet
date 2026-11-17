import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Simulator } from '@/components/staff/simulator';

export const metadata: Metadata = { title: 'WhatsApp simulator' };

export default function Page() {
  return (
    <Suspense>
      <Simulator />
    </Suspense>
  );
}
