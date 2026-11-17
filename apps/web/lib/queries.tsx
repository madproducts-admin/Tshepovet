'use client';

import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import type { SessionView } from '@tshepovet/contracts';
// The zod-free entry point: this module is on every page, and the package's index would bring
// every schema and zod itself (44 KB compressed) to pages that validate nothing.
import { can, type Permission } from '@tshepovet/contracts/rbac';
import { toast } from '@/components/ui/toast';
import { api, ApiProblem, setCsrfToken } from './api';

/** One query client per browser tab; nothing is retried that the user did not ask for twice. */
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 15_000, retry: (n, err) => !(err instanceof ApiProblem && err.status < 500) && n < 2, refetchOnWindowFocus: true },
          mutations: { retry: false },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

type Query = Record<string, string | number | boolean | undefined | null>;

/** GET an /api path; the key is the path and its query, so lists refetch when filters change. */
export function useApi<T>(path: string | null, query?: Query, opts: { refetchInterval?: number | false } = {}) {
  return useQuery<T, ApiProblem>({
    queryKey: [path, query ?? {}],
    queryFn: () => api<T>(path!, { query }),
    enabled: Boolean(path),
    refetchInterval: opts.refetchInterval,
  });
}

/**
 * Whether TshepoVet adds VAT (its operator is a VAT vendor), from the public /api/meta. False
 * until known: then prices say nothing about VAT rather than wrongly "excluding VAT".
 */
export function useVatRegistered(): boolean {
  const q = useQuery<{ vat_registered?: boolean; vat_rate?: number }, ApiProblem>({
    queryKey: ['/api/meta', {}],
    queryFn: () => api('/api/meta'),
    staleTime: 5 * 60_000,
  });
  return Boolean(q.data?.vat_registered ?? (q.data?.vat_rate ?? 0) > 0);
}

/**
 * A change: on success it refreshes the listed queries (by path prefix) and confirms in the
 * same words as the button; on failure the caller shows the problem next to the form.
 */
export function useChange<TBody, TResult>(
  fn: (body: TBody) => Promise<TResult>,
  opts: { invalidate?: string[]; success?: string | ((r: TResult) => string); onSuccess?: (r: TResult) => void } = {},
) {
  const qc = useQueryClient();
  return useMutation<TResult, ApiProblem, TBody>({
    mutationFn: fn,
    onSuccess: async (r) => {
      for (const prefix of opts.invalidate ?? []) {
        await qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && (q.queryKey[0] as string).startsWith(prefix) });
      }
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success);
      opts.onSuccess?.(r);
    },
  });
}

// --- The signed-in session -------------------------------------------------------------------
interface SessionContext {
  session: SessionView;
  can: (p: Permission) => boolean;
  refresh: () => Promise<unknown>;
}
const Ctx = createContext<SessionContext | null>(null);

export function useSession(): SessionContext {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSession outside SessionProvider');
  return c;
}

/** Loads the session for the portal; sends a signed-out visitor to sign-in. */
export function SessionProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const q = useQuery<SessionView, ApiProblem>({ queryKey: ['/api/auth/session'], queryFn: () => api<SessionView>('/api/auth/session'), staleTime: 60_000, retry: false });
  useEffect(() => {
    if (q.data) setCsrfToken(q.data.csrf_token);
  }, [q.data]);
  useEffect(() => {
    if (q.error?.status === 401) window.location.assign(`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`);
  }, [q.error]);
  if (!q.data) return <>{fallback}</>;
  const session = q.data;
  return <Ctx.Provider value={{ session, can: (p) => can(session.user.role, p), refresh: q.refetch }}>{children}</Ctx.Provider>;
}
