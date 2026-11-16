import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/layout';
import { GLOSSARY } from '@/lib/glossary';

export const metadata: Metadata = { title: 'Words we use' };

/** Every abbreviation and specialist word in TshepoVet, explained (WCAG 3.1.3, 3.1.4). */
export default function GlossaryPage() {
  const terms = Object.entries(GLOSSARY).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <PageHeader title="Words we use" description="South African compliance has its own vocabulary. Here is what each term means, in plain words." />
      <dl className="flex flex-col divide-y divide-rule">
        {terms.map(([term, g]) => (
          <div key={term} id={term.toLowerCase()} className="flex flex-col gap-1 py-4">
            <dt className="text-xl font-bold">
              {term} <span className="font-normal text-ink-2">({g.expansion})</span>
            </dt>
            <dd>{g.explanation}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
