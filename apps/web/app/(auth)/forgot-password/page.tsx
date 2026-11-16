import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ForgotPassword } from '@/components/auth/forms';

export const metadata: Metadata = { title: 'Reset your password' };

export default function Page() {
  return (
    <Suspense>
      <ForgotPassword />
    </Suspense>
  );
}
