import type { Metadata } from 'next';
import { MfaSetupPage } from '@/components/portal/account';

export const metadata: Metadata = { title: 'Set up two-step verification' };

export default function Page() {
  return <MfaSetupPage />;
}
