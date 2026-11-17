'use client';

import * as ToastPrimitive from '@radix-ui/react-toast';
import { CircleAlert, CircleCheck, X } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { cn } from '@/lib/cn';

/**
 * Confirmations after an action ("Supplier added"). They name the action in the same words as
 * its button, are announced to screen readers, and stay until dismissed (WCAG 2.2.3: no time
 * limits at AAA) - except plain successes, which can close themselves after 10 seconds while
 * the same result is visible on the page.
 */
interface ToastItem {
  id: number;
  title: string;
  body?: string;
  tone: 'success' | 'error';
}

let items: ToastItem[] = [];
let next = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const toast = {
  success(title: string, body?: string) {
    items = [...items, { id: next++, title, body, tone: 'success' }];
    emit();
  },
  error(title: string, body?: string) {
    items = [...items, { id: next++, title, body, tone: 'error' }];
    emit();
  },
};

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

export function Toaster() {
  const list = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => items,
    () => items,
  );
  return (
    <ToastPrimitive.Provider swipeDirection="right" label="Notifications">
      {list.map((t) => (
        <ToastPrimitive.Root
          key={t.id}
          type={t.tone === 'error' ? 'foreground' : 'background'}
          duration={t.tone === 'error' ? Infinity : 10_000}
          onOpenChange={(open) => !open && dismiss(t.id)}
          className={cn('flex items-start gap-3 rounded-sheet border-l-4 bg-sheet p-4 text-ink shadow-sheet', t.tone === 'error' ? 'border-red' : 'border-green')}
        >
          {t.tone === 'error' ? <CircleAlert className="mt-0.5 size-5 shrink-0 text-red" aria-hidden="true" /> : <CircleCheck className="mt-0.5 size-5 shrink-0 text-green" aria-hidden="true" />}
          <div className="min-w-0 flex-1">
            <ToastPrimitive.Title className="font-bold">{t.title}</ToastPrimitive.Title>
            {t.body ? <ToastPrimitive.Description className="mt-0.5 text-ink-2">{t.body}</ToastPrimitive.Description> : null}
          </div>
          <ToastPrimitive.Close aria-label="Dismiss" className="-m-2 grid size-11 place-items-center rounded-control hover:bg-sheet-2">
            <X className="size-[1.125rem]" aria-hidden="true" />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport className="fixed right-4 bottom-4 z-[70] flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-3 outline-none" />
    </ToastPrimitive.Provider>
  );
}
