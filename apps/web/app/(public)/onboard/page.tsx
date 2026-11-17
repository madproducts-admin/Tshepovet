import type { Metadata } from 'next';
import { Onboarding } from '@/components/supplier/onboarding';

export const metadata: Metadata = { title: 'Supplier onboarding' };

export default function Page() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Onboarding />
    </div>
  );
}
