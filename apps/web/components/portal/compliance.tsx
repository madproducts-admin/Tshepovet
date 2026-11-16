'use client';

import { Plus, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { z } from 'zod';
import type { AuditListSchema, ChainVerificationSchema, ConsentPageSchema, DsrPageSchema, NoticeSchema, ProcessingActivitySchema } from '@tshepovet/contracts';
import { Button } from '@/components/ui/button';
import { type Column, DataTable, Pagination, Tabs, Term, When } from '@/components/ui/data';
import { Callout, Stamp } from '@/components/ui/feedback';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form';
import { PageHeader, Sheet } from '@/components/ui/layout';
import { Dialog, DialogClose } from '@/components/ui/overlay';
import { api, ApiProblem } from '@/lib/api';
import { formatDay } from '@/lib/format';
import { useApi, useChange, useSession } from '@/lib/queries';
import { FilterBar, humanise, Loaded } from './common';

type ConsentPage = z.infer<typeof ConsentPageSchema>;
type Consent = ConsentPage['items'][number];
type DsrPage = z.infer<typeof DsrPageSchema>;
type Dsr = DsrPage['items'][number];
type Notice = z.infer<typeof NoticeSchema>;
type Activity = z.infer<typeof ProcessingActivitySchema>;
type AuditList = z.infer<typeof AuditListSchema>;
type Chain = z.infer<typeof ChainVerificationSchema>;

const PURPOSE_LABELS: Record<string, string> = {
  kyb_company_verification: 'Company verification',
  director_identity_verification: 'Director identity',
  tax_compliance_verification: 'Tax compliance',
  driver_licence_verification: 'Driving licence',
  bbbee_verification: 'B-BBEE',
  bank_account_verification: 'Bank account',
  continuous_monitoring: 'Monitoring',
  passport_sharing: 'Passport sharing',
  conflict_of_interest_screening: 'Conflict of interest',
  document_ocr_processing: 'Reading documents',
  cross_border_processing: 'Processing outside South Africa',
  whatsapp_service_messages: 'WhatsApp messages',
  direct_marketing: 'Marketing',
};
const BASIS_LABELS: Record<string, string> = {
  consent: 'consent',
  contract: 'a contract',
  legal_obligation: 'a legal obligation',
  legitimate_interest_subject: 'the supplier’s legitimate interest',
  public_law_duty: 'a public duty',
  legitimate_interest_responsible_party: 'your legitimate interest',
};

export function CompliancePage() {
  const { can } = useSession();
  return (
    <>
      <PageHeader
        title="Compliance"
        description={
          <>
            What <Term term="POPIA" /> asks you to be able to show: the lawful basis for each check, what suppliers were told, and how you answered their requests.
          </>
        }
        actions={
          can('audit:read') ? (
            <Button intent="secondary" asChild>
              <Link href="/app/compliance/audit">Audit log</Link>
            </Button>
          ) : null
        }
      />
      <Tabs
        label="Compliance records"
        tabs={[
          { value: 'consents', label: 'Consents', content: <Consents /> },
          { value: 'requests', label: 'Data-subject requests', content: <Requests /> },
          { value: 'notices', label: 'Privacy notices', content: <Notices /> },
          { value: 'processing', label: 'What we process', content: <Processing /> },
        ]}
      />
    </>
  );
}

function Consents() {
  const { can } = useSession();
  const [page, setPage] = useState(1);
  const [state, setState] = useState('all');
  const q = useApi<ConsentPage>('/api/compliance/consents', { page, page_size: 20, state: state === 'all' ? undefined : state });
  const cols: Column<Consent>[] = [
    {
      key: 'who',
      header: 'Who agreed',
      rowHeader: true,
      cell: (c) => (
        <div className="flex flex-col">
          <span className="font-semibold">{c.supplier_name ?? c.subject_display}</span>
          <span className="text-sm text-ink-2">
            {humanise(c.subject_role)}
            {c.on_behalf_of_subject ? ', recorded on their behalf' : ''}
          </span>
        </div>
      ),
    },
    {
      key: 'purposes',
      header: 'For',
      cell: (c) => (
        <ul className="flex flex-col gap-0.5">
          {c.purposes.map((p) => (
            <li key={p.purpose} className={p.withdrawn_at ? 'text-ink-2 line-through' : ''}>
              {PURPOSE_LABELS[p.purpose] ?? humanise(p.purpose)}
              <span className="text-sm text-ink-2"> (on {BASIS_LABELS[p.lawful_basis] ?? humanise(p.lawful_basis)})</span>
              {p.withdrawn_at ? <span className="sr-only"> withdrawn</span> : null}
            </li>
          ))}
        </ul>
      ),
    },
    { key: 'how', header: 'How', cell: (c) => `${humanise(c.capture_method)}, notice ${c.notice.code.replace('_', ' ')} v${c.notice.version}` },
    { key: 'when', header: 'When', cell: (c) => <When value={c.granted_at} /> },
    {
      key: 'actions',
      header: 'Actions',
      cell: (c) => (can('compliance:manage') && c.purposes.some((p) => !p.withdrawn_at) ? <Withdraw c={c} /> : null),
    },
  ];
  return (
    <Sheet flush>
      <FilterBar>
        <Field label="Show" className="w-56">
          {(p) => (
            <Select
              {...p}
              value={state}
              onValueChange={(v) => {
                setState(v);
                setPage(1);
              }}
              options={[
                { value: 'all', label: 'All consents' },
                { value: 'active', label: 'Still in force' },
                { value: 'withdrawn', label: 'Fully withdrawn' },
              ]}
            />
          )}
        </Field>
      </FilterBar>
      <div className="border-t border-rule">
        <Loaded q={q} label="Consents">
          {(d) => (
            <>
              <DataTable caption="Consent records" captionHidden columns={cols} rows={d.items} rowKey={(c) => c.id} empty="No consents recorded yet. They are captured with checks that need them." />
              <div className="border-t border-rule">
                <Pagination page={d.page} pageSize={d.page_size} total={d.total} noun={['consent', 'consents']} onPage={setPage} />
              </div>
            </>
          )}
        </Loaded>
      </div>
    </Sheet>
  );
}

function Withdraw({ c }: { c: Consent }) {
  const [open, setOpen] = useState(false);
  const active = c.purposes.filter((p) => !p.withdrawn_at);
  const [chosen, setChosen] = useState<string[]>(active.map((p) => p.purpose));
  const [channel, setChannel] = useState('email');
  const [error, setError] = useState<string>();
  const w = useChange((b: unknown) => api(`/api/compliance/consents/${c.id}/withdraw`, { method: 'POST', body: b }), {
    invalidate: ['/api/compliance/consents', '/api/monitoring', '/api/suppliers'],
    success: 'Withdrawal recorded',
  });
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Record a withdrawal of consent"
      description="Processing that rests on these purposes stops. If monitoring is withdrawn, monitoring of this supplier ends."
      trigger={
        <Button intent="quiet" size="sm">
          Record withdrawal
        </Button>
      }
      footer={
        <>
          <DialogClose asChild>
            <Button intent="secondary">Cancel</Button>
          </DialogClose>
          <Button
            intent="danger"
            loading={w.isPending}
            onClick={async () => {
              if (!chosen.length) return setError('Choose what the supplier withdrew.');
              try {
                await w.mutateAsync({ purposes: chosen, channel });
                setOpen(false);
              } catch (e) {
                setError(e instanceof ApiProblem ? e.message : 'The withdrawal could not be recorded.');
              }
            }}
          >
            Record withdrawal
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {error ? <Callout tone="refused" title={error} /> : null}
        <fieldset>
          <legend className="mb-1 font-semibold">What was withdrawn</legend>
          {active.map((p) => (
            <Checkbox
              key={p.purpose}
              label={PURPOSE_LABELS[p.purpose] ?? humanise(p.purpose)}
              checked={chosen.includes(p.purpose)}
              onCheckedChange={(on) => setChosen((s) => (on ? [...s, p.purpose] : s.filter((x) => x !== p.purpose)))}
            />
          ))}
        </fieldset>
        <Field label="How they told you">
          {(p) => (
            <Select
              {...p}
              value={channel}
              onValueChange={setChannel}
              options={[
                { value: 'email', label: 'By email' },
                { value: 'phone', label: 'By phone' },
                { value: 'letter', label: 'By letter' },
                { value: 'in_person', label: 'In person' },
                { value: 'portal', label: 'Another way' },
              ]}
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

const DSR_TYPES: Record<string, string> = {
  access: 'See their information',
  correction: 'Correct their information',
  deletion: 'Delete their information',
  objection: 'Object to processing',
  withdraw_consent: 'Withdraw consent',
  restrict: 'Restrict processing',
};
const DSR_STATUSES: Record<string, string> = {
  received: 'Received',
  verifying: 'Confirming who they are',
  in_progress: 'In progress',
  completed: 'Completed',
  refused: 'Refused',
  escalated_to_ir: 'With the Information Regulator',
};

function Requests() {
  const { can } = useSession();
  const [open, setOpen] = useState('true');
  const q = useApi<DsrPage>('/api/compliance/requests', { open: open === 'all' ? undefined : open, page_size: 50 });
  return (
    <Sheet
      title={<><Term term="DSR" />s</>}
      description="POPIA gives you 30 days to answer. Requests run oldest-first, most urgent at the top."
      actions={can('compliance:manage') ? <NewRequest /> : undefined}
      flush
    >
      <FilterBar>
        <Field label="Show" className="w-56">
          {(p) => (
            <Select
              {...p}
              value={open}
              onValueChange={setOpen}
              options={[
                { value: 'true', label: 'Open requests' },
                { value: 'false', label: 'Closed requests' },
                { value: 'all', label: 'All requests' },
              ]}
            />
          )}
        </Field>
      </FilterBar>
      <div className="border-t border-rule">
        <Loaded q={q} label="Requests">
          {(d) =>
            d.items.length ? (
              <ul className="flex flex-col divide-y divide-rule">
                {d.items.map((r) => (
                  <RequestRow key={r.id} r={r} manage={can('compliance:manage')} />
                ))}
              </ul>
            ) : (
              <p className="px-5 py-6 text-ink-2 sm:px-6">No requests here.</p>
            )
          }
        </Loaded>
      </div>
    </Sheet>
  );
}

function RequestRow({ r, manage }: { r: Dsr; manage: boolean }) {
  const clock =
    r.days_left === null ? (
      <Stamp tone="neutral">{DSR_STATUSES[r.status]}</Stamp>
    ) : r.days_left < 0 ? (
      <Stamp tone="refused">{-r.days_left} days overdue</Stamp>
    ) : r.days_left <= 7 ? (
      <Stamp tone="caution">{r.days_left} days left</Stamp>
    ) : (
      <Stamp tone="pending">{r.days_left} days left</Stamp>
    );
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-5 py-4 sm:px-6">
      <div className="min-w-0">
        <p className="font-semibold">
          {DSR_TYPES[r.request_type]}: {r.requester_display}
        </p>
        <p className="text-sm text-ink-2">
          {r.supplier_name ? `${r.supplier_name}. ` : ''}Received {formatDay(r.received_at)}, due {formatDay(r.due_at)}. {DSR_STATUSES[r.status]}
          {r.identity_verified ? ', identity confirmed' : ''}.
        </p>
        {r.outcome_notes ? <p className="mt-1 text-sm">{r.outcome_notes}</p> : null}
      </div>
      <div className="flex items-center gap-3">
        {clock}
        {manage && r.days_left !== null ? <UpdateRequest r={r} /> : null}
      </div>
    </li>
  );
}

function NewRequest() {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ request_type: 'access', requester_display: '', notes: '' });
  const [error, setError] = useState<string>();
  const create = useChange((b: unknown) => api('/api/compliance/requests', { method: 'POST', body: b }), { invalidate: ['/api/compliance/requests'], success: 'Request logged: the 30-day clock has started' });
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Log a data-subject request"
      trigger={
        <Button>
          <Plus aria-hidden="true" />
          Log a request
        </Button>
      }
      footer={
        <>
          <DialogClose asChild>
            <Button intent="secondary">Cancel</Button>
          </DialogClose>
          <Button
            loading={create.isPending}
            onClick={async () => {
              if (!v.requester_display.trim()) return setError('Say who made the request.');
              try {
                await create.mutateAsync({ request_type: v.request_type, requester_display: v.requester_display, ...(v.notes ? { notes: v.notes } : {}) });
                setOpen(false);
              } catch (e) {
                setError(e instanceof ApiProblem ? e.message : 'The request could not be logged.');
              }
            }}
          >
            Log request
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="They asked to">
          {(p) => <Select {...p} value={v.request_type} onValueChange={(x) => setV((s) => ({ ...s, request_type: x }))} options={Object.entries(DSR_TYPES).map(([value, label]) => ({ value, label }))} />}
        </Field>
        <Field label="Who asked" hint="A name or role, not an ID number. For example: director of Acme Trading." error={error}>
          {(p) => <Input {...p} value={v.requester_display} onChange={(e) => setV((s) => ({ ...s, requester_display: e.target.value }))} maxLength={120} />}
        </Field>
        <Field label="Notes" optional>
          {(p) => <Textarea {...p} value={v.notes} onChange={(e) => setV((s) => ({ ...s, notes: e.target.value }))} maxLength={2000} />}
        </Field>
      </div>
    </Dialog>
  );
}

function UpdateRequest({ r }: { r: Dsr }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(r.status);
  const [verified, setVerified] = useState(r.identity_verified);
  const [notes, setNotes] = useState(r.outcome_notes ?? '');
  const [error, setError] = useState<string>();
  const update = useChange((b: unknown) => api(`/api/compliance/requests/${r.id}`, { method: 'PATCH', body: b }), { invalidate: ['/api/compliance/requests'], success: 'Request updated' });
  const closing = status === 'completed' || status === 'refused';
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Update the request"
      trigger={
        <Button intent="secondary" size="sm">
          Update
        </Button>
      }
      footer={
        <>
          <DialogClose asChild>
            <Button intent="secondary">Cancel</Button>
          </DialogClose>
          <Button
            loading={update.isPending}
            onClick={async () => {
              if (closing && !notes.trim()) return setError('Record what was done before closing the request.');
              try {
                await update.mutateAsync({ status, identity_verified: verified, outcome_notes: notes || null });
                setOpen(false);
              } catch (e) {
                setError(e instanceof ApiProblem ? e.message : 'The request could not be updated.');
              }
            }}
          >
            {closing ? 'Close the request' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="Status">
          {(p) => <Select {...p} value={status} onValueChange={(x) => setStatus(x as Dsr['status'])} options={Object.entries(DSR_STATUSES).map(([value, label]) => ({ value, label }))} />}
        </Field>
        <Checkbox label="We confirmed who they are" checked={verified} onCheckedChange={setVerified} />
        <Field label="What was done" optional={!closing} error={error}>
          {(p) => <Textarea {...p} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />}
        </Field>
      </div>
    </Dialog>
  );
}

function Notices() {
  const q = useApi<Notice[]>('/api/compliance/notices');
  return (
    <Loaded q={q} label="Privacy notices">
      {(list) => (
        <div className="flex flex-col gap-6">
          {list.map((n) => (
            <Sheet key={n.id} title={`${humanise(n.code)}, version ${n.version}`} description={`Shown ${n.channel === 'web' ? 'in the portal' : n.channel === 'api' ? 'through the API' : `on ${n.channel}`}, from ${formatDay(n.effective_from)}${n.retired_at ? `, retired ${formatDay(n.retired_at)}` : ''}`}>
              <p>{n.body}</p>
            </Sheet>
          ))}
        </div>
      )}
    </Loaded>
  );
}

function Processing() {
  const q = useApi<Activity[]>('/api/compliance/processing');
  const cols: Column<Activity>[] = [
    { key: 'what', header: 'Processing', rowHeader: true, cell: (a) => <span className="font-semibold">{a.description}</span> },
    { key: 'basis', header: 'Lawful basis', cell: (a) => BASIS_LABELS[a.lawful_basis] ?? humanise(a.lawful_basis) },
    { key: 'data', header: 'Information', cell: (a) => a.data_categories.map(humanise).join(', ') },
    { key: 'special', header: 'Special information', cell: (a) => (a.special_pi ? 'Yes' : 'No') },
    { key: 'kept', header: 'Kept for', cell: (a) => (a.retention_days === null ? '' : a.retention_days >= 365 ? `${Math.round(a.retention_days / 365)} years` : `${a.retention_days} days`) },
  ];
  return (
    <Sheet title="Record of processing" description="What TshepoVet processes for you, why, and for how long." flush>
      <Loaded q={q} label="The record of processing">
        {(list) => <DataTable caption="Record of processing" captionHidden columns={cols} rows={list} rowKey={(a) => a.code} />}
      </Loaded>
    </Sheet>
  );
}

// --- Audit log --------------------------------------------------------------------------------
export function AuditPage() {
  const [filters, setFilters] = useState({ action: '', actor_type: 'all' });
  const [before, setBefore] = useState<number[]>([]);
  const q = useApi<AuditList>('/api/audit', {
    action: filters.action || undefined,
    actor_type: filters.actor_type === 'all' ? undefined : filters.actor_type,
    before_id: before[before.length - 1],
    limit: 50,
  });
  const [chain, setChain] = useState<Chain | null>(null);
  const verify = useChange(() => api<Chain>('/api/audit/verify', { method: 'POST' }), { invalidate: ['/api/audit'], onSuccess: setChain });
  type E = AuditList['items'][number];
  const cols: Column<E>[] = [
    { key: 'when', header: 'When', cell: (e) => <When value={e.occurred_at} showExact /> },
    { key: 'what', header: 'What happened', rowHeader: true, cell: (e) => <span className="font-semibold">{humanise(e.action.replace(/\./g, ': '))}</span> },
    { key: 'who', header: 'Who', cell: (e) => e.actor.name ?? humanise(e.actor.type) },
    { key: 'on', header: 'On', cell: (e) => <span className="font-mono text-sm">{e.entity_type}</span> },
    { key: 'from', header: 'From', cell: (e) => (e.ip ? <span className="font-mono text-sm">{e.ip}</span> : '') },
  ];
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Compliance', href: '/app/compliance' }, { label: 'Audit log' }]}
        title="Audit log"
        description="Every change anyone made, newest first. Each entry includes a fingerprint of the one before it, so an edited or deleted entry breaks the chain."
        actions={
          <Button loading={verify.isPending} onClick={() => verify.mutate(undefined)}>
            <ShieldCheck aria-hidden="true" />
            Check the chain
          </Button>
        }
      />
      {chain ? (
        chain.intact ? (
          <Callout tone="verified" title="The chain is intact" className="mb-6">
            <p>All {chain.entries_checked} entries match their fingerprints. Nothing was edited or removed.</p>
          </Callout>
        ) : (
          <Callout tone="refused" title="The chain is broken" className="mb-6">
            <p>Entry {chain.broken_at_sequence} does not match its fingerprint: it, or the one before it, was changed outside TshepoVet. Tell TshepoVet support.</p>
          </Callout>
        )
      ) : null}
      <Sheet flush>
        <FilterBar>
          <Field label="Action starts with" className="w-64">
            {(p) => (
              <Input
                {...p}
                placeholder="supplier."
                value={filters.action}
                onChange={(e) => {
                  setFilters((f) => ({ ...f, action: e.target.value }));
                  setBefore([]);
                }}
              />
            )}
          </Field>
          <Field label="Done by" className="w-52">
            {(p) => (
              <Select
                {...p}
                value={filters.actor_type}
                onValueChange={(v) => {
                  setFilters((f) => ({ ...f, actor_type: v }));
                  setBefore([]);
                }}
                options={[
                  { value: 'all', label: 'Anyone' },
                  { value: 'user', label: 'People' },
                  { value: 'api_key', label: 'API keys' },
                  { value: 'system', label: 'TshepoVet' },
                  { value: 'tshepovet_staff', label: 'TshepoVet support' },
                ]}
              />
            )}
          </Field>
        </FilterBar>
        <div className="border-t border-rule">
          <Loaded q={q} label="The audit log">
            {(a) => (
              <>
                <DataTable caption="Audit log" captionHidden columns={cols} rows={a.items} rowKey={(e) => String(e.id)} empty="No entries match." />
                <nav aria-label="Pages" className="flex flex-wrap gap-3 border-t border-rule px-4 py-3">
                  <Button intent="secondary" size="sm" disabled={!before.length} onClick={() => setBefore((b) => b.slice(0, -1))}>
                    Newer entries
                  </Button>
                  <Button intent="secondary" size="sm" disabled={!a.next_before_id} onClick={() => setBefore((b) => [...b, a.next_before_id!])}>
                    Older entries
                  </Button>
                </nav>
              </>
            )}
          </Loaded>
        </div>
      </Sheet>
    </>
  );
}

