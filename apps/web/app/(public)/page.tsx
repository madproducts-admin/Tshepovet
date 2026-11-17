import type { Metadata } from 'next';
import Link from 'next/link';
import type { PublicPassport } from '@tshepovet/contracts';
import { PassportSheet } from '@/components/supplier/passport-sheet';
import { Button } from '@/components/ui/button';
import { Term } from '@/components/ui/term';
import { formatMoney } from '@/lib/format';
import { getMeta } from '@/lib/server';

export const metadata: Metadata = {
  title: { absolute: 'TshepoVet: know who you are paying' },
  description:
    'TshepoVet checks South African suppliers against the CIPC register, SARS and licensed bureaus, keeps checking until their documents lapse, and lets each supplier carry its verified facts to every customer.',
};

/** Sample facts for the specimen passport: dated from today, so they never look stale. */
function specimen(): PublicPassport {
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  return {
    public_id: '000000000000000000000000',
    legal_name: 'Specimen Trading (Pty) Ltd',
    registration_number: '2019/123456/07',
    cipc_status: 'in_business',
    vat_registered: true,
    tcs: { status: 'compliant', expires_on: day(330), checked_at: new Date().toISOString() },
    bbbee: { level: 1, valid_until: day(300) },
    directors: ['T.M.', 'P.v.d.M.'],
    verified_at: new Date().toISOString(),
    verification_code: 'SPECIMENSPECIMENSPECIMEN-00000000-000000000000',
  };
}

const QUESTIONS: Array<{ q: React.ReactNode; a: React.ReactNode }> = [
  {
    q: 'Is the company registered, and still in business?',
    a: (
      <>
        Its status on the <Term term="CIPC" /> register, read from licensed bureaus, with deregistration, liquidation and business rescue called out.
      </>
    ),
  },
  { q: 'Who are its directors?', a: 'From the register. When the supplier onboards, the ID of the person filling it in is matched against them.' },
  {
    q: 'Is it tax compliant today?',
    a: (
      <>
        Checked with <Term term="SARS" /> using the tax compliance status PIN the supplier creates on eFiling, and whether it is registered for <Term term="VAT" />.
      </>
    ),
  },
  {
    q: 'What is its B-BBEE level?',
    a: 'Read from its affidavit or certificate, which is checked for its date, its signature and the commissioner of oaths before the level counts.',
  },
  {
    q: 'Can its driver drive your load?',
    a: (
      <>
        A driving licence and <Term term="PrDP" /> check, for transport and logistics suppliers.
      </>
    ),
  },
];

export default async function Home() {
  const meta = await getMeta();
  return (
    <>
      <section aria-labelledby="hero" className="border-b border-rule">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-14 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:py-20">
          <div className="flex flex-col gap-6">
            <h1 id="hero" className="text-4xl leading-tight font-bold sm:text-5xl">
              Know who you are paying.
            </h1>
            <p className="max-w-[34rem] text-xl leading-relaxed text-ink-2">
              TshepoVet checks South African suppliers against the register, SARS and licensed bureaus, keeps checking until their documents lapse, and lets each
              supplier carry its verified facts to every customer.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild>
                <Link href="/sign-up">Create an account</Link>
              </Button>
              <Button asChild intent="secondary">
                <Link href="/pricing">See the prices</Link>
              </Button>
            </div>
            <p className="text-ink-2">
              A company check costs {formatMoney(meta.check_prices.company_cents)}. You top up a wallet and pay per check; there is no subscription.
            </p>
          </div>
          <div className="lg:rotate-[-1.25deg]">
            <PassportSheet p={specimen()} specimen headingLevel={2} />
          </div>
        </div>
      </section>

      <section aria-labelledby="answers" className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <h2 id="answers" className="text-3xl font-bold">
          What one check answers
        </h2>
        <dl className="mt-8 grid gap-x-12 gap-y-8 md:grid-cols-2">
          {QUESTIONS.map((x, i) => (
            <div key={i} className="flex flex-col gap-2 border-t-2 border-rule pt-4">
              <dt className="text-xl font-bold">{x.q}</dt>
              <dd className="max-w-[60ch] text-ink-2">{x.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="how" className="border-y border-rule bg-sheet">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 id="how" className="text-3xl font-bold">
            How it works
          </h2>
          <ol className="mt-8 grid gap-8 md:grid-cols-3">
            {[
              ['Add a supplier', 'Enter its registration number. TshepoVet looks the company up on the register at once.'],
              [
                'Check it, or let it onboard itself',
                'Run the checks yourself, or email the supplier a link: it adds an ID, its B-BBEE evidence, bank details and a tax PIN from its phone.',
              ],
              [
                'Hear before anything lapses',
                'Monitoring re-checks before a tax PIN, an affidavit or an annual return runs out, and can lock payments in your accounting system until it is fixed.',
              ],
            ].map(([title, text], i) => (
              <li key={title} className="flex gap-4">
                <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full border-2 border-violet font-bold text-violet tabular">
                  {i + 1}
                </span>
                <div className="flex flex-col gap-1">
                  <h3 className="text-xl font-bold">{title}</h3>
                  <p className="text-ink-2">{text}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <div className="mx-auto grid max-w-6xl gap-12 px-4 py-14 sm:px-6 md:grid-cols-2">
        <section aria-labelledby="suppliers" className="flex flex-col gap-3">
          <h2 id="suppliers" className="text-2xl font-bold">
            Invited by a customer?
          </h2>
          <p className="max-w-[60ch] text-ink-2">
            Follow the link in their email; it takes about ten minutes. Once a director’s identity matches the register, you can publish a Verified Vendor Passport and
            share it with every customer instead of filling in the same forms again. You choose what it shows, and can withdraw it at any time.
          </p>
          <ul className="flex flex-col">
            <li>
              <Link href="/supplier/sign-in" className="inline-flex min-h-11 items-center font-semibold">
                Sign in as a supplier
              </Link>
            </li>
            <li>
              <Link href="/verify-passport" className="inline-flex min-h-11 items-center font-semibold">
                Check a printed passport
              </Link>
            </li>
          </ul>
        </section>
        <section aria-labelledby="developers" className="flex flex-col gap-3">
          <h2 id="developers" className="text-2xl font-bold">
            For developers
          </h2>
          <p className="max-w-[60ch] text-ink-2">
            Every check is an API call, with test keys that answer from sample data. Results arrive in the response or on your webhook, signed with a secret you can
            rotate.
          </p>
          <ul className="flex flex-col gap-1 font-mono text-sm">
            <li>POST /v1/verify/company</li>
            <li>POST /v1/verify/driver-licence</li>
            <li>GET /v1/verifications/&#123;id&#125;</li>
          </ul>
          <p>
            <a href="/docs/" className="inline-flex min-h-11 items-center font-semibold">
              Read the API documentation
            </a>
          </p>
        </section>
      </div>
    </>
  );
}
