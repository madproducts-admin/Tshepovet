import { Ban, CircleAlert, CircleCheck, CircleX, Clock, Info, LoaderCircle, SearchX, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Feedback: stamps (verdicts and statuses), callouts, progress. Colour never carries meaning
 * alone (WCAG 1.4.1): every stamp has an icon and words.
 */
export type Tone = 'verified' | 'caution' | 'refused' | 'pending' | 'neutral';

const TONES: Record<Tone, string> = {
  verified: 'text-green bg-green-tint [--stamp-bg:var(--green-tint)]',
  caution: 'text-amber bg-amber-tint [--stamp-bg:var(--amber-tint)]',
  refused: 'text-red bg-red-tint [--stamp-bg:var(--red-tint)]',
  pending: 'text-petrol bg-petrol-tint [--stamp-bg:var(--petrol-tint)]',
  neutral: 'text-ink-2 bg-sheet-2 [--stamp-bg:var(--sheet-2)]',
};

const ICONS: Record<Tone, typeof CircleCheck> = {
  verified: CircleCheck,
  caution: TriangleAlert,
  refused: CircleX,
  pending: Clock,
  neutral: Info,
};

/** A rubber-stamp verdict: a double rule in the stamp's ink. */
export function Stamp({ tone, children, icon, className }: { tone: Tone; children: ReactNode; icon?: typeof CircleCheck; className?: string }) {
  const Icon = icon ?? ICONS[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-stamp border border-current px-2 py-0.5 text-sm font-semibold whitespace-nowrap shadow-[inset_0_0_0_1.5px_var(--stamp-bg),inset_0_0_0_2.5px_currentColor]',
        TONES[tone],
        className,
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {children}
    </span>
  );
}

const OUTCOMES: Record<string, { tone: Tone; label: string; icon?: typeof CircleCheck }> = {
  verified: { tone: 'verified', label: 'Verified' },
  verified_with_warnings: { tone: 'caution', label: 'Verified, with warnings' },
  failed_checks: { tone: 'refused', label: 'Failed checks' },
  not_found: { tone: 'refused', label: 'Not found', icon: SearchX },
  unable_to_verify: { tone: 'neutral', label: 'Could not verify', icon: Ban },
};

/** The verdict of a check, or its progress while it runs. */
export function OutcomeStamp({ outcome, status }: { outcome: string | null; status?: string }) {
  if (status === 'processing' || (!outcome && status !== 'failed')) {
    return (
      <Stamp tone="pending" icon={LoaderCircle}>
        Checking
      </Stamp>
    );
  }
  const o = OUTCOMES[outcome ?? 'unable_to_verify'] ?? OUTCOMES.unable_to_verify!;
  return (
    <Stamp tone={o.tone} icon={o.icon}>
      {o.label}
    </Stamp>
  );
}

const SUPPLIER: Record<string, { tone: Tone; label: string }> = {
  invited: { tone: 'pending', label: 'Invited' },
  onboarding: { tone: 'pending', label: 'Onboarding' },
  pending_review: { tone: 'caution', label: 'Awaiting review' },
  approved: { tone: 'verified', label: 'Approved' },
  rejected: { tone: 'refused', label: 'Rejected' },
  suspended: { tone: 'refused', label: 'Suspended' },
  offboarded: { tone: 'neutral', label: 'Offboarded' },
};

export function SupplierStatusStamp({ status }: { status: string }) {
  const s = SUPPLIER[status] ?? { tone: 'neutral' as Tone, label: status };
  return <Stamp tone={s.tone}>{s.label}</Stamp>;
}

const CALLOUT: Record<Exclude<Tone, 'neutral'> | 'info', { box: string; icon: typeof CircleCheck }> = {
  verified: { box: 'border-green bg-green-tint', icon: CircleCheck },
  caution: { box: 'border-amber bg-amber-tint', icon: TriangleAlert },
  refused: { box: 'border-red bg-red-tint', icon: CircleAlert },
  pending: { box: 'border-petrol bg-petrol-tint', icon: Clock },
  info: { box: 'border-petrol bg-petrol-tint', icon: Info },
};

/**
 * A message in the flow of the page. Errors are announced (role="alert"); the rest is
 * announced politely when it appears.
 */
export function Callout({ tone = 'info', title, children, className, announce = true }: { tone?: keyof typeof CALLOUT; title: ReactNode; children?: ReactNode; className?: string; announce?: boolean }) {
  const c = CALLOUT[tone];
  const Icon = c.icon;
  return (
    <div role={announce ? (tone === 'refused' ? 'alert' : 'status') : undefined} className={cn('flex gap-3 rounded-sheet border-l-4 p-4 text-ink', c.box, className)}>
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-bold">{title}</p>
        {children ? <div className="mt-1 text-ink [&_p]:mt-1">{children}</div> : null}
      </div>
    </div>
  );
}

export function Spinner({ label = 'Loading', className }: { label?: string; className?: string }) {
  return (
    <span role="status" className={cn('inline-flex items-center gap-2 text-ink-2', className)}>
      <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('block animate-pulse rounded-control bg-sheet-2', className)} />;
}

/** Nothing here yet: says why, and what to do next. */
export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-sheet border border-dashed border-edge p-8">
      <h2 className="text-xl font-bold">{title}</h2>
      {children ? <div className="text-ink-2">{children}</div> : null}
      {action}
    </div>
  );
}

/** A quantity against its limit (wallet use, a 30-day clock). */
export function Meter({ label, value, max, valueText, tone = 'pending' }: { label: string; value: number; max: number; valueText: string; tone?: Tone }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const bar: Record<Tone, string> = { verified: 'bg-green', caution: 'bg-amber', refused: 'bg-red', pending: 'bg-petrol', neutral: 'bg-ink-2' };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between gap-4 text-sm">
        <span className="font-semibold">{label}</span>
        <span className="text-ink-2 tabular">{valueText}</span>
      </div>
      <div role="meter" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-valuetext={valueText} className="h-2.5 overflow-hidden rounded-full border border-edge bg-sheet-2">
        <div className={cn('h-full', bar[tone])} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
