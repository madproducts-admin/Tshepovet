import type { Metadata, Viewport } from 'next';
import { Atkinson_Hyperlegible_Mono, Atkinson_Hyperlegible_Next } from 'next/font/google';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { Toaster } from '@/components/ui/toast';
import { Providers } from '@/lib/queries';
import { THEME_COOKIE, type ThemeChoice } from '@/lib/theme';
import './globals.css';

/*
 * Atkinson Hyperlegible, from the Braille Institute: letterforms drawn so that I, l and 1, or
 * 0 and O, can never be confused. For a product whose job is reading registration numbers,
 * tax references and PINs correctly, legibility is the brand. Self-hosted at build time by
 * next/font: no font requests leave the site.
 */
const sans = Atkinson_Hyperlegible_Next({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-atkinson',
  display: 'swap',
  adjustFontFallback: false,
  fallback: ['ui-sans-serif', 'system-ui', 'Segoe UI', 'sans-serif'],
});
const mono = Atkinson_Hyperlegible_Mono({
  subsets: ['latin'],
  variable: '--font-atkinson-mono',
  display: 'swap',
  adjustFontFallback: false,
  fallback: ['ui-monospace', 'Consolas', 'monospace'],
});

export const metadata: Metadata = {
  title: { default: 'TshepoVet', template: '%s | TshepoVet' },
  description: 'Know who you are paying. TshepoVet checks South African suppliers against CIPC, SARS and the bureaus, and keeps watching.',
  robots: { index: false, follow: false },
  icons: { icon: '/seal.svg' },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f3f6f4' },
    { media: '(prefers-color-scheme: dark)', color: '#0c161b' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = ((await cookies()).get(THEME_COOKIE)?.value ?? 'system') as ThemeChoice;
  return (
    <html lang="en-ZA" data-theme={theme === 'system' ? undefined : theme} className={`${sans.variable} ${mono.variable}`}>
      <body>
        <Providers>{children}</Providers>
        <Toaster />
      </body>
    </html>
  );
}
