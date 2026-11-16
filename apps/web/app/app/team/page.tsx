import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RequirePermission } from '@/components/portal/shell';
import { TeamPage } from '@/components/portal/team';

export const metadata: Metadata = { title: 'Team' };

export default function Page() {
  return (
    <RequirePermission permission="team:read">
      <Suspense>
        <TeamPage />
      </Suspense>
    </RequirePermission>
  );
}
