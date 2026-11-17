import type { Metadata } from 'next';
import { SupplierSignIn } from '@/components/supplier/self-service';

export const metadata: Metadata = { title: 'Sign in as a supplier' };

export default function Page() {
  return (
    <div className="mx-auto max-w-md">
      <SupplierSignIn />
    </div>
  );
}
