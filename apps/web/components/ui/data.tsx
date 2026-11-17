'use client';

import * as TabsPrimitive from '@radix-ui/react-tabs';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Copy, Eye, EyeOff } from 'lucide-react';
import { type ComponentProps, type ReactNode, useState } from 'react';
import { cn } from '@/lib/cn';
import { formatCount, formatDay, formatInstant, formatMoney, formatRelative } from '@/lib/format';
import { Button } from './button';

/**
 * Showing data: tables, pages, money, time, terms, secrets.
 */

// --- Values ----------------------------------------------------------------------------------
export function Money({ cents, whole, signed, className }: { cents: number; whole?: boolean; signed?: boolean; className?: string }) {
  const text = formatMoney(Math.abs(cents), whole);
  const sign = signed ? (cents > 0 ? '+' : cents < 0 ? '−' : '') : cents < 0 ? '−' : '';
  return (
    <span className={cn('tabular whitespace-nowrap', className)}>
      {sign}
      {text}
      {signed && cents !== 0 ? <span className="sr-only">{cents > 0 ? ' credit' : ' debit'}</span> : null}
    </span>
  );
}

/** A moment, read relatively ("3 days ago") with the exact time beside it for everyone. */
export function When({ value, day, showExact }: { value: string | Date; day?: boolean; showExact?: boolean }) {
  const exact = day ? formatDay(value) : formatInstant(value);
  if (day) return <time dateTime={typeof value === 'string' ? value : value.toISOString()}>{exact}</time>;
  return (
    // "3 days ago" is computed again in the browser and may differ by a moment from the server's.
    <time dateTime={new Date(value).toISOString()} title={exact} suppressHydrationWarning>
      {formatRelative(value)}
      {showExact ? <span className="text-ink-2"> ({exact})</span> : <span className="sr-only"> ({exact})</span>}
    </time>
  );
}

/** An abbreviation, expanded for screen readers (server-safe: see term.tsx). */
export { Term } from './term';

// --- Secrets ---------------------------------------------------------------------------------
/** A secret shown once (API key, webhook signing secret): hidden until asked, then copyable. */
export function SecretReveal({ label, secret }: { label: string; secret: string }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <p className="font-semibold">{label}</p>
      <div className="flex flex-wrap items-stretch gap-2">
        <code className="flex min-h-11 min-w-0 flex-1 items-center rounded-control border border-edge bg-sheet-2 px-3 font-mono text-sm break-all">
          {shown ? secret : `${secret.slice(0, Math.min(14, secret.indexOf('.') + 1 || 8))}${'•'.repeat(24)}`}
        </code>
        <Button intent="secondary" size="icon" onClick={() => setShown((s) => !s)} aria-label={shown ? 'Hide' : 'Show'} aria-pressed={shown}>
          {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </Button>
        <Button
          intent="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(secret);
            setCopied(true);
          }}
        >
          <Copy aria-hidden="true" />
          Copy
        </Button>
      </div>
      <p role="status" className="text-sm text-ink-2">
        {copied ? 'Copied. Store it somewhere safe now: TshepoVet will not show it again.' : 'TshepoVet will not show this again once you close this.'}
      </p>
    </div>
  );
}

export function CodeBlock({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="overflow-hidden rounded-sheet border border-rule">
      <div className="flex items-center justify-between border-b border-rule bg-sheet-2 px-4 py-1">
        <span className="text-sm font-semibold">{label}</span>
        <Button
          intent="quiet"
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(code);
            setCopied(true);
          }}
        >
          <Copy aria-hidden="true" />
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre tabIndex={0} aria-label={label} className="relative overflow-x-auto bg-sheet p-4 font-mono text-sm leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// --- Tables ----------------------------------------------------------------------------------
export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  sortable?: boolean;
  align?: 'start' | 'end';
  /** The column that names the row: rendered as a row header for screen readers. */
  rowHeader?: boolean;
  className?: string;
}

export interface SortState {
  sort?: string;
  order: 'asc' | 'desc';
}

/**
 * A data table: a real <table> with a caption, row headers and sortable column buttons that
 * announce their state (aria-sort). Wide tables scroll inside a focusable, labelled region.
 */
