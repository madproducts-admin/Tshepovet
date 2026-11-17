import type { ReactNode } from 'react';
import { GLOSSARY, type GlossaryTerm } from '@/lib/glossary';

/**
 * An abbreviation, expanded for screen readers; the title shows it on hover (WCAG 3.1.4).
 * Plain markup, not a client component: public pages use it without loading data.tsx (tables,
 * tabs and their icons). data.tsx re-exports it for the portal.
 */
export function Term({ term, children }: { term: GlossaryTerm; children?: ReactNode }) {
  const g = GLOSSARY[term];
  return (
    <>
      <abbr title={g.expansion}>{children ?? term}</abbr>
      <span className="sr-only"> ({g.expansion})</span>
    </>
  );
}
