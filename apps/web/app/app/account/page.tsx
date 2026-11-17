import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { AccountPage } from '@/components/portal/account';
import { THEME_COOKIE, type ThemeChoice } from '@/lib/theme';

export const metadata: Metadata = { title: 'Your account' };

export default async function Page() {
  const theme = ((await cookies()).get(THEME_COOKIE)?.value ?? 'system') as ThemeChoice;
  return <AccountPage theme={theme} />;
}
