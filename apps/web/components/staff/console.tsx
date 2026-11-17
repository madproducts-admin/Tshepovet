'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import type { z } from 'zod';
import type {
  PriceSchema,
  PurgeRunSchema,
  ReviewQueueSchema,
  StaffMailPageSchema,
  StaffMailSchema,
  StaffOverviewSchema,
  StaffProviderSchema,
  StaffRequestSchema,
  StaffTenantPageSchema,
  StaffTenantSchema,
} from '@tshepovet/contracts';
import { humanise, Loaded } from '@/components/portal/common';
import { Button } from '@/components/ui/button';
import { type Column, DataTable, Money, Pagination, When } from '@/components/ui/data';
import { Callout, EmptyState, Stamp, type Tone } from '@/components/ui/feedback';
import { Field, Input, RadioGroup, SearchField, Select, Switch, Textarea } from '@/components/ui/form';
import { PageHeader, RecordList, Sheet, Stat } from '@/components/ui/layout';
import { Dialog, DialogClose } from '@/components/ui/overlay';
import { toast } from '@/components/ui/toast';
import { ApiProblem, staffApi } from '@/lib/api';
import { formatDay, formatInstant, formatPercent } from '@/lib/format';
import { hasRole, RequireRole, useStaffSession } from './shell';

/** The staff console's pages (docs/PLAN.md M8). Every change asks for a reason it records. */
type Q = Record<string, string | number | undefined>;
function useStaff<T>(path: string | null, query?: Q, refetchInterval?: number) {
  return useQuery<T, ApiProblem>({ queryKey: ['staff', path, query ?? {}], queryFn: () => staffApi<T>(path!, { query }), enabled: Boolean(path), refetchInterval, retry: false });
}
function useRefresh() {
  const qc = useQueryClient();
  return (prefix: string) => qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'staff' && String(q.queryKey[1]).startsWith(prefix) });
}
const message = (e: unknown) => (e instanceof ApiProblem ? e.message : 'TshepoVet could not be reached. Check your connection and try again.');

