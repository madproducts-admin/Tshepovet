'use client';

import { Plus, RotateCw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { z } from 'zod';
import { API_SCOPES, WEBHOOK_EVENT_TYPES, type ApiKeySchema, type CreatedApiKeySchema, type DeliveryPageSchema, type WebhookEndpointSchema, type WebhookWithSecretSchema } from '@tshepovet/contracts';
import { Button } from '@/components/ui/button';
import { CodeBlock, type Column, DataTable, Pagination, SecretReveal, Tabs, When } from '@/components/ui/data';
import { Callout, Stamp } from '@/components/ui/feedback';
import { Checkbox, Field, Input, RadioGroup, Select } from '@/components/ui/form';
import { PageHeader, Sheet } from '@/components/ui/layout';
import { ConfirmDialog, Dialog, DialogClose } from '@/components/ui/overlay';
import { api, ApiProblem } from '@/lib/api';
import { useApi, useChange } from '@/lib/queries';
import { Loaded } from './common';

type ApiKey = z.infer<typeof ApiKeySchema>;
type CreatedKey = z.infer<typeof CreatedApiKeySchema>;
type Endpoint = z.infer<typeof WebhookEndpointSchema>;
type WithSecret = z.infer<typeof WebhookWithSecretSchema>;
type Deliveries = z.infer<typeof DeliveryPageSchema>;

const EVENT_LABELS: Record<string, string> = {
  'verification.completed': 'A check finished',
  'verification.failed': 'A check could not be completed',
  'vendor.compliance_changed': 'A supplier’s compliance changed',
  'document.expiring': 'A document is about to expire',
  'document.expired': 'A document expired',
  'vendor.payment_locked': 'Payments to a supplier were locked',
  'wallet.low_balance': 'The wallet is running low',
};

export function DevelopersPage() {
  return (
    <>
      <PageHeader
        title="Developers"
        description={
          <>
            Connect your own systems to TshepoVet through the API. <a href="/docs/">Read the API documentation</a>
          </>
        }
      />
      <Tabs
        label="Developer tools"
        tabs={[
          { value: 'keys', label: 'API keys', content: <Keys /> },
          { value: 'webhooks', label: 'Webhooks', content: <Webhooks /> },
          { value: 'try', label: 'Try the API', content: <TryIt /> },
        ]}
      />
    </>
  );
}

function Keys() {
  const q = useApi<ApiKey[]>('/api/developers/keys');
  const revoke = useChange((id: string) => api(`/api/developers/keys/${id}`, { method: 'DELETE' }), { invalidate: ['/api/developers/keys'], success: 'Key revoked' });
  const cols: Column<ApiKey>[] = [
    { key: 'name', header: 'Name', rowHeader: true, cell: (k) => <span className="font-semibold">{k.name}</span> },
    { key: 'prefix', header: 'Key starts', cell: (k) => <span className="font-mono">{k.prefix}</span> },
    { key: 'env', header: 'Kind', cell: (k) => (k.environment === 'test' ? 'Test (free, test data)' : 'Live') },
    { key: 'used', header: 'Last used', cell: (k) => (k.last_used_at ? <When value={k.last_used_at} /> : <span className="text-ink-2">Never</span>) },
    {
      key: 'state',
      header: 'State',
      cell: (k) =>
        k.revoked_at ? (
          <Stamp tone="neutral">Revoked</Stamp>
        ) : k.expires_at && new Date(k.expires_at) < new Date() ? (
          <Stamp tone="neutral">Expired</Stamp>
        ) : (
          <Stamp tone="verified">Active</Stamp>
        ),
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (k) =>
        k.revoked_at ? null : (
          <ConfirmDialog
            trigger={
              <Button intent="quiet" size="sm">
                Revoke
              </Button>
            }
            title={`Revoke “${k.name}”?`}
            consequence={
              <p>
                Systems using <span className="font-mono">{k.prefix}</span> stop working at once. This cannot be undone: you would make a new key.
              </p>
            }
            confirmLabel="Revoke key"
            destructive
            busy={revoke.isPending}
            onConfirm={() => revoke.mutate(k.id)}
          />
        ),
    },
  ];
  return (
    <Sheet title="API keys" description="A key lets one of your systems call TshepoVet as your organisation. Keep keys out of code and browsers." actions={<CreateKey />} flush>
      <Loaded q={q} label="API keys">
        {(keys) => <DataTable caption="API keys" captionHidden columns={cols} rows={keys} rowKey={(k) => k.id} empty="No keys yet. Make a test key to try the API." />}
      </Loaded>
    </Sheet>
  );
}

function CreateKey() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [env, setEnv] = useState('test');
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const create = useChange((b: unknown) => api<CreatedKey>('/api/developers/keys', { method: 'POST', body: b }), { invalidate: ['/api/developers/keys'] });
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setCreated(null);
          setName('');
        }
      }}
      title={created ? 'Your new key' : 'Make an API key'}
      trigger={
        <Button>
          <Plus aria-hidden="true" />
          Make a key
        </Button>
      }
      footer={
        created ? (
          <DialogClose asChild>
            <Button>I have stored it</Button>
          </DialogClose>
        ) : (
          <>
            <DialogClose asChild>
              <Button intent="secondary">Cancel</Button>
            </DialogClose>
            <Button
              loading={create.isPending}
              onClick={async () => {
                if (!name.trim()) {
                  setError('Name the key after the system that will use it.');
                  return;
                }
                setError(undefined);
                try {
                  setCreated(await create.mutateAsync({ name, environment: env, scopes: [...API_SCOPES] }));
                } catch (e) {
                  setError(e instanceof ApiProblem ? e.message : 'The key could not be made.');
                }
              }}
            >
              Make key
            </Button>
          </>
        )
      }
    >
      {created ? (
        <SecretReveal label={`${created.api_key.name} (${created.api_key.environment === 'test' ? 'test' : 'live'})`} secret={created.secret} />
      ) : (
        <div className="flex flex-col gap-5">
          <Field label="Name" hint="For example: Sage integration." error={error}>
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />}
          </Field>
          <RadioGroup
            legend="Kind"
            value={env}
            onValueChange={setEnv}
            options={[
              { value: 'test', label: 'Test key', hint: 'Free. Answers come from test data.' },
              { value: 'live', label: 'Live key', hint: 'Charged from your wallet. Not available in the sandbox.' },
            ]}
          />
        </div>
      )}
    </Dialog>
  );
}

