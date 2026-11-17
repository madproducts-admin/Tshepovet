'use client';

import { Eye, EyeOff } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { type FieldControlProps, Input } from '@/components/ui/form';

export function AuthHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-2">
      <h1 className="text-3xl font-bold">{title}</h1>
      {children ? <div className="text-lg text-ink-2">{children}</div> : null}
    </div>
  );
}

/** A password box with a show/hide button (people make fewer mistakes when they can see it). */
export function PasswordInput({ autoComplete, value, onChange, ...p }: FieldControlProps & { autoComplete: 'current-password' | 'new-password'; value: string; onChange: (v: string) => void }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex gap-2">
      <Input {...p} type={shown ? 'text' : 'password'} autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      <Button intent="secondary" size="icon" onClick={() => setShown((s) => !s)} aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown} aria-controls={p.id}>
        {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </Button>
    </div>
  );
}

/**
 * Tokens in email links travel in the URL fragment (#token=...), which browsers never send to
 * a server or write to its logs. Read once, then removed from the address bar.
 */
export function useHashToken(): string | null | undefined {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const read = (initial: boolean) => {
      const m = /(?:^|[#&])token=([A-Za-z0-9_-]{43})/.exec(window.location.hash);
      // A link pasted into a tab already on this page only changes the fragment: no reload.
      if (initial || m) setToken(m?.[1] ?? null);
      if (m) history.replaceState(null, '', window.location.pathname + window.location.search);
    };
    read(true);
    const onHash = () => read(false);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return token;
}

/** Where to go after signing in: only a path inside the portal, never another site. */
export function safeNext(raw: string | null): string {
  return raw && /^\/app(\/[A-Za-z0-9/_\-?=&%.]*)?$/.test(raw) && !raw.startsWith('//') ? raw : '/app';
}

export const PASSWORD_HINT = 'At least 12 characters. A few unrelated words is easier to remember than symbols, and stronger.';
