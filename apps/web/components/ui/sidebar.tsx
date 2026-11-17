import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useCallback, useSyncExternalStore } from 'react';
import { cn } from '@/lib/cn';

/**
 * The collapsible left sidebar of the buyer portal and the staff console (the owner's answer to
 * Q1, 2026-11-17). On large screens it collapses to a rail: every section keeps its icon and its
 * name, set small under the icon, so nothing depends on hover (no tooltips to dismiss, WCAG
 * 1.4.13) and every target stays 44 pixels tall. Phones keep the Menu dialog.
 *
 * The choice is remembered per browser. Browser storage can be missing or refused (private
 * windows, blocked site data): then it lives in memory for the visit. The server always renders
 * the sidebar expanded, so the first render on the client matches it before the stored choice
 * applies (no hydration mismatch). Imported only by the client shells, so no 'use client' here.
 */
const memory = new Map<string, boolean>();
const listeners = new Set<() => void>();

function read(key: string): boolean {
  try {
    const v = window.localStorage.getItem(key);
    if (v !== null) return v === '1';
  } catch {
    /* storage refused: fall back to this visit's memory */
  }
  return memory.get(key) ?? false;
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

export function useSidebarCollapsed(key: string): [boolean, (collapsed: boolean) => void] {
  const collapsed = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => false,
  );
  const set = useCallback(
    (value: boolean) => {
      memory.set(key, value);
      try {
        window.localStorage.setItem(key, value ? '1' : '0');
      } catch {
        /* remembered for this visit only */
      }
      for (const l of listeners) l();
    },
    [key],
  );
  return [collapsed, set];
}

/** The rail's layout for a sidebar link or button: icon above a short name. */
export const railItem = 'flex-col justify-center gap-1 px-1 py-2 text-center text-xs leading-tight';

export function SidebarToggle({ collapsed, onToggle, controls }: { collapsed: boolean; onToggle: () => void; controls: string }) {
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-controls={controls}
      className={cn(
        'flex min-h-11 w-full items-center rounded-control font-semibold text-ink-2 hover:bg-sheet-2 hover:text-ink',
        collapsed ? railItem : 'gap-3 px-3',
      )}
    >
      <Icon className="size-5 shrink-0" aria-hidden="true" />
      {collapsed ? 'Expand menu' : 'Collapse menu'}
    </button>
  );
}

/** The grid that holds the sidebar and the page. The widths and the motion come from the design
 * reference (design/tokens.json: --layout-sidebar, --layout-rail, --motion-fast, --motion-ease). */
export const sidebarGrid = (collapsed: boolean) =>
  cn(
    'lg:grid motion-safe:transition-[grid-template-columns] motion-safe:duration-[var(--motion-fast)] motion-safe:ease-[var(--motion-ease)]',
    collapsed ? 'lg:grid-cols-[var(--layout-rail)_minmax(0,1fr)]' : 'lg:grid-cols-[var(--layout-sidebar)_minmax(0,1fr)]',
  );

export const sidebarAside = (collapsed: boolean) =>
  cn('sticky top-0 hidden h-dvh flex-col gap-6 border-r border-rule bg-sheet py-5 lg:flex', collapsed ? 'px-2' : 'px-3');