function Webhooks() {
  const q = useApi<Endpoint[]>('/api/developers/webhooks');
  return (
    <div className="flex flex-col gap-6">
      <Sheet
        title="Webhook endpoints"
        description="TshepoVet sends events to these addresses, signed with the endpoint’s secret. Addresses must use https on the public internet."
        actions={<CreateWebhook />}
      >
        <Loaded q={q} label="Webhook endpoints">
          {(eps) =>
            eps.length ? (
              <ul className="flex flex-col divide-y divide-rule">
                {eps.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <Link href={`/app/developers/webhooks/${e.id}`} className="font-mono break-all">
                        {e.url}
                      </Link>
                      <p className="text-sm text-ink-2">
                        {e.description ? `${e.description}. ` : ''}
                        {e.events.length} event{e.events.length === 1 ? '' : 's'}
                        {e.consecutive_failures ? `, ${e.consecutive_failures} failed in a row` : ''}
                      </p>
                    </div>
                    {e.status === 'active' ? <Stamp tone="verified">Sending</Stamp> : <Stamp tone="neutral">Paused</Stamp>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-2">No endpoints yet.</p>
            )
          }
        </Loaded>
      </Sheet>
      <CodeBlock
        label="Check a signature (Node.js)"
        code={`import crypto from 'node:crypto';

// header: the TshepoVet-Signature header, rawBody: the request body as received
export function verify(header, rawBody, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex');
  return header.split(',').filter((p) => p.startsWith('v1=')).some((p) =>
    crypto.timingSafeEqual(Buffer.from(p.slice(3)), Buffer.from(expected)));
}`}
      />
    </div>
  );
}

function EventsField({ events, setEvents }: { events: string[]; setEvents: (e: string[]) => void }) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 font-semibold">Events to send</legend>
      {WEBHOOK_EVENT_TYPES.map((t) => (
        <Checkbox key={t} label={EVENT_LABELS[t] ?? t} hint={t} checked={events.includes(t)} onCheckedChange={(on) => setEvents(on ? [...events, t] : events.filter((x) => x !== t))} />
      ))}
    </fieldset>
  );
}

