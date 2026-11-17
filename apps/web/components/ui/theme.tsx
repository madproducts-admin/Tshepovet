'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { THEME_COOKIE, type ThemeChoice } from '@/lib/theme';

/**
 * Light, dark, or follow the device. The choice lives in a cookie, so the server renders the
 * right theme on the first paint (no flash, no inline script under the CSP).
 */
export function ThemeSwitch({ initial }: { initial: ThemeChoice }) {
  const [choice, setChoice] = useState<ThemeChoice>(initial);
  const choose = (c: ThemeChoice) => {
    setChoice(c);
    document.cookie = `${THEME_COOKIE}=${c}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
    if (c === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', c);
  };
  const options: Array<{ value: ThemeChoice; label: string; icon: typeof Sun }> = [
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
    { value: 'system', label: 'Device', icon: Monitor },
  ];
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-sm text-ink-2">Theme</legend>
      <div className="inline-flex rounded-control border border-edge bg-sheet p-0.5">
        {options.map(({ value, label, icon: Icon }) => (
          <label
            key={value}
            className={cn(
              'relative inline-flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[4px] px-3 text-sm font-semibold has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-violet',
              choice === value ? 'bg-violet text-on-violet' : 'text-ink-2 hover:text-ink',
            )}
          >
            <input type="radio" name="tv-theme" value={value} checked={choice === value} onChange={() => choose(value)} className="sr-only" />
            <Icon className="size-4" aria-hidden="true" />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
