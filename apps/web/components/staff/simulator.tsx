'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { WaConversationSchema, WaMessageSchema, WaTenantSchema } from '@tshepovet/contracts';
import { humanise, Loaded } from '@/components/portal/common';
import { Button } from '@/components/ui/button';
import { Callout, EmptyState, Stamp } from '@/components/ui/feedback';
import { Field, Input, Select } from '@/components/ui/form';
import { PageHeader, Sheet } from '@/components/ui/layout';
import { toast } from '@/components/ui/toast';
import { ApiProblem, staffApi } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatInstant } from '@/lib/format';

/**
 * The WhatsApp simulator (sandbox, docs/PLAN.md M8): staff play the supplier's phone. What they
 * send goes onto the same stream as Meta's webhook, the real bot answers, and its replies come
 * back through the sandbox Graph client. The conversation refreshes every two seconds while
 * this page is open (and only then).
 */
type Conversation = z.infer<typeof WaConversationSchema>;
type Message = z.infer<typeof WaMessageSchema>;
type Tenant = z.infer<typeof WaTenantSchema>;

const SAMPLES = [
  ['id_director', 'ID card of a director'],
  ['id_other_person', 'ID card of someone who left the company'],
  ['id_blurry', 'A blurry photo of an ID card'],
  ['bbbee_eme', 'EME affidavit, 100% black-owned'],
  ['bbbee_expired', 'EME affidavit signed 14 months ago'],
] as const;
const message = (e: unknown) => (e instanceof ApiProblem ? e.message : 'TshepoVet could not be reached.');

