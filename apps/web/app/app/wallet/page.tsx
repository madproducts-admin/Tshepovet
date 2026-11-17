import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RequirePermission } from '@/components/portal/shell';
import { WalletPage } from '@/components/portal/wallet';
import { getMeta } from '@/lib/server';

export const metadata: Metadata = { title: 'Wallet' };

export default async function Page() {
  // VAT is added only while TshepoVet's operator is a VAT vendor (0 until then).
  const { vat_rate } = await getMeta();
  return (
    <RequirePermission permission="wallet:read">
      <Suspense>
        <WalletPage vatRate={vat_rate} />
      </Suspense>
    </RequirePermission>
  );
}