// --- Overview ------------------------------------------------------------------------------
type Overview = z.infer<typeof StaffOverviewSchema>;
export function StaffOverview() {
  const s = useStaffSession();
  const q = useStaff<Overview>('/api/staff/overview', undefined, 30_000);
  return (
    <>
      <PageHeader title="Staff console" description={`Signed in as ${s.staff.full_name} (${s.staff.role}).`} />
      <Loaded q={q} label="The overview">
        {(o) => (
          <div className="flex flex-col gap-6">
            {o.sandbox ? (
              <Callout tone="info" title="This is the sandbox" announce={false}>
                <p>Mail is held in the outbox, WhatsApp runs in the simulator, and checks answer from the mock bureau.</p>
              </Callout>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Stat
                label="Waiting for review"
                value={o.review.documents + o.review.handoffs}
                detail={`${o.review.documents} documents, ${o.review.handoffs} WhatsApp hand-offs`}
                {...(hasRole(s, ['reviewer', 'admin']) ? { href: '/staff/review', linkLabel: 'Open the review queue' } : {})}
              />
              <Stat
                label="Open data requests"
                value={o.requests.open}
                detail={`${o.requests.overdue} overdue, ${o.requests.due_within_7_days} due within 7 days`}
                {...(hasRole(s, ['support', 'admin']) ? { href: '/staff/requests', linkLabel: 'See the requests' } : {})}
              />
              <Stat label="Tenants" value={o.tenants.active} detail={`${o.tenants.suspended} suspended`} {...(hasRole(s, ['support', 'admin']) ? { href: '/staff/tenants', linkLabel: 'See the tenants' } : {})} />
              <Stat
                label="Checks in the last 24 hours"
                value={o.verifications.last_24h}
                detail={`${o.verifications.failed_24h} failed, ${o.verifications.processing} still running`}
              />
            </div>
            <Sheet title="Housekeeping">
              <RecordList
                items={[
                  { label: 'Mail held in the sandbox outbox', value: o.mail.held, note: o.mail.queued ? `${o.mail.queued} waiting for the worker` : undefined },
                  { label: 'Last retention purge', value: o.last_purge_at ? formatInstant(o.last_purge_at) : 'Not yet' },
                ]}
              />
            </Sheet>
          </div>
        )}
      </Loaded>
    </>
  );
}

// --- Review queue --------------------------------------------------------------------------
type Review = z.infer<typeof ReviewQueueSchema>;
const FLAG_LABELS: Record<string, string> = {
  not_listed_director: 'Not a director on the register',
  embedded_instructions_detected: 'Text in the image addressed the reader',
  low_confidence: 'Unsure of some fields',
};
export function ReviewQueue() {
  const q = useStaff<Review>('/api/staff/review');
  const [target, setTarget] = useState<Review['documents'][number] | null>(null);
  const documents: Column<Review['documents'][number]>[] = [
    { key: 'supplier', header: 'Supplier', rowHeader: true, cell: (d) => <span className="font-semibold">{d.supplier}</span> },
    { key: 'document', header: 'Document', cell: (d) => (d.level ? `${d.document_name} (level ${d.level})` : d.document_name) },
    { key: 'why', header: 'Why it waits', cell: (d) => (d.flags.length ? d.flags.map((f) => FLAG_LABELS[f] ?? humanise(f)).join('; ') : 'Needs a second look') },
    { key: 'buyer', header: 'Buyer', cell: (d) => d.tenant ?? 'Shared record' },
    { key: 'since', header: 'Waiting since', cell: (d) => <When value={d.created_at} /> },
    {
      key: 'actions',
      header: 'Actions',
      cell: (d) => (
        <Button size="sm" onClick={() => setTarget(d)}>
          Decide<span className="sr-only"> on the {d.document_name} of {d.supplier}</span>
        </Button>
      ),
    },
  ];
  const handoffs: Column<Review['handoffs'][number]>[] = [
    { key: 'tenant', header: 'Buyer', rowHeader: true, cell: (h) => <span className="font-semibold">{h.tenant}</span> },
    { key: 'supplier', header: 'Supplier', cell: (h) => h.supplier ?? 'Not identified yet' },
    { key: 'reason', header: 'Why', cell: (h) => (h.reason ? humanise(h.reason) : null) },
    { key: 'since', header: 'Waiting since', cell: (h) => <When value={h.since} /> },
    { key: 'open', header: 'Conversation', cell: (h) => <Link href={`/staff/whatsapp?c=${h.id}`}>Open it</Link> },
  ];
  return (
    <RequireRole roles={['reviewer', 'admin']}>
      <PageHeader title="Review queue" description="Documents the software could not decide, and WhatsApp conversations that asked for a person." />
      <Loaded q={q} label="The review queue">
        {(r) => (
          <div className="flex flex-col gap-6">
            <Sheet title="Documents" flush>
              <DataTable caption="Documents waiting for review" captionHidden columns={documents} rows={r.documents} rowKey={(d) => d.id} empty="No documents are waiting." />
            </Sheet>
            <Sheet title="WhatsApp hand-offs" flush>
              <DataTable caption="Conversations waiting for a person" captionHidden columns={handoffs} rows={r.handoffs} rowKey={(h) => h.id} empty="No conversation is waiting for a person." />
            </Sheet>
          </div>
        )}
      </Loaded>
      {target ? <DecideDialog doc={target} onClose={() => setTarget(null)} /> : null}
    </RequireRole>
  );
}

function DecideDialog({ doc, onClose }: { doc: Review['documents'][number]; onClose: () => void }) {
  const [decision, setDecision] = useState('accepted');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const refresh = useRefresh();
  const submit = async () => {
    if (!note.trim()) return setError('Say why: the buyer sees it in the supplier’s record.');
    setBusy(true);
    try {
      await staffApi(`/api/staff/review/documents/${doc.id}`, { method: 'POST', body: { decision, note: note.trim() } });
      toast.success(decision === 'accepted' ? 'Document accepted' : 'Document rejected');
      await refresh('/api/staff');
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${doc.document_name}: ${doc.supplier}`}
      description="The decision and your reason go into the buyer’s audit log."
      footer={
        <>
          <DialogClose asChild>
            <Button intent="secondary">Cancel</Button>
          </DialogClose>
          <Button loading={busy} onClick={submit}>
            Record the decision
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <RadioGroup
          legend="Decision"
          value={decision}
          onValueChange={setDecision}
          options={[
            { value: 'accepted', label: 'Accept it', hint: 'The document stands; B-BBEE evidence counts towards the buyer’s scorecard.' },
            { value: 'rejected', label: 'Reject it', hint: 'The supplier is asked for another one.' },
          ]}
        />
        <Field id="rv-note" label="Reason" error={error}>
          {(p) => <Textarea {...p} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

// --- Tenants -------------------------------------------------------------------------------
type TenantPage = z.infer<typeof StaffTenantPageSchema>;
const TENANT_TONE: Record<string, Tone> = { active: 'verified', suspended: 'refused', closed: 'neutral' };

export function Tenants() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const r = useStaff<TenantPage>('/api/staff/tenants', { q: q || undefined, status: status || undefined, page, page_size: 25 });
  const columns: Column<TenantPage['items'][number]>[] = [
    { key: 'name', header: 'Tenant', rowHeader: true, cell: (t) => <Link href={`/staff/tenants/${t.id}`} className="font-semibold">{t.legal_name}</Link> },
    { key: 'status', header: 'Status', cell: (t) => <Stamp tone={TENANT_TONE[t.status] ?? 'neutral'}>{humanise(t.status)}</Stamp> },
    { key: 'users', header: 'Users', align: 'end', cell: (t) => t.users },
    { key: 'suppliers', header: 'Suppliers', align: 'end', cell: (t) => t.suppliers },
    { key: 'balance', header: 'Wallet', align: 'end', cell: (t) => <Money cents={t.balance_cents} /> },
    { key: 'since', header: 'Joined', cell: (t) => formatDay(t.created_at) },
  ];
  return (
    <RequireRole roles={['support', 'admin']}>
      <PageHeader title="Tenants" description="Opening a tenant is recorded in its audit log as a support view." />
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <SearchField label="Search by name" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} />
        <Field id="tn-status" label="Status">
          {(p) => (
            <Select
              {...p}
              value={status || 'all'}
              onValueChange={(v) => (setStatus(v === 'all' ? '' : v), setPage(1))}
              options={[
                { value: 'all', label: 'Any status' },
                { value: 'active', label: 'Active' },
                { value: 'suspended', label: 'Suspended' },
                { value: 'closed', label: 'Closed' },
              ]}
            />
          )}
        </Field>
      </div>
      <Loaded q={r} label="Tenants">
        {(p) => (
          <Sheet flush>
            <DataTable caption="Tenants" captionHidden columns={columns} rows={p.items} rowKey={(t) => t.id} empty="No tenant matches." />
            <div className="border-t border-rule px-4 py-3">
              <Pagination page={p.page} pageSize={p.page_size} total={p.total} noun={['tenant', 'tenants']} onPage={setPage} />
            </div>
          </Sheet>
        )}
      </Loaded>
    </RequireRole>
  );
}

type Tenant = z.infer<typeof StaffTenantSchema>;
export function TenantDetail({ id }: { id: string }) {
  const s = useStaffSession();
  const q = useStaff<Tenant>(`/api/staff/tenants/${id}`);
  const refresh = useRefresh();
  const [chain, setChain] = useState<{ intact: boolean; entries_checked: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const unlock = async (userId: string) => {
    try {
      await staffApi(`/api/staff/users/${userId}/unlock`, { method: 'POST' });
      toast.success('User unlocked');
      await refresh(`/api/staff/tenants/${id}`);
    } catch (e) {
      toast.error(message(e));
    }
  };
  return (
    <RequireRole roles={['support', 'admin']}>
      <Loaded q={q} label="The tenant">
        {(t) => (
          <>
            <PageHeader
              crumbs={[{ label: 'Tenants', href: '/staff/tenants' }, { label: t.legal_name }]}
              title={t.legal_name}
              meta={<Stamp tone={TENANT_TONE[t.status] ?? 'neutral'}>{humanise(t.status)}</Stamp>}
              actions={
                <>
                  <Button
                    intent="secondary"
                    loading={checking}
                    onClick={async () => {
                      setChecking(true);
                      try {
                        setChain(await staffApi(`/api/staff/tenants/${id}/verify-chain`, { method: 'POST' }));
                      } catch (e) {
                        toast.error(message(e));
                      } finally {
                        setChecking(false);
                      }
                    }}
                  >
                    Verify the audit chain
                  </Button>
                  {s.staff.role === 'admin' && t.status !== 'closed' ? <TenantStatus id={id} current={t.status} /> : null}
                </>
              }
            />
            <div className="flex flex-col gap-6">
              <Callout tone="info" title="This view is on the tenant’s record" announce={false}>
                <p>Opening it was written to the tenant’s audit log as a support view by you.</p>
              </Callout>
              {chain ? (
                <Callout tone={chain.intact ? 'verified' : 'refused'} title={chain.intact ? `The audit chain is intact (${chain.entries_checked} entries)` : 'The audit chain is broken'} />
              ) : null}
              <Sheet title="Account">
                <RecordList
                  columns={3}
                  items={[
                    { label: 'Wallet balance', value: <Money cents={t.balance_cents} />, note: t.held_cents ? <>Held for checks: <Money cents={t.held_cents} /></> : undefined },
                    { label: 'Suppliers', value: t.counts.suppliers, note: `${t.counts.monitored} monitored` },
                    { label: 'Checks in 30 days', value: t.counts.verifications_30d },
                    { label: 'Joined', value: formatDay(t.created_at) },
                  ]}
                />
              </Sheet>
              <Sheet title="Users" flush>
                <DataTable
                  caption="Users"
                  captionHidden
                  rows={t.users}
                  rowKey={(u) => u.id}
                  columns={[
                    { key: 'name', header: 'Name', rowHeader: true, cell: (u) => <span className="font-semibold">{u.full_name}</span> },
                    { key: 'email', header: 'Email', cell: (u) => u.email },
                    { key: 'role', header: 'Role', cell: (u) => humanise(u.role) },
                    { key: 'mfa', header: 'Two-step', cell: (u) => (u.mfa_enrolled ? 'On' : 'Off') },
                    {
                      key: 'state',
                      header: 'State',
                      cell: (u) =>
                        u.disabled ? (
                          <Stamp tone="neutral">Removed</Stamp>
                        ) : u.locked_until ? (
                          <Stamp tone="caution">Locked until {formatInstant(u.locked_until)}</Stamp>
                        ) : (
                          <Stamp tone="verified">Active</Stamp>
                        ),
                    },
                    {
                      key: 'actions',
                      header: 'Actions',
                      cell: (u) =>
                        u.locked_until && !u.disabled ? (
                          <Button size="sm" intent="secondary" onClick={() => unlock(u.id)}>
                            Unlock<span className="sr-only"> {u.full_name}</span>
                          </Button>
                        ) : null,
                    },
                  ]}
                />
              </Sheet>
              <Sheet title="Recent activity" description="The last 20 entries of the tenant’s audit log." flush>
                <DataTable
                  caption="Recent activity"
                  captionHidden
                  rows={t.recent_activity}
                  rowKey={(a) => `${a.occurred_at}-${a.action}`}
                  columns={[
                    { key: 'action', header: 'What', rowHeader: true, cell: (a) => <span className="font-mono text-sm">{a.action}</span> },
                    { key: 'actor', header: 'By', cell: (a) => (a.actor_type === 'tshepovet_staff' ? 'TshepoVet staff' : humanise(a.actor_type)) },
                    { key: 'when', header: 'When', cell: (a) => <When value={a.occurred_at} /> },
                  ]}
                />
              </Sheet>
            </div>
          </>
        )}
      </Loaded>
    </RequireRole>
  );
}

function TenantStatus({ id, current }: { id: string; current: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const refresh = useRefresh();
  const next = current === 'active' ? 'suspended' : 'active';
  const label = next === 'suspended' ? 'Suspend the tenant' : 'Reinstate the tenant';
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title={label}
      description={
        next === 'suspended'
          ? 'Every user is signed out at once and API keys stop working until the tenant is reinstated.'
          : 'Users can sign in again and API keys work again.'
      }
      trigger={<Button intent={next === 'suspended' ? 'danger' : 'primary'}>{label}</Button>}
      footer={
        <>
          <DialogClose asChild>
            <Button intent="secondary">Cancel</Button>
          </DialogClose>
          <Button
            intent={next === 'suspended' ? 'danger' : 'primary'}
            loading={busy}
            onClick={async () => {
              if (!reason.trim()) return setError('Give a reason: it is kept in the tenant’s audit log.');
              setBusy(true);
              try {
                await staffApi(`/api/staff/tenants/${id}/status`, { method: 'POST', body: { status: next, reason: reason.trim() } });
                toast.success(next === 'suspended' ? 'Tenant suspended' : 'Tenant reinstated');
                await refresh('/api/staff/tenants');
                setOpen(false);
              } catch (e) {
                setError(message(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {label}
          </Button>
        </>
      }
    >
      <Field id="ts-reason" label="Reason" error={error}>
        {(p) => <Textarea {...p} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
    </Dialog>
  );
}

// --- Data-subject requests -------------------------------------------------------------------
type Req = z.infer<typeof StaffRequestSchema>;
export function Requests() {
  const q = useStaff<Req[]>('/api/staff/requests');
  return (
    <RequireRole roles={['support', 'admin']}>
      <PageHeader title="Data requests" description="Requests to see, correct or delete information, across all tenants. Each buyer must answer within 30 days." />
      <Loaded q={q} label="The requests">
        {(rows) => (
          <Sheet flush>
            <DataTable
              caption="Open data requests"
              captionHidden
              rows={rows}
              rowKey={(r) => r.id}
              empty="No open requests."
              columns={[
                { key: 'type', header: 'Request', rowHeader: true, cell: (r) => <span className="font-semibold">{humanise(r.request_type)}</span> },
                { key: 'tenant', header: 'Buyer', cell: (r) => r.tenant },
                { key: 'supplier', header: 'Supplier', cell: (r) => r.supplier },
                { key: 'status', header: 'Status', cell: (r) => humanise(r.status) },
                {
                  key: 'due',
                  header: 'Answer due',
                  cell: (r) => (
                    <Stamp tone={r.days_left < 0 ? 'refused' : r.days_left <= 7 ? 'caution' : 'pending'}>
                      {r.days_left < 0 ? `${-r.days_left} days overdue` : `${formatDay(r.due_at)} (${r.days_left} days)`}
                    </Stamp>
                  ),
                },
              ]}
            />
          </Sheet>
        )}
      </Loaded>
    </RequireRole>
  );
}

// --- Bureaus and prices ----------------------------------------------------------------------
type Provider = z.infer<typeof StaffProviderSchema>;
type Price = z.infer<typeof PriceSchema>;
const CIRCUIT: Record<string, { tone: Tone; label: string }> = {
  closed: { tone: 'verified', label: 'Healthy' },
  half_open: { tone: 'caution', label: 'Recovering' },
  open: { tone: 'refused', label: 'Failing: skipped' },
};

export function Bureaus() {
  const providers = useStaff<Provider[]>('/api/staff/providers', undefined, 30_000);
  const prices = useStaff<Price[]>('/api/staff/prices');
  const refresh = useRefresh();
  const toggle = async (code: string, capability: string, enabled: boolean) => {
    try {
      await staffApi(`/api/staff/providers/${code}/${capability}`, { method: 'PATCH', body: { enabled } });
      toast.success(enabled ? 'Capability turned on' : 'Capability turned off');
      await refresh('/api/staff/providers');
    } catch (e) {
      toast.error(message(e));
    }
  };
  return (
    <RequireRole roles={['admin']}>
      <PageHeader title="Bureaus and prices" description="Which bureaus answer which checks, how they are doing, and what customers pay." />
      <div className="flex flex-col gap-6">
        <Loaded q={providers} label="The bureaus">
          {(list) => (
            <>
              {list.map((p) => (
                <Sheet
                  key={p.code}
                  title={p.name}
                  description={p.operator_agreement_signed_on ? `Operator agreement signed ${formatDay(p.operator_agreement_signed_on)}` : 'No operator agreement on record'}
                  flush
                >
                  <DataTable
                    caption={`${p.name} capabilities`}
                    captionHidden
                    rows={p.capabilities}
                    rowKey={(c) => c.capability}
                    empty="No capabilities configured."
                    columns={[
                      { key: 'cap', header: 'Check', rowHeader: true, cell: (c) => <span className="font-semibold">{humanise(c.capability)}</span> },
                      { key: 'cost', header: 'Cost to us', align: 'end', cell: (c) => <Money cents={c.unit_cost_cents} /> },
                      { key: 'source', header: 'Source', cell: (c) => (c.is_live_source ? 'Live register' : 'Bureau copy') },
                      {
                        key: 'health',
                        header: 'Health',
                        cell: (c) => (
                          <span className="flex flex-wrap items-center gap-2">
                            <Stamp tone={CIRCUIT[c.health.circuit]!.tone}>{CIRCUIT[c.health.circuit]!.label}</Stamp>
                            <span className="text-sm text-ink-2">
                              {formatPercent(c.health.success_rate)} of {c.health.samples}, {Math.round(c.health.latency_ms)} ms
                            </span>
                          </span>
                        ),
                      },
                      {
                        key: 'on',
                        header: 'In use',
                        cell: (c) => <Switch label={<span className="sr-only">{`${p.name} ${humanise(c.capability)} in use`}</span>} checked={c.enabled} onCheckedChange={(v) => toggle(p.code, c.capability, v)} />,
                      },
                    ]}
                  />
                </Sheet>
              ))}
            </>
          )}
        </Loaded>
        <Loaded q={prices} label="The price book">
          {(rows) => (
            <Sheet title="Price book" description="Prices exclude VAT. A new price starts on a date; the old one is kept." actions={<NewPrice prices={rows} />} flush>
              <DataTable
                caption="Price book"
                captionHidden
                rows={rows}
                rowKey={(r) => `${r.sku}-${r.effective_from}`}
                columns={[
                  { key: 'sku', header: 'SKU', rowHeader: true, cell: (r) => <span className="font-mono text-sm">{r.sku}</span> },
                  { key: 'what', header: 'What', cell: (r) => r.description },
                  { key: 'price', header: 'Price', align: 'end', cell: (r) => <Money cents={r.unit_price_cents} /> },
                  { key: 'from', header: 'From', cell: (r) => formatDay(r.effective_from) },
                  { key: 'to', header: 'Until', cell: (r) => (r.effective_to ? formatDay(r.effective_to) : 'Current') },
                ]}
              />
            </Sheet>
          )}
        </Loaded>
      </div>
    </RequireRole>
  );
}

function NewPrice({ prices }: { prices: Price[] }) {
  const current = prices.filter((p) => p.effective_to === null);
  const [open, setOpen] = useState(false);
  const [sku, setSku] = useState(current[0]?.sku ?? '');
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const refresh = useRefresh();
  const submit = async () => {
    const e: Record<string, string> = {};
    if (!/^\d+([.,]\d{1,2})?$/.test(amount.trim())) e.amount = 'Enter the price in rand, like 3,50.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) e.from = 'Choose the day it starts.';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const cents = Math.round(Number(amount.trim().replace(',', '.')) * 100);
      await staffApi('/api/staff/prices', { method: 'POST', body: { sku, unit_price_cents: cents, effective_from: from } });
      toast.success('Price set');
      await refresh('/api/staff/prices');
      setOpen(false);
    } catch (err) {
      setErrors({ form: message(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Set a new price"
      description="It applies to checks and charges from that day. Customers see it on the pricing page."
      trigger={<Button>Set a new price</Button>}
      footer={
        <>
          <DialogClose asChild>
            <Button intent="secondary">Cancel</Button>
          </DialogClose>
          <Button loading={busy} onClick={submit}>
            Set the price
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {errors.form ? <Callout tone="refused" title={errors.form} /> : null}
        <Field id="np-sku" label="What">
          {(p) => <Select {...p} value={sku} onValueChange={setSku} options={current.map((c) => ({ value: c.sku, label: `${c.description} (now R${(c.unit_price_cents / 100).toFixed(2).replace('.', ',')})` }))} />}
        </Field>
        <Field id="np-amount" label="New price in rand, excluding VAT" error={errors.amount}>
          {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field id="np-from" label="From" hint="Today or later." error={errors.from}>
          {(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

// --- The mail outbox -------------------------------------------------------------------------
type MailPage = z.infer<typeof StaffMailPageSchema>;
type Mail = z.infer<typeof StaffMailSchema>;
export function MailOutbox() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const r = useStaff<MailPage>('/api/staff/mail', { q: q || undefined, page, page_size: 25 });
  return (
    <RequireRole roles={['support', 'admin']}>
      <PageHeader title="Mail outbox" description="The sandbox sends no email: every message is kept here. Reading one is recorded, because it may hold a sign-in link." />
      <div className="mb-4">
        <SearchField label="Search by address or subject" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} />
      </div>
      <Loaded q={r} label="The outbox">
        {(p) => (
          <Sheet flush>
            <DataTable
              caption="Messages"
              captionHidden
              rows={p.items}
              rowKey={(m) => m.id}
              empty="No messages match."
              columns={[
                { key: 'subject', header: 'Subject', rowHeader: true, cell: (m) => <span className="font-semibold">{m.subject}</span> },
                { key: 'to', header: 'To', cell: (m) => m.to_email },
                { key: 'tenant', header: 'Tenant', cell: (m) => m.tenant },
                { key: 'when', header: 'When', cell: (m) => <When value={m.created_at} /> },
                {
                  key: 'read',
                  header: 'Message',
                  cell: (m) => (
                    <Button size="sm" intent="secondary" onClick={() => setOpen(m.id)}>
                      Read<span className="sr-only"> {m.subject}</span>
                    </Button>
                  ),
                },
              ]}
            />
            <div className="border-t border-rule px-4 py-3">
              <Pagination page={p.page} pageSize={p.page_size} total={p.total} noun={['message', 'messages']} onPage={setPage} />
            </div>
          </Sheet>
        )}
      </Loaded>
      {open ? <MailDialog id={open} onClose={() => setOpen(null)} /> : null}
    </RequireRole>
  );
}

function MailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useStaff<Mail>(`/api/staff/mail/${id}`);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={q.data?.subject ?? 'Message'} description={q.data ? `To ${q.data.to_email}, ${formatInstant(q.data.created_at)}` : undefined}>
      <Loaded q={q} label="The message">
        {(m) => <pre className="max-w-full overflow-x-auto font-sans text-base whitespace-pre-wrap break-words">{m.body_text}</pre>}
      </Loaded>
    </Dialog>
  );
}

// --- Purge runs ------------------------------------------------------------------------------
type Purge = z.infer<typeof PurgeRunSchema>;
export function PurgeRuns() {
  const q = useStaff<Purge[]>('/api/staff/purge-runs');
  return (
    <RequireRole roles={['admin']}>
      <PageHeader title="Purge runs" description="The hourly retention purge (POPIA s14): what it deleted, run by run." />
      <Loaded q={q} label="The purge runs">
        {(rows) =>
          rows.length ? (
            <Sheet flush>
              <DataTable
                caption="Purge runs"
                captionHidden
                rows={rows}
                rowKey={(r) => String(r.id)}
                columns={[
                  { key: 'when', header: 'Started', rowHeader: true, cell: (r) => formatInstant(r.started_at) },
                  { key: 'done', header: 'Finished', cell: (r) => (r.finished_at ? formatInstant(r.finished_at) : 'Still running') },
                  {
                    key: 'what',
                    header: 'Deleted',
                    cell: (r) => {
                      const parts = Object.entries(r.counts).filter(([, n]) => n > 0);
                      return parts.length ? parts.map(([k, n]) => `${n} ${humanise(k).toLowerCase()}`).join(', ') : 'Nothing due';
                    },
                  },
                ]}
              />
            </Sheet>
          ) : (
            <EmptyState title="No purge has run yet">The worker runs it every hour.</EmptyState>
          )
        }
      </Loaded>
    </RequireRole>
  );
}
