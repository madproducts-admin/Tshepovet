'use client';

import { useQuery } from '@tanstack/react-query';
import { Building2, ClipboardCheck, Inbox, LayoutGrid, LogOut, Mail, Menu as MenuIcon, MessageSquare, Server, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import type { StaffRole } from '@tshepovet/contracts';
import { Seal } from '@/components/brand/seal';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/feedback';
import { Dialog } from '@/components/ui/overlay';
import { type ApiProblem, setStaffCsrfToken, staffApi } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * The staff console's frame (/staff, docs/PLAN.md M8): TshepoVet's own people, with their own
 * accounts and sessions. Deliberately plainer than the portal, and always labelled as the
 * staff console, so nobody mistakes it for a customer's view.
 */
export interface StaffSession {
  staff: { id: string; email: string; full_name: string; role: StaffRole; mfa_enrolled: boolean };
  stage: 'full' | 'mfa_setup';
  csrf_token: string;
}

const Ctx = createContext<StaffSession | null>(null);
export function useStaffSession(): StaffSession {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStaffSession outside StaffShell');
  return s;
}
export const hasRole = (s: StaffSession, roles?: StaffRole[]) => !roles || roles.includes(s.staff.role);

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutGrid;
  roles?: StaffRole[];
  exact?: boolean;
}
export const STAFF_NAV: NavItem[] = [
  { href: '/staff', label: 'Overview', icon: LayoutGrid, exact: true },
  { href: '/staff/review', label: 'Review queue', icon: ClipboardCheck, roles: ['reviewer', 'admin'] },
  { href: '/staff/tenants', label: 'Tenants', icon: Building2, roles: ['support', 'admin'] },
  { href: '/staff/requests', label: 'Data requests', icon: Inbox, roles: ['support', 'admin'] },
  { href: '/staff/whatsapp', label: 'WhatsApp simulator', icon: MessageSquare },
  { href: '/staff/mail', label: 'Mail outbox', icon: Mail, roles: ['support', 'admin'] },
  { href: '/staff/bureaus', label: 'Bureaus and prices', icon: Server, roles: ['admin'] },
  { href: '/staff/purge', label: 'Purge runs', icon: Trash2, roles: ['admin'] },
];

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const s = useStaffSession();
  const pathname = usePathname();
  return (
    <ul className="flex flex-col gap-0.5">
      {STAFF_NAV.filter((n) => hasRole(s, n.roles)).map((n) => {
        const active = n.exact ? pathname === n.href : pathname === n.href || pathname.startsWith(`${n.href}/`);
        const Icon = n.icon;
        return (
          <li key={n.href}>
            <Link
              href={n.href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex min-h-11 items-center gap-3 rounded-control px-3 font-semibold no-underline',
                active ? 'bg-petrol-tint text-ink shadow-[inset_3px_0_0_var(--petrol)]' : 'text-ink-2 hover:bg-sheet-2 hover:text-ink',
              )}
            >
              <Icon className="size-5 shrink-0" aria-hidden="true" />
              {n.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function Who() {
  const s = useStaffSession();
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-2 border-t border-rule pt-4">
      <p className="min-w-0">
        <span className="block truncate font-semibold">{s.staff.full_name}</span>
        <span className="block truncate text-sm text-ink-2">
          {s.staff.email}, {s.staff.role}
        </span>
      </p>
      <Button
        intent="secondary"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          await staffApi('/api/staff/auth/logout', { method: 'POST' }).catch(() => undefined);
          setStaffCsrfToken(null);
          window.location.assign('/staff/sign-in');
        }}
      >
        <LogOut aria-hidden="true" />
        Sign out
      </Button>
    </div>
  );
}

function Brand() {
  return (
    <Link href="/staff" className="flex min-h-11 items-center gap-3 rounded-control px-1 text-ink no-underline">
      <Seal size={40} />
      <span>
        <span className="block text-lg leading-tight font-bold">TshepoVet</span>
        <span className="block text-sm font-semibold text-petrol">Staff console</span>
      </span>
    </Link>
  );
}

export function StaffShell({ band, children }: { band: ReactNode; children: ReactNode }) {
  const q = useQuery<StaffSession, ApiProblem>({ queryKey: ['staff-session'], queryFn: () => staffApi<StaffSession>('/api/staff/auth/session'), retry: false, staleTime: 60_000 });
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (q.data) setStaffCsrfToken(q.data.csrf_token);
    // Two-step verification is mandatory for staff: enrolment happens on the sign-in page.
    if (q.data?.stage === 'mfa_setup') window.location.assign('/staff/sign-in');
  }, [q.data]);
  useEffect(() => {
    if (q.error?.status === 401) window.location.assign('/staff/sign-in');
  }, [q.error]);
  if (!q.data || q.data.stage !== 'full') {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner label="Opening the staff console" />
      </div>
    );
  }
  return (
    <Ctx.Provider value={q.data}>
      <div className="min-h-dvh">
        <a href="#main" className="sr-only z-[60] rounded-control bg-violet px-4 py-3 font-semibold text-on-violet focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
          Skip to main content
        </a>
        <header>
          {band}
          <div className="flex items-center justify-between gap-3 border-b border-rule bg-sheet px-4 py-2 lg:hidden">
            <Brand />
            <Dialog
              open={menuOpen}
              onOpenChange={setMenuOpen}
              title="Menu"
              trigger={
                <Button intent="secondary" aria-label="Open the menu">
                  <MenuIcon aria-hidden="true" />
                  Menu
                </Button>
              }
            >
              <nav aria-label="Staff console">
                <Nav onNavigate={() => setMenuOpen(false)} />
              </nav>
              <div className="mt-4">
                <Who />
              </div>
            </Dialog>
          </div>
        </header>
        <div className="lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]">
          <aside className="sticky top-0 hidden h-dvh flex-col gap-6 border-r border-rule bg-sheet px-3 py-5 lg:flex">
            <Brand />
            <nav aria-label="Staff console" className="min-h-0 flex-1 overflow-y-auto">
              <Nav />
            </nav>
            <Who />
          </aside>
          <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[90rem] px-4 py-8 outline-none sm:px-8 lg:px-10">
            {children}
          </main>
        </div>
      </div>
    </Ctx.Provider>
  );
}

/** A page some roles may not open: a plain explanation instead of an error. */
export function RequireRole({ roles, children }: { roles: StaffRole[]; children: ReactNode }) {
  const s = useStaffSession();
  if (hasRole(s, roles)) return <>{children}</>;
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-3xl font-bold">Your staff role cannot open this page</h1>
      <p className="text-lg text-ink-2">It is for {roles.join(' and ')} staff.</p>
      <p>
        <Link href="/staff">Go to the overview</Link>
      </p>
    </div>
  );
}