export function DataTable<T>({
  caption,
  captionHidden,
  columns,
  rows,
  rowKey,
  sort,
  onSort,
  empty,
}: {
  caption: string;
  captionHidden?: boolean;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  sort?: SortState;
  onSort?: (s: SortState) => void;
  empty?: ReactNode;
}) {
  return (
    <div role="region" aria-label={caption} tabIndex={0} className="relative overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <caption className={captionHidden ? 'sr-only' : 'px-5 pt-4 pb-2 text-left text-lg font-bold'}>{caption}</caption>
        <thead>
          <tr className="border-b-2 border-rule bg-sheet-2">
            {columns.map((c) => {
              const active = sort?.sort === c.key;
              const ariaSort = active ? (sort!.order === 'asc' ? 'ascending' : 'descending') : c.sortable ? 'none' : undefined;
              return (
                <th key={c.key} scope="col" aria-sort={ariaSort} className={cn('px-4 py-2 text-sm font-semibold whitespace-nowrap', c.align === 'end' && 'text-right', c.className)}>
                  {c.sortable && onSort ? (
                    <button
                      type="button"
                      onClick={() => onSort({ sort: c.key, order: active && sort!.order === 'desc' ? 'asc' : 'desc' })}
                      className={cn('-mx-2 inline-flex min-h-11 items-center gap-1.5 rounded-control px-2 font-semibold hover:bg-sheet', c.align === 'end' && 'flex-row-reverse')}
                    >
                      {c.header}
                      {active ? (
                        sort!.order === 'asc' ? (
                          <ArrowUp className="size-4" aria-hidden="true" />
                        ) : (
                          <ArrowDown className="size-4" aria-hidden="true" />
                        )
                      ) : (
                        <ChevronsUpDown className="size-4 text-ink-2" aria-hidden="true" />
                      )}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-8 text-ink-2">
                {empty ?? 'Nothing to show.'}
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={rowKey(r)} className="border-b border-rule last:border-b-0 hover:bg-sheet-2/60">
                {columns.map((c) => {
                  const Cell = c.rowHeader ? 'th' : 'td';
                  return (
                    <Cell key={c.key} scope={c.rowHeader ? 'row' : undefined} className={cn('px-4 py-3 align-top font-normal', c.align === 'end' && 'text-right tabular', c.className)}>
                      {c.cell(r)}
                    </Cell>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ page, pageSize, total, noun, onPage }: { page: number; pageSize: number; total: number; noun: [string, string]; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <p className="text-sm text-ink-2" aria-live="polite">
        {total === 0 ? `No ${noun[1]}` : `${formatCount(from)} to ${formatCount(to)} of ${formatCount(total)} ${total === 1 ? noun[0] : noun[1]}`}
      </p>
      <div className="flex items-center gap-2">
        <Button intent="secondary" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft aria-hidden="true" />
          Previous
        </Button>
        <span className="text-sm tabular">
          Page {page} of {pages}
        </span>
        <Button intent="secondary" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}

// --- Tabs ------------------------------------------------------------------------------------
export function Tabs({ tabs, defaultValue, label }: { tabs: Array<{ value: string; label: string; content: ReactNode }>; defaultValue?: string; label: string }) {
  return (
    <TabsPrimitive.Root defaultValue={defaultValue ?? tabs[0]?.value}>
      <TabsPrimitive.List aria-label={label} className="flex gap-1 overflow-x-auto border-b-2 border-rule">
        {tabs.map((t) => (
          <TabsPrimitive.Trigger
            key={t.value}
            value={t.value}
            className="-mb-0.5 min-h-11 border-b-[3px] border-transparent px-4 font-semibold whitespace-nowrap text-ink-2 hover:text-ink data-[state=active]:border-violet data-[state=active]:text-ink"
          >
            {t.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {tabs.map((t) => (
        <TabsPrimitive.Content key={t.value} value={t.value} className="pt-5">
          {t.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}

export function Kbd(props: ComponentProps<'kbd'>) {
  return <kbd className="rounded-[4px] border border-edge bg-sheet-2 px-1.5 py-0.5 font-mono text-sm" {...props} />;
}
