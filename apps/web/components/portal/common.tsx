'use client';

import type { UseQueryResult } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Callout, Skeleton } from '@/components/ui/feedback';
import type { ApiProblem } from '@/lib/api';

/** Loading, failed or ready: every data section says which, and failure offers a retry. */
export function Loaded<T>({ q, children, label, skeleton }: { q: UseQueryResult<T, ApiProblem>; children: (data: T) => ReactNode; label: string; skeleton?: ReactNode }) {
  if (q.isError) {
    return (
      <Callout tone="refused" title={`${label} could not be loaded`}>
        <p>{q.error.status === 403 ? q.error.message : 'Check your connection, then try again.'}</p>
        <Button intent="secondary" size="sm" className="mt-2" onClick={() => q.refetch()}>
          Try again
        </Button>
      </Callout>
    );
  }
  if (!q.data) {
    return (
      <div role="status" aria-label={`Loading ${label.toLowerCase()}`} className="flex flex-col gap-3">
        {skeleton ?? (
          <>
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </>
        )}
      </div>
    );
  }
  return <>{children(q.data)}</>;
}

/**
 * List filters, sorting and paging kept in the address bar: a view can be bookmarked, shared,
 * and survives the back button and a reload.
 */
export function useListParams<K extends string>(defaults: Record<K, string>) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const get = (k: K) => params.get(k) ?? defaults[k];
  const values = Object.fromEntries((Object.keys(defaults) as K[]).map((k) => [k, get(k)])) as Record<K, string>;
  const set = useCallback(
    (patch: Partial<Record<K, string | number | undefined>>, resetPage = true) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch) as Array<[K, string | number | undefined]>) {
        if (v === undefined || v === '' || String(v) === defaults[k]) next.delete(k);
        else next.set(k, String(v));
      }
      if (resetPage && !('page' in patch)) next.delete('page');
      const s = next.toString();
      router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
    },
    [params, router, pathname, defaults],
  );
  return { values, set };
}

/** A row of filters above a list, wrapping on narrow screens. */
export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-end gap-4 px-5 py-4 sm:px-6">{children}</div>;
}

export function Label({ children }: { children: ReactNode }) {
  return <span className="text-sm font-semibold">{children}</span>;
}

/** Human labels for the API's codes. */
export const CHECK_LABELS: Record<string, string> = {
  registration: 'Registration (CIPC)',
  directors: 'Directors',
  vat: 'VAT registration',
  tcs: 'Tax compliance (SARS)',
  licence: 'Driving licence',
  prdp: 'Professional driving permit',
  id_match: 'Identity',
};

export const SUBJECT_LABELS: Record<string, string> = {
  document: 'Document',
  tcs_pin: 'Tax compliance PIN',
  bbbee: 'B-BBEE evidence',
  cipc_annual_return: 'CIPC annual return',
  credential: 'Licence or permit',
};

export const humanise = (code: string) => code.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
