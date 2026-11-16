import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Page structure. A record is a "sheet" lifted off the paper; its facts are a description list
 * whose "as of" dates are part of the data, never small print. Headings follow the outline
 * (WCAG 2.4.10), and every page says where it is (breadcrumbs, 2.4.8).
 */
export function SkipLink() {
  return (
    <a
      href="#main"
      className="sr-only z-[60] rounded-control bg-violet px-4 py-3 font-semibold text-on-violet focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
    >
      Skip to main content
    </a>
  );
}

export interface Crumb {
  label: string;
  href?: string;
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1 text-sm text-ink-2">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${c.label}-${i}`} className="flex items-center gap-1">
              {c.href && !last ? (
                <Link href={c.href} className="inline-flex min-h-11 items-center px-0.5 text-ink-2 underline-offset-4 hover:text-ink">
                  {c.label}
                </Link>
              ) : (
                <span aria-current={last ? 'page' : undefined} className={cn('inline-flex min-h-11 items-center', last && 'font-semibold text-ink')}>
                  {c.label}
                </span>
              )}
              {!last ? <ChevronRight className="size-4" aria-hidden="true" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function PageHeader({ crumbs, title, description, actions, meta }: { crumbs?: Crumb[]; title: ReactNode; description?: ReactNode; actions?: ReactNode; meta?: ReactNode }) {
  return (
    <header className="flex flex-col gap-2 pb-6">
      {crumbs ? <Breadcrumbs items={crumbs} /> : null}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="text-3xl font-bold">{title}</h1>
          {meta ? <div className="flex flex-wrap items-center gap-3">{meta}</div> : null}
          {description ? <p className="text-lg text-ink-2">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-3">{actions}</div> : null}
      </div>
    </header>
  );
}

/** A record sheet: a titled section of the page, with optional actions in its heading row. */
export function Sheet({
  title,
  description,
  actions,
  children,
  className,
  headingLevel = 2,
  id,
  flush,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  headingLevel?: 2 | 3;
  id?: string;
  /** No inner padding (tables run edge to edge). */
  flush?: boolean;
}) {
  const H = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section aria-labelledby={title && id ? `${id}-title` : undefined} id={id} className={cn('rounded-sheet border border-rule bg-sheet shadow-sheet', className)}>
      {title ? (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rule px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <H id={id ? `${id}-title` : undefined} className="text-xl font-bold">
              {title}
            </H>
            {description ? <p className="mt-1 text-sm text-ink-2">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={flush ? '' : 'px-5 py-5 sm:px-6'}>{children}</div>
    </section>
  );
}

/** Facts as label and value, in two columns where there is room. */
export function RecordList({ items, columns = 2 }: { items: Array<{ label: ReactNode; value: ReactNode; note?: ReactNode }>; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={cn('grid gap-x-8 gap-y-4', columns === 2 && 'sm:grid-cols-2', columns === 3 && 'sm:grid-cols-2 lg:grid-cols-3')}>
      {items.map((it, i) => (
        <div key={i} className="flex min-w-0 flex-col gap-0.5 border-t border-rule pt-3">
          <dt className="text-sm text-ink-2">{it.label}</dt>
          <dd className="break-words font-semibold">{it.value ?? <span className="font-normal text-ink-2">Not recorded</span>}</dd>
          {it.note ? <dd className="text-sm text-ink-2">{it.note}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

/** A headline number with what it counts, and where to see the detail. */
export function Stat({ label, value, detail, href, linkLabel }: { label: string; value: ReactNode; detail?: ReactNode; href?: string; linkLabel?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-sheet border border-rule bg-sheet p-5 shadow-sheet">
      <p className="text-sm text-ink-2">{label}</p>
      <p className="text-3xl font-bold tabular">{value}</p>
      {detail ? <div className="text-sm text-ink-2">{detail}</div> : null}
      {href ? (
        <Link href={href} className="mt-1 inline-flex min-h-11 items-center font-semibold">
          {linkLabel ?? `See ${label.toLowerCase()}`}
        </Link>
      ) : null}
    </div>
  );
}

/** A real sequence (onboarding steps): numbered because the order matters. */
export function Steps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex flex-wrap gap-x-6 gap-y-2" aria-label="Progress">
      {steps.map((s, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'todo';
        return (
          <li key={s} aria-current={state === 'current' ? 'step' : undefined} className="flex items-center gap-2 text-sm">
            <span
              className={cn(
                'grid size-7 place-items-center rounded-full border-2 font-bold tabular',
                state === 'done' && 'border-green bg-green-tint text-green',
                state === 'current' && 'border-violet bg-violet text-on-violet',
                state === 'todo' && 'border-edge text-ink-2',
              )}
            >
              {i + 1}
            </span>
            <span className={state === 'current' ? 'font-bold' : 'text-ink-2'}>
              {s}
              {state === 'done' ? <span className="sr-only"> (done)</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Events in time order (audit trails, a check's history). */
export function Timeline({ items }: { items: Array<{ id: string | number; when: ReactNode; title: ReactNode; detail?: ReactNode }> }) {
  return (
    <ol className="relative flex flex-col gap-5 border-l-2 border-rule pl-6">
      {items.map((it) => (
        <li key={it.id} className="relative">
          <span aria-hidden="true" className="absolute top-1.5 -left-[1.95rem] size-3 rounded-full border-2 border-violet bg-sheet" />
          <p className="font-semibold">{it.title}</p>
          <p className="text-sm text-ink-2">{it.when}</p>
          {it.detail ? <div className="mt-1 text-sm">{it.detail}</div> : null}
        </li>
      ))}
    </ol>
  );
}
