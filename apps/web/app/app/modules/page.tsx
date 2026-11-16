import type { Metadata } from 'next';
import { ModulesPage } from '@/components/portal/modules';

export const metadata: Metadata = { title: 'Modules' };

export default function Page() {
  return <ModulesPage />;
}