function CreateWebhook() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('https://');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<string[]>(['verification.completed', 'verification.failed']);
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<WithSecret | null>(null);
  const create = useChange((b: unknown) => api<WithSecret>('/api/developers/webhooks', { method: 'POST', body: b }), { invalidate: ['/api/developers/webhooks'] });
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setCreated(null);
      }}
      title={created ? 'Endpoint added' : 'Add a webhook endpoint'}
      wide
      trigger={
        <Button>
          <Plus aria-hidden="true" />
          Add endpoint
        </Button>
      }
      footer={
        created ? (
          <DialogClose asChild>
            <Button>I have stored the secret</Button>
          </DialogClose>
        ) : (
          <>
            <DialogClose asChild>
              <Button intent="secondary">Cancel</Button>
            </DialogClose>
            <Button
              loading={create.isPending}
              onClick={async () => {
                if (!events.length) return setError('Choose at least one event.');
                setError(undefined);
                try {
                  setCreated(await create.mutateAsync({ url: url.trim(), events, ...(description ? { description } : {}) }));
                } catch (e) {
                  setError(e instanceof ApiProblem ? e.message : 'The endpoint could not be added.');
                }
              }}
            >
              Add endpoint
            </Button>
          </>
        )
      }
    >
      {created ? (
        <SecretReveal label="Signing secret" secret={created.secret} />
      ) : (
        <div className="flex flex-col gap-5">
          {error ? <Callout tone="refused" title={error} /> : null}
          <Field label="Address" hint="Where TshepoVet should send events. It must start with https://.">
            {(p) => <Input {...p} type="url" mono value={url} onChange={(e) => setUrl(e.target.value)} />}
          </Field>
          <Field label="Description" optional>
            {(p) => <Input {...p} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />}
          </Field>
          <EventsField events={events} setEvents={setEvents} />
        </div>
      )}
    </Dialog>
  );
}

export function WebhookDetail({ id }: { id: string }) {
  const eps = useApi<Endpoint[]>('/api/developers/webhooks');
  const [page, setPage] = useState(1);
  const deliveries = useApi<Deliveries>(`/api/developers/webhooks/${id}/deliveries`, { page, page_size: 20 });
  const ep = eps.data?.find((e) => e.id === id);
  const [rotated, setRotated] = useState<string | null>(null);
  const toggle = useChange((status: string) => api(`/api/developers/webhooks/${id}`, { method: 'PATCH', body: { status } }), {
    invalidate: ['/api/developers/webhooks'],
    success: (r) => ((r as Endpoint).status === 'active' ? 'Endpoint resumed' : 'Endpoint paused'),
  });
  const rotate = useChange(() => api<WithSecret>(`/api/developers/webhooks/${id}/rotate-secret`, { method: 'POST' }), {
    invalidate: ['/api/developers/webhooks'],
    onSuccess: (r) => setRotated(r.secret),
  });
  const replay = useChange((d: string) => api(`/api/developers/webhooks/${id}/deliveries/${d}/replay`, { method: 'POST' }), {
    invalidate: [`/api/developers/webhooks/${id}/deliveries`],
    success: 'Delivery queued again',
  });
  type D = Deliveries['items'][number];
  const cols: Column<D>[] = [
    { key: 'event', header: 'Event', rowHeader: true, cell: (d) => <span className="font-mono text-sm">{d.event_type}</span> },
    { key: 'when', header: 'Sent', cell: (d) => <When value={d.event_created_at} /> },
    {
      key: 'status',
      header: 'Result',
      cell: (d) =>
        d.status === 'succeeded' ? (
          <Stamp tone="verified">Delivered</Stamp>
        ) : d.status === 'dead' ? (
          <Stamp tone="refused">Gave up</Stamp>
        ) : d.status === 'failed' ? (
          <Stamp tone="caution">Retrying</Stamp>
        ) : (
          <Stamp tone="pending">Queued</Stamp>
        ),
    },
    { key: 'http', header: 'Answer', cell: (d) => (d.last_http_status ? `HTTP ${d.last_http_status}` : d.last_error ?? '') },
    { key: 'attempts', header: 'Attempts', align: 'end', cell: (d) => d.attempts },
    {
      key: 'replay',
      header: 'Actions',
      cell: (d) =>
        ['succeeded', 'failed', 'dead'].includes(d.status) ? (
          <Button intent="quiet" size="sm" onClick={() => replay.mutate(d.id)}>
            <RotateCw aria-hidden="true" />
            Send again
          </Button>
        ) : null,
    },
  ];
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Developers', href: '/app/developers' }, { label: 'Webhook endpoint' }]}
        title={<span className="font-mono text-2xl break-all">{ep?.url ?? 'Webhook endpoint'}</span>}
        meta={ep ? ep.status === 'active' ? <Stamp tone="verified">Sending</Stamp> : <Stamp tone="neutral">Paused</Stamp> : null}
        actions={
          ep ? (
            <>
              <Button intent="secondary" loading={toggle.isPending} onClick={() => toggle.mutate(ep.status === 'active' ? 'disabled' : 'active')}>
                {ep.status === 'active' ? 'Pause' : 'Resume'}
              </Button>
              <ConfirmDialog
                trigger={<Button intent="secondary">Rotate the secret</Button>}
                title="Make a new signing secret?"
                consequence={<p>For 24 hours, every delivery is signed with both the old and the new secret, so you can switch your receiver without missing events.</p>}
                confirmLabel="Make a new secret"
                busy={rotate.isPending}
                onConfirm={() => rotate.mutate(undefined)}
              />
            </>
          ) : null
        }
      />
      {rotated ? (
        <Sheet title="New signing secret" className="mb-6">
          <SecretReveal label="New secret" secret={rotated} />
        </Sheet>
      ) : null}
      <Sheet title="Deliveries" description="Failed deliveries are retried for about a day and a half, waiting longer each time." flush>
        <Loaded q={deliveries} label="Deliveries">
          {(p) => (
            <>
              <DataTable caption="Deliveries" captionHidden columns={cols} rows={p.items} rowKey={(d) => d.id} empty="Nothing sent yet." />
              <div className="border-t border-rule">
                <Pagination page={p.page} pageSize={p.page_size} total={p.total} noun={['delivery', 'deliveries']} onPage={setPage} />
              </div>
            </>
          )}
        </Loaded>
      </Sheet>
    </>
  );
}

