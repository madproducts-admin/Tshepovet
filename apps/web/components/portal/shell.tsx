'use client';

import {
  Boxes,
  Building2,
  CalendarClock,
  ChevronDown,
  FileCheck2,
  KeyRound,
  LayoutGrid,
  LogOut,
  Menu as MenuIcon,
  ScrollText,
  Settings,
  UserRound,
  Users,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import type { Permission } from '@tshepovet/contracts';
import { Seal } from '@/components/brand/seal';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/feedback';
import { Dialog, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/overlay';
import { railItem, SidebarToggle, sidebarAside, sidebarGrid, useSidebarCollapsed } from '@/components/ui/sidebar';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { SessionProvider, useSession } from '@/lib/queries';

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutGrid;
  permission?: Permission;
  exact?: boolean;
}

/** The portal's sections, in the order of a supplier's life: find, check, watch, pay, prove. */
const NAV: NavItem[] = [
  { href: '/app', label: 'Overview', icon: LayoutGrid, permission: 'suppliers:read', exact: true },
  { href: '/app/suppliers', label: 'Suppliers', icon: Building2, permission: 'suppliers:read' },
  { href: '/app/checks', label: 'Checks', icon: FileCheck2, permission: 'suppliers:read' },
  { href: '/app/monitoring', label: 'Monitoring', icon: CalendarClock, permission: 'suppliers:read' },
  { href: '/app/modules', label: 'Modules', icon: Boxes },
  { href: '/app/wallet', label: 'Wallet', icon: Wallet, permission: 'wallet:read' },
  { href: '/app/developers', label: 'Developers', icon: KeyRound, permission: 'developers:manage' },
  { href: '/app/team', label: 'Team', icon: Users, permission: 'team:read' },
  { href: '/app/compliance', label: 'Compliance', icon: ScrollText, permission: 'compliance:read' },
  { href: '/app/settings', label: 'Settings', icon: Settings },
];

function NavLinks({ onNavigate, compact = false }: { onNavigate?: () => void; compact?: boolean }) {
  const pathname = usePathname();
  const { can } = useSession();
  return (
    <ul className="flex flex-col gap-0.5">
      {NAV.filter((n) => !n.permission || can(n.permission)).map((n) => {
        const active = n.exact ? pathname === n.href : pathname === n.href || pathname.startsWith(`${n.href}/`);
        const Icon = n.icon;
        return (
          <li key={n.href}>
            <Link
              href={n.href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex min-h-11 items-center rounded-control font-semibold no-underline transition-colors',
                compact ? railItem : 'gap-3 px-3',
                active ? 'bg-violet-tint text-ink shadow-[inset_3px_0_0_var(--violet)]' : 'text-ink-2 hover:bg-sheet-2 hover:text-ink',
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

function UserMenu({ compact = false }: { compact?: boolean }) {
  const { session } = useSession();
  const signOut = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.assign('/sign-in');
  };
  return (
    <Menu>
      <MenuTrigger asChild>
        {compact ? (
          // The rail: the visible word "Account" starts the accessible name (WCAG 2.5.3).
          <button type="button" className={cn('flex min-h-11 w-full items-center rounded-control font-semibold text-ink-2 hover:bg-sheet-2 hover:text-ink', railItem)}>
            <UserRound className="size-5 shrink-0" aria-hidden="true" />
            <span>Account</span>
            <span className="sr-only">
              {' '}
              menu for {session.user.full_name}, {session.user.email}
            </span>
          </button>
        ) : (
          <button
            type="button"
            className="flex min-h-11 w-full items-center gap-3 rounded-control px-3 py-2 text-left hover:bg-sheet-2"
          >
            {/* The visible name and email are the accessible name too (WCAG 2.5.3), after a hidden prefix. */}
            <span className="sr-only">Account menu for </span>
            <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-violet-tint font-bold text-violet">
              {session.user.full_name
                .split(/\s+/)
                .slice(0, 2)
                .map((w) => w[0])
                .join('')}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">{session.user.full_name}</span>
              <span className="block truncate text-sm text-ink-2">{session.user.email}</span>
            </span>
            <ChevronDown className="size-4 shrink-0 text-ink-2" aria-hidden="true" />
          </button>
        )}
      </MenuTrigger>
      <MenuContent align="start" side="top">
        <MenuLabel>{session.organisation.legal_name}</MenuLabel>
        <MenuItem asChild>
          <Link href="/app/account" className="no-underline text-ink">
            <UserRound aria-hidden="true" />
            Your account
          </Link>
        </MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={signOut}>
          <LogOut aria-hidden="true" />
          Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  const { session } = useSession();
  return (
    <Link href="/app" className={cn('flex min-h-11 items-center gap-3 rounded-control px-1 text-ink no-underline', compact && 'justify-center')}>
      <Seal size={40} />
      <span className={compact ? 'sr-only' : 'min-w-0'}>
        <span className="block text-lg leading-tight font-bold">TshepoVet</span>
        <span className="block truncate text-sm text-ink-2">{session.organisation.legal_name}</span>
      </span>
    </Link>
  );
}

function Frame({ band, children }: { band: ReactNode; children: ReactNode }) {
  const { session } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useSidebarCollapsed('tv.sidebar.portal');
  const mustEnrol = session.stage === 'mfa_setup' && pathname !== '/app/mfa-setup';
  useEffect(() => {
    if (mustEnrol) router.replace('/app/mfa-setup');
  }, [mustEnrol, router]);

  return (
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
            <nav aria-label="Portal">{session.stage === 'full' ? <NavLinks onNavigate={() => setMenuOpen(false)} /> : null}</nav>
            <div className="mt-4 border-t border-rule pt-4">
              <UserMenu />
            </div>
          </Dialog>
        </div>
      </header>
      <div className={sidebarGrid(collapsed)}>
        <aside className={sidebarAside(collapsed)}>
          <Brand compact={collapsed} />
          <nav id="portal-nav" aria-label="Portal" className="min-h-0 flex-1 overflow-y-auto">
            {session.stage === 'full' ? <NavLinks compact={collapsed} /> : null}
          </nav>
          <div className="flex flex-col gap-1 border-t border-rule pt-3">
            <SidebarToggle collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} controls="portal-nav" />
            <UserMenu compact={collapsed} />
          </div>
        </aside>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[90rem] px-4 py-8 outline-none sm:px-8 lg:px-10">
          {mustEnrol ? <Spinner label="Opening two-step verification setup" /> : children}
        </main>
      </div>
    </div>
  );
}

export function PortalShell({ band, children }: { band: ReactNode; children: ReactNode }) {
  return (
    <SessionProvider
      fallback={
        <div className="grid min-h-dvh place-items-center">
          <Spinner label="Opening TshepoVet" />
        </div>
      }
    >
      <Frame band={band}>{children}</Frame>
    </SessionProvider>
  );
}

/** Shows its children only to roles with the permission; others get a plain explanation. */
export function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can } = useSession();
  if (can(permission)) return <>{children}</>;
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-3xl font-bold">You cannot open this page</h1>
      <p className="text-lg text-ink-2">Your role does not include it. Ask an administrator of your organisation if you need it.</p>
      <p>
        <Link href="/app">Go to the overview</Link>
      </p>
    </div>
  );
}
