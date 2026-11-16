import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Callout } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/layout';

/**
 * Legal text. Drafts until the owner's legal review (docs/PLAN.md §8): they say so at the top.
 * Written to be read: short sentences, what happens and what you can do.
 */
const DOCS: Record<string, { title: string; sections: Array<{ heading: string; body: string[] }> }> = {
  privacy: {
    title: 'Privacy notice',
    sections: [
      {
        heading: 'Who we are',
        body: [
          'TshepoVet checks South African suppliers for the organisations that buy from them. For the checks a buyer runs, the buyer is the responsible party and TshepoVet is its operator, as POPIA uses those words. For your own TshepoVet account, TshepoVet is the responsible party.',
        ],
      },
      {
        heading: 'What we process, and why',
        body: [
          'About suppliers: registration details and directors from the CIPC register, VAT and tax compliance status from SARS, B-BBEE evidence, and documents the supplier sends. Buyers use them to decide whether to contract with and pay a supplier.',
          'About drivers: licence and professional driving permit status from the national traffic register, with the driver’s consent.',
          'About you, if you use the portal: your name, work email, sign-in records and what you do in TshepoVet (the audit log).',
        ],
      },
      {
        heading: 'How long we keep it',
        body: [
          'Check results: for the business relationship plus five years. Photos of documents: 30 to 90 days, then deleted; what was read from them is kept. Tax compliance PINs: until they expire. Audit records: seven years.',
        ],
      },
      {
        heading: 'Where it is kept',
        body: ['In South Africa. Nothing is sent abroad without telling you first.'],
      },
      {
        heading: 'Your rights',
        body: [
          'You may ask to see the information held about you, to have it corrected or deleted, or object to its use. Ask the buyer that checked you, or write to TshepoVet. Answers come within 30 days. You may also complain to the Information Regulator at inforeg.org.za.',
        ],
      },
    ],
  },
  terms: {
    title: 'Terms of use',
    sections: [
      { heading: 'The sandbox', body: ['This is the TshepoVet sandbox. Checks use test data, top-ups are not real money, and nothing here is a real verification. Do not enter real people’s personal information.'] },
      {
        heading: 'Your account',
        body: [
          'Keep your password and two-step verification to yourself. You are responsible for what is done with your account and your API keys. Tell us at once if you think someone else has used them.',
        ],
      },
      {
        heading: 'Checks',
        body: [
          'Run checks only on suppliers and drivers you have a lawful reason to check, and only with consent where consent is needed. A check reports what the sources said at the time; it is not a guarantee.',
        ],
      },
      { heading: 'Charges', body: ['Checks and modules are paid from your prepaid wallet at the published prices, plus VAT. A check is charged only when TshepoVet gets an answer.'] },
    ],
  },
};

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export async function generateMetadata({ params }: { params: Promise<{ doc: string }> }): Promise<Metadata> {
  const { doc } = await params;
  return { title: DOCS[doc]?.title ?? 'Not found' };
}

export default async function LegalPage({ params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params;
  const d = DOCS[doc];
  if (!d) notFound();
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <PageHeader title={d.title} />
      <Callout tone="caution" title="Draft" announce={false} className="mb-8">
        <p>This text is waiting for legal review and may change before TshepoVet goes live.</p>
      </Callout>
      <div className="flex flex-col gap-8">
        {d.sections.map((s) => (
          <section key={s.heading} aria-labelledby={slug(s.heading)}>
            <h2 id={slug(s.heading)} className="mb-2 text-2xl font-bold">
              {s.heading}
            </h2>
            {s.body.map((p, i) => (
              <p key={i} className="mt-2 text-lg">
                {p}
              </p>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
