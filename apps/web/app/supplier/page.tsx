import type { Metadata } from 'next';
import { SupplierPortal } from '@/components/supplier/self-service';

export const metadata: Metadata = { title: 'Your company’s record', robots: { index: false, follow: false } };

export default function Page() {
  return <SupplierPortal />;
}
