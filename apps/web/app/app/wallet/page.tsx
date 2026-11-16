import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RequirePermission } from '@/components/portal/shell';
import { WalletPage } from '@/components/portal/wallet';

export const metadata: Metadata = { title: 'Wallet' };

export default function Page() {
  return (
    <RequirePermission permission="wallet:read">
      <Suspense>
        <WalletPage />
      </Suspense>
    </RequirePermission>
  );
}
