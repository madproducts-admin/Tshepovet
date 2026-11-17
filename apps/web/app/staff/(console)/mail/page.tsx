import type { Metadata } from 'next';
import { MailOutbox } from '@/components/staff/console';

export const metadata: Metadata = { title: 'Mail outbox' };

export default function Page() {
  return <MailOutbox />;
}