export function Simulator() {
  const params = useSearchParams();
  const qc = useQueryClient();
  const list = useQuery<Conversation[], ApiProblem>({ queryKey: ['staff', 'wa'], queryFn: () => staffApi<Conversation[]>('/api/staff/whatsapp'), retry: false });
  const [selected, setSelected] = useState<string | null>(params.get('c'));
  useEffect(() => {
    if (!selected && list.data?.[0]) setSelected(list.data[0].id);
  }, [list.data, selected]);
  const current = list.data?.find((c) => c.id === selected) ?? null;
  return (
    <>
      <PageHeader title="WhatsApp simulator" description="Play the supplier’s phone in the sandbox. The real bot answers." />
      {list.error?.status === 404 ? (
        <Callout tone="info" title="The simulator is only in the sandbox" />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[22rem_minmax(0,1fr)]">
          <div className="flex flex-col gap-6">
            <StartConversation
              onStarted={async (c) => {
                await qc.invalidateQueries({ queryKey: ['staff', 'wa'] });
                setSelected(c.id);
              }}
            />
            <Sheet title="Conversations" flush>
              <Loaded q={list} label="The conversations">
                {(rows) =>
                  rows.length ? (
                    <ul className="flex flex-col divide-y divide-rule">
                      {rows.map((c) => (
                        <li key={c.id}>
                          <button
                            type="button"
                            onClick={() => setSelected(c.id)}
                            aria-current={c.id === selected ? 'true' : undefined}
                            className={cn('flex min-h-11 w-full flex-col items-start gap-0.5 px-5 py-3 text-left hover:bg-sheet-2', c.id === selected && 'bg-petrol-tint')}
                          >
                            <span className="font-mono font-semibold">+{c.number}</span>
                            <span className="text-sm text-ink-2">
                              {c.tenant}: {humanise(c.state.toLowerCase())}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="p-5">
                      <EmptyState title="No conversations yet">Start one above.</EmptyState>
                    </div>
                  )
                }
              </Loaded>
            </Sheet>
          </div>
          {current ? <Phone c={current} /> : null}
        </div>
      )}
    </>
  );
}

function StartConversation({ onStarted }: { onStarted: (c: Conversation) => void }) {
  const tenants = useQuery<Tenant[], ApiProblem>({ queryKey: ['staff', 'wa-tenants'], queryFn: () => staffApi<Tenant[]>('/api/staff/whatsapp/tenants'), retry: false });
  const [tenant, setTenant] = useState('');
  const [number, setNumber] = useState('27');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <Sheet title="Start an onboarding">
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!tenant) return setError('Choose the buyer who invites the supplier.');
          if (!/^27[6-8]\d{8}$/.test(number)) return setError('Enter a mobile number like 27821234567.');
          setError(undefined);
          setBusy(true);
          try {
            onStarted(await staffApi<Conversation>('/api/staff/whatsapp', { method: 'POST', body: { tenant_id: tenant, number } }));
          } catch (err) {
            setError(message(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {error ? <Callout tone="refused" title={error} /> : null}
        <Field id="wa-tenant" label="Inviting buyer">
          {(p) => <Select {...p} value={tenant} onValueChange={setTenant} options={(tenants.data ?? []).map((t) => ({ value: t.id, label: t.legal_name }))} />}
        </Field>
        <Field id="wa-number" label="Supplier’s mobile number" hint="Any test number: the sandbox sends nothing.">
          {(p) => <Input {...p} mono inputMode="numeric" value={number} onChange={(e) => setNumber(e.target.value.replace(/\D/g, ''))} />}
        </Field>
        <Button type="submit" loading={busy}>
          Send the invitation
        </Button>
      </form>
    </Sheet>
  );
}

function Bubble({ m, onReply, busy }: { m: Message; onReply: (id: string, title: string) => void; busy: boolean }) {
  const out = m.direction === 'out';
  const b = m.body as { text?: string; buttons?: Array<{ id: string; title: string }>; rows?: Array<{ id: string; title: string; description?: string }>; button?: string; sample?: string; name?: string };
  const options = b.buttons ?? b.rows ?? [];
  return (
    <li className={cn('flex flex-col gap-1', out ? 'items-start' : 'items-end')}>
      <span className="sr-only">{out ? 'TshepoVet bot:' : 'Supplier:'}</span>
      <div className={cn('max-w-[85%] rounded-sheet px-4 py-2.5 whitespace-pre-wrap break-words', out ? 'border border-rule bg-sheet' : 'bg-green-tint text-ink')}>
        {m.kind === 'media' ? <span className="italic">Sent a photo: {SAMPLES.find(([k]) => k === b.sample)?.[1] ?? b.sample}</span> : (b.text ?? b.name)}
      </div>
      {out && options.length ? (
        <div className="flex max-w-[85%] flex-wrap gap-2">
          {options.map((o) => (
            <Button key={o.id} size="sm" intent="secondary" disabled={busy} onClick={() => onReply(o.id, o.title)}>
              {o.title}
            </Button>
          ))}
        </div>
      ) : null}
      <span className="text-xs text-ink-2">{formatInstant(m.created_at)}</span>
    </li>
  );
}

function Phone({ c }: { c: Conversation }) {
  const q = useQuery<Message[], ApiProblem>({
    queryKey: ['staff', 'wa', c.id],
    queryFn: () => staffApi<Message[]>(`/api/staff/whatsapp/${c.id}/messages`),
    refetchInterval: 2000,
    retry: false,
  });
  const [text, setText] = useState('');
  const [sample, setSample] = useState<string>(SAMPLES[0][0]);
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLLIElement>(null);
  const count = q.data?.length ?? 0;
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [count]);
  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await staffApi(`/api/staff/whatsapp/${c.id}/messages`, { method: 'POST', body });
      await q.refetch();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={<span className="font-mono">+{c.number}</span>} description={`Invited by ${c.tenant}`} actions={<Stamp tone="pending">{humanise(c.state.toLowerCase())}</Stamp>}>
      <div className="mx-auto flex w-full max-w-md flex-col gap-4">
        <div role="log" aria-label="Conversation" aria-live="polite" tabIndex={0} className="relative h-[28rem] overflow-y-auto rounded-sheet border border-rule bg-paper p-4">
          <Loaded q={q} label="The messages">
            {(msgs) => (
              <ul className="flex flex-col gap-3">
                {msgs.map((m) => (
                  <Bubble key={m.id} m={m} busy={busy} onReply={(id, title) => send({ button: { id, title } })} />
                ))}
                <li ref={end} aria-hidden="true" />
              </ul>
            )}
          </Loaded>
        </div>
        <form
          noValidate
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            void send({ text: text.trim() }).then(() => setText(''));
          }}
        >
          <Field id="wa-text" label="Message">
            {(p) => <Input {...p} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />}
          </Field>
          <Button type="submit" loading={busy} className="self-end">
            Send
          </Button>
        </form>
        <div className="flex flex-wrap items-end gap-2">
          <Field id="wa-sample" label="Send a photo of a sample document">
            {(p) => <Select {...p} value={sample} onValueChange={setSample} options={SAMPLES.map(([v, l]) => ({ value: v, label: l }))} />}
          </Field>
          <Button intent="secondary" disabled={busy} onClick={() => send({ sample })}>
            Send the photo
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