/** A real /v1 call from the browser with a test key the user pastes in (it never leaves this page). */
function TryIt() {
  const [key, setKey] = useState('');
  const [reg, setReg] = useState('2019/123456/07');
  const [kind, setKind] = useState('verified');
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const samples: Record<string, string> = { verified: '2019/123456/07', not_found: '2019/000404/07', deregistering: '2019/000777/07', new_director: '2019/000888/07' };
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Sheet title="Call the API" description="Uses a test key: free, and answered by test data.">
        <div className="flex flex-col gap-5">
          <Field label="Test key" hint="Starts with tv_test_. It is used for this call only and not stored.">
            {(p) => <Input {...p} type="password" mono autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />}
          </Field>
          <Field label="Scenario">
            {(p) => (
              <Select
                {...p}
                value={kind}
                onValueChange={(v) => {
                  setKind(v);
                  setReg(samples[v]!);
                }}
                options={[
                  { value: 'verified', label: 'A company that verifies' },
                  { value: 'not_found', label: 'Not on the register' },
                  { value: 'deregistering', label: 'Being deregistered' },
                  { value: 'new_director', label: 'A director appointed 10 days ago' },
                ]}
              />
            )}
          </Field>
          <Field label="Registration number">{(p) => <Input {...p} mono value={reg} onChange={(e) => setReg(e.target.value)} />}</Field>
          <div>
            <Button
              loading={busy}
              disabled={!key.startsWith('tv_test_')}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await fetch('/v1/verify/company', {
                    method: 'POST',
                    headers: { authorization: `Bearer ${key.trim()}`, 'content-type': 'application/json' },
                    body: JSON.stringify({ registration_number: reg }),
                  });
                  setResult(`HTTP ${r.status}\n\n${JSON.stringify(await r.json(), null, 2)}`);
                } catch {
                  setResult('The request did not reach TshepoVet.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Send request
            </Button>
          </div>
        </div>
      </Sheet>
      <div aria-live="polite">{result ? <CodeBlock label="Response" code={result} /> : <p className="text-ink-2">The response appears here.</p>}</div>
    </div>
  );
}

