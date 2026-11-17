'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { z } from 'zod';
import type { PassportVerifyResultSchema } from '@tshepovet/contracts';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/form';
import { api, ApiProblem } from '@/lib/api';
import { formatDay } from '@/lib/format';

type Result = z.infer<typeof PassportVerifyResultSchema>;

/**
 * Checks the code printed on a paper passport: whether TshepoVet issued it, whether the
 * supplier still publishes the passport, and whether the facts on paper are still current.
 */
export function VerifyPassport() {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function check(e: { preventDefault(): void }) {
    e.preventDefault();
    const clean = code.replace(/[\s-]/g, '');
    if (clean.length < 20) {
      setError('Enter the whole code, as printed under “Verification code”.');
      return;
    }
    setError(undefined);
    setBusy(true);
    setResult(null);
    try {
      // The API takes the code with its dashes; it was printed in groups of four.
      const withDashes = `${clean.slice(0, 24)}-${clean.slice(24, 32)}-${clean.slice(32)}`;
      setResult(await api<Result>('/api/passport/verify', { query: { code: withDashes } }));
    } catch (err) {
      setError(err instanceof ApiProblem ? err.message : 'TshepoVet could not be reached. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <form noValidate onSubmit={check} className="flex flex-col gap-5">
        <Field id="vp-code" label="Verification code" hint="Printed at the bottom of the passport, in groups of four. Spaces do not matter." error={error}>
          {(p) => <Input {...p} mono autoComplete="off" spellCheck={false} autoCapitalize="characters" value={code} onChange={(e) => setCode(e.target.value)} />}
        </Field>
        <div>
          <Button type="submit" loading={busy}>
            Check the code
          </Button>
        </div>
      </form>
      <div aria-live="polite">{result ? <Verdict r={result} /> : null}</div>
    </div>
  );
}

function Verdict({ r }: { r: Result }) {
  const printed = r.printed_verified_at ? formatDay(r.printed_verified_at) : null;
  const open = r.public_id ? (
    <p className="mt-2">
      <Link href={`/passport/${r.public_id}`} className="inline-flex min-h-11 items-center font-semibold">
        Open the current passport
      </Link>
    </p>
  ) : null;
  if (!r.genuine) {
    return (
      <Callout tone="refused" title="TshepoVet did not issue this code">
        <p>Check that you typed it exactly as printed. If it is right, the copy may have been altered: do not rely on it, and ask the supplier for a new one.</p>
      </Callout>
    );
  }
  if (r.status === 'withdrawn') {
    return (
      <Callout tone="caution" title="Genuine, but the passport was withdrawn">
        <p>
          TshepoVet issued this copy{printed ? ` (verified ${printed})` : ''}, but the passport is no longer published. Ask the supplier for their current details.
        </p>
      </Callout>
    );
  }
  if (!r.current) {
    return (
      <Callout tone="caution" title="Genuine, but out of date">
        <p>
          The copy shows {r.legal_name ?? 'the supplier'} as verified {printed ? `on ${printed}` : 'earlier'}. It has been verified again since: the current passport shows
          today’s facts.
        </p>
        {open}
      </Callout>
    );
  }
  return (
    <Callout tone="verified" title="Genuine and current">
      <p>
        {r.legal_name ?? 'The supplier'}: the facts on the copy are the passport as verified{printed ? ` on ${printed}` : ''}, and the supplier still publishes it.
      </p>
      {open}
    </Callout>
  );
}
