import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AcceptInvite } from '@/components/auth/forms';

export const metadata: Metadata = { title: 'Accept your invitation' };

export default function Page() {
  return (
    <Suspense>
      <AcceptInvite />
    </Suspense>
  );
}
