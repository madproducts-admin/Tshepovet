'use client';

import { ChevronDown, Lock, LockOpen, Pencil, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { z } from 'zod';
import type { AuditListSchema, SupplierDetail, SupplierListItem } from '@tshepovet/contracts';
import { Button } from '@/components/ui/button';
import { type Column, DataTable, Tabs, Term, When } from '@/components/ui/data';
import { Callout, EmptyState, OutcomeStamp, Stamp, SupplierStatusStamp } from '@/components/ui/feedback';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form';
import { PageHeader, RecordList, Sheet, Timeline } from '@/components/ui/layout';
import { Dialog, DialogClose, Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/overlay';
import { api, ApiProblem } from '@/lib/api';
import { daysUntil, formatDay } from '@/lib/format';
import { rules } from '@/lib/forms';
import { useApi, useChange, useSession } from '@/lib/queries';
import { humanise, Loaded, SUBJECT_LABELS } from './common';
import { INDUSTRY_OPTIONS, RISK_OPTIONS } from './suppliers';

type AuditList = z.infer<typeof AuditListSchema>;

const STATUS_ACTIONS: Array<{ status: string; label: string; done: string; needsReason: boolean; consequence: string }> = [
  { status: 'approved', label: 'Approve', done: 'Supplier approved', needsReason: false, consequence: 'The supplier can be paid. Monitoring keeps checking it.' },
  { status: 'pending_review', label: 'Send for review', done: 'Sent for review', needsReason: false, consequence: 'Marks the supplier as waiting for a decision.' },
  { status: 'rejected', label: 'Reject', done: 'Supplier rejected', needsReason: true, consequence: 'The supplier should not be used. The reason is kept in the audit log.' },
  { status: 'suspended', label: 'Suspend', done: 'Supplier suspended', needsReason: true, consequence: 'Stops new work with the supplier until you approve it again.' },
  { status: 'offboarded', label: 'Offboard', done: 'Supplier offboarded', needsReason: true, consequence: 'Ends the relationship. Records are kept for five years, then purged.' },
];

export function SupplierRecord({ id }: { id: string }) {
  const { can } = useSession();
  const q = useApi<SupplierDetail>(`/api/suppliers/${id}`);
  return (
    <Loaded q={q} label="The supplier">
      {(s) => (
        <>
          <PageHeader
            crumbs={[{ label: 'Suppliers', href: '/app/suppliers' }, { label: s.vendor.legal_name }]}
            title={s.vendor.legal_name}
            meta={
              <>
                <SupplierStatusStamp status={s.relationship.status} />
                {s.checks[0] ? <OutcomeStamp outcome={s.checks[0].outcome} status={s.checks[0].status} /> : null}
                <span className="font-mono text-ink-2">{s.vendor.registration_number}</span>
              </>
            }
            actions={
              <>
                {can('checks:run') && s.vendor.registration_number ? (
                  <Button asChild>
                    <Link href={`/app/checks/new?registration=${encodeURIComponent(s.vendor.registration_number)}`}>Run a check</Link>
                  </Button>
                ) : null}
                {can('suppliers:write') ? <StatusActions id={id} current={s.relationship.status} /> : null}
                {can('suppliers:write') ? <EditSupplier id={id} s={s} /> : null}
              </>
            }
          />
          {s.relationship.payment_lock_status === 'locked' ? (
            <Callout tone="refused" title="Payments to this supplier are locked" className="mb-6">
              <p>{s.relationship.payment_lock_reason ?? 'A document or check lapsed.'} Your accounting system was told through your webhook.</p>
            </Callout>
          ) : null}
          <Tabs
            label="Supplier record"
            tabs={[
              { value: 'facts', label: 'Facts', content: <Facts s={s} /> },
              { value: 'people', label: 'People', content: <People s={s} /> },
              { value: 'compliance', label: 'B-BBEE and bank', content: <Compliance s={s} /> },
              { value: 'documents', label: 'Documents', content: <Documents s={s} /> },
              { value: 'monitoring', label: 'Monitoring', content: <Monitoring id={id} s={s} /> },
              { value: 'checks', label: 'Checks', content: <ChecksTab s={s} /> },
              ...(can('audit:read') ? [{ value: 'audit', label: 'Audit trail', content: <AuditTrail id={id} /> }] : []),
            ]}
          />
        </>
      )}
    </Loaded>
  );
}

function Facts({ s }: { s: SupplierDetail }) {
  const v = s.vendor;
  const asOf = v.passport_last_verified_at ? `Verified ${formatDay(v.passport_last_verified_at)}` : 'Not verified yet';
  return (
    <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
      <Sheet title="The company" description={asOf}>
        <RecordList
          items={[
            { label: 'Registered name', value: v.legal_name },
            { label: 'Trading name', value: v.trading_name },
            { label: 'Registration number', value: v.registration_number ? <span className="font-mono">{v.registration_number}</span> : null },
            { label: 'Type of entity', value: humanise(v.entity_kind) },
            { label: <>Status on the <Term term="CIPC" /> register</>, value: v.cipc_status ? humanise(v.cipc_status) : null, note: v.cipc_status_raw ?? undefined },
            { label: 'Incorporated', value: v.incorporation_date ? formatDay(v.incorporation_date) : null },
            { label: 'Annual return due', value: v.annual_return_due_date ? formatDay(v.annual_return_due_date) : null },
            { label: <><Term term="VAT" /> number</>, value: v.vat_number ? <span className="font-mono">{v.vat_number}</span> : null },
            { label: <><Term term="CSD" /> number</>, value: v.csd_supplier_number ? <span className="font-mono">{v.csd_supplier_number}</span> : null },
          ]}
        />
      </Sheet>
      <Sheet title="Your relationship">
        <RecordList
          columns={1}
          items={[
            { label: 'Status', value: <SupplierStatusStamp status={s.relationship.status} /> },
            { label: 'Risk rating', value: s.relationship.risk_rating ? humanise(s.relationship.risk_rating) : null },
            { label: 'Your reference', value: s.relationship.external_ref },
            { label: 'Industry', value: s.relationship.industry_profile ? humanise(s.relationship.industry_profile) : null },
            { label: 'Approved', value: s.relationship.approved_at ? `${formatDay(s.relationship.approved_at)} by ${s.relationship.approved_by ?? 'a former member'}` : null },
            { label: 'Added', value: formatDay(s.relationship.created_at), note: `Through ${humanise(s.relationship.onboarding_channel)}` },
          ]}
        />
      </Sheet>
    </div>
  );
}

function People({ s }: { s: SupplierDetail }) {
  type D = SupplierDetail['directors'][number];
  type O = SupplierDetail['beneficial_owners'][number];
  const dcols: Column<D>[] = [
    { key: 'name', header: 'Name', rowHeader: true, cell: (d) => d.full_name },
    { key: 'role', header: 'Role', cell: (d) => humanise(d.role) },
    { key: 'status', header: 'Status', cell: (d) => (d.status === 'active' ? <Stamp tone="verified">Active</Stamp> : <Stamp tone="neutral">{humanise(d.status)}</Stamp>) },
    { key: 'appointed', header: 'Appointed', cell: (d) => (d.appointed_on ? formatDay(d.appointed_on, true) : '') },
    { key: 'resigned', header: 'Left', cell: (d) => (d.resigned_on ? formatDay(d.resigned_on, true) : '') },
  ];
  const ocols: Column<O>[] = [
    { key: 'name', header: 'Name', rowHeader: true, cell: (o) => o.full_name },
    { key: 'pct', header: 'Ownership', align: 'end', cell: (o) => (o.ownership_pct === null ? '' : `${o.ownership_pct}%`) },
    { key: 'control', header: 'How', cell: (o) => (o.control_type ? humanise(o.control_type) : '') },
    { key: 'source', header: 'Source', cell: (o) => humanise(o.source) },
  ];
  return (
    <div className="flex flex-col gap-6">
      <Sheet title="Directors and members" description={s.directors[0] ? `From the CIPC register, as of ${formatDay(s.directors[0].as_of)}` : undefined} flush>
        <DataTable caption="Directors and members" captionHidden columns={dcols} rows={s.directors} rowKey={(d) => `${d.full_name}-${d.appointed_on}`} empty="Run a company check with directors to see who runs this company." />
      </Sheet>
      <Sheet title="Beneficial owners" description="People who own or control the company, as declared." flush>
        <DataTable caption="Beneficial owners" captionHidden columns={ocols} rows={s.beneficial_owners} rowKey={(o) => `${o.full_name}-${o.declared_at}`} empty="None declared yet. The supplier declares them during onboarding." />
      </Sheet>
    </div>
  );
}

function Compliance({ s }: { s: SupplierDetail }) {
  const b = s.bbbee;
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Sheet title={<><Term term="B-BBEE" /> status</>}>
        {b ? (
          <RecordList
            columns={1}
            items={[
              { label: 'Level', value: b.level === null ? 'Non-compliant' : `Level ${b.level}`, note: b.procurement_recognition_pct !== null ? `${b.procurement_recognition_pct}% of spend recognised` : undefined },
              { label: 'Evidence', value: humanise(b.evidence_type), note: `Issued ${formatDay(b.issued_on)}` },
              { label: 'Valid until', value: formatDay(b.valid_until), note: daysUntil(b.valid_until) < 0 ? 'Expired' : `${daysUntil(b.valid_until)} days left` },
              { label: 'Review', value: humanise(b.status) },
              {
                label: 'Ownership',
                value: b.ownership ? `${b.ownership.black_ownership_pct ?? 0}% black-owned, ${b.ownership.black_female_ownership_pct ?? 0}% black women-owned` : null,
                note: b.ownership ? undefined : 'Special personal information: only people your administrator allows can see it.',
              },
            ]}
          />
        ) : (
          <EmptyState title="No B-BBEE evidence yet">
            <p>The supplier uploads an affidavit or certificate during onboarding.</p>
          </EmptyState>
        )}
      </Sheet>
      <Sheet title="Bank accounts" description="Only the last four digits are ever shown.">
        {s.bank_accounts.length ? (
          <ul className="flex flex-col divide-y divide-rule">
            {s.bank_accounts.map((a, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-semibold">{a.bank_name}</p>
                  <p className="font-mono text-ink-2">•••• {a.account_last4}</p>
                </div>
                {a.avs_status === 'match' ? <Stamp tone="verified">Account verified</Stamp> : a.avs_status ? <Stamp tone="caution">{humanise(a.avs_status)}</Stamp> : <Stamp tone="neutral">Not verified</Stamp>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-2">No bank account recorded yet.</p>
        )}
      </Sheet>
    </div>
  );
}

function Documents({ s }: { s: SupplierDetail }) {
  type Doc = SupplierDetail['documents'][number];
  type Cred = SupplierDetail['credentials'][number];
  const cols: Column<Doc>[] = [
    { key: 'name', header: 'Document', rowHeader: true, cell: (d) => d.document_name },
    { key: 'review', header: 'Review', cell: (d) => humanise(d.review_status) },
    { key: 'expires', header: 'Expires', cell: (d) => (d.expires_on ? formatDay(d.expires_on, true) : 'Does not expire') },
    { key: 'source', header: 'From', cell: (d) => humanise(d.source_channel) },
    { key: 'image', header: 'Image', cell: (d) => (d.image_available ? 'Kept' : 'Deleted after review') },
  ];
  const ccols: Column<Cred>[] = [
    { key: 'type', header: 'Licence or permit', rowHeader: true, cell: (c) => humanise(c.credential_type) },
    { key: 'holder', header: 'Holder', cell: (c) => c.holder_display ?? '' },
    { key: 'status', header: 'Status', cell: (c) => (c.status === 'valid' ? <Stamp tone="verified">Valid</Stamp> : <Stamp tone="caution">{humanise(c.status)}</Stamp>) },
    { key: 'until', header: 'Valid until', cell: (c) => (c.valid_until ? formatDay(c.valid_until, true) : '') },
  ];
  return (
    <div className="flex flex-col gap-6">
      <Sheet title="Documents" flush>
        <DataTable caption="Documents" captionHidden columns={cols} rows={s.documents} rowKey={(d) => d.id} empty="No documents yet. Suppliers upload them during onboarding." />
      </Sheet>
      <Sheet title="Licences and permits" flush>
        <DataTable caption="Licences and permits" captionHidden columns={ccols} rows={s.credentials} rowKey={(c) => c.id} empty="None recorded. Driver checks add licences and permits here." />
      </Sheet>
    </div>
  );
}

function Monitoring({ id, s }: { id: string; s: SupplierDetail }) {
  const { can } = useSession();
  const m = s.monitoring;
  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
      <Sheet
        title="Continuous monitoring"
        description={m.enrolled ? `Since ${formatDay(m.since!)}` : 'TshepoVet re-checks a monitored supplier before things expire, and warns you.'}
        actions={can('monitoring:manage') ? <MonitoringToggle id={id} enrolled={m.enrolled} erpLock={m.erp_lock_enabled} /> : undefined}
      >
        {m.enrolled ? (
          <RecordList
            columns={1}
            items={[
              { label: 'Accounting lock', value: m.erp_lock_enabled ? 'On: payments lock automatically when something lapses' : 'Off: you are warned, payments are not locked' },
              { label: 'Payments', value: s.relationship.payment_lock_status === 'locked' ? 'Locked' : s.relationship.payment_lock_status === 'override' ? 'Unlocked by override' : 'Not locked' },
            ]}
          />
        ) : (
          <p className="text-ink-2">Not monitored. You can still run checks whenever you like.</p>
        )}
        {can('monitoring:manage') ? <PaymentLock id={id} status={s.relationship.payment_lock_status} /> : null}
      </Sheet>
      <Sheet title="What expires when">
        {m.schedules.length ? (
          <ul className="flex flex-col divide-y divide-rule">
            {m.schedules.map((x) => {
              const days = daysUntil(x.expires_on);
              return (
                <li key={x.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="font-semibold">{SUBJECT_LABELS[x.subject_type] ?? humanise(x.subject_type)}</p>
                    <p className="text-sm text-ink-2">{formatDay(x.expires_on)}</p>
                  </div>
                  {days < 0 ? <Stamp tone="refused">Expired</Stamp> : days <= 30 ? <Stamp tone="caution">{days} days left</Stamp> : <Stamp tone="verified">{days} days left</Stamp>}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-ink-2">Nothing with an expiry date yet. Tax compliance PINs, B-BBEE evidence and licences appear here.</p>
        )}
      </Sheet>
    </div>
  );
}

function MonitoringToggle({ id, enrolled, erpLock }: { id: string; enrolled: boolean; erpLock: boolean }) {
  const [open, setOpen] = useState(false);
  const [lock, setLock] = useState(erpLock);
  const [agreed, setAgreed] = useState(false);
  const [evidence, setEvidence] = useState('');
  const [needConsent, setNeedConsent] = useState(false);
  const [error, setError] = useState<string>();
  const inv = [`/api/suppliers/${id}`, '/api/monitoring', '/api/suppliers', '/api/overview'];
  const enrol = useChange((b: unknown) => api(`/api/monitoring/${id}`, { method: 'POST', body: b }), { invalidate: inv, success: 'Monitoring started' });
  const stop = useChange(() => api(`/api/monitoring/${id}`, { method: 'DELETE' }), { invalidate: inv, success: 'Monitoring stopped' });
  if (enrolled) {
    return (
      <Button intent="secondary" loading={stop.isPending} onClick={() => stop.mutate(undefined)}>
        Stop monitoring
      </Button>
    );
  }
  const submit = async () => {
    setError(undefined);
    if (needConsent && (!agreed || !evidence.trim())) {
      setError(!agreed ? 'Confirm that the supplier agreed to monitoring.' : 'Say where the evidence of consent is kept.');
      return;
    }
    try {
      await enrol.mutateAsync({ erp_lock_enabled: lock, ...(needConsent ? { consent: { confirmed: true, evidence_reference: evidence } } : {}) });
      setOpen(false);
    } catch (e) {
      if (e instanceof ApiProblem && e.code === 'consent_required') {
        setNeedConsent(true);
        setError('This supplier has not agreed to monitoring yet. Record their consent below.');
      } else setError(e instanceof ApiProblem ? e.message : 'Monitoring could not be started.');
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Start monitoring"
      description="TshepoVet re-checks this supplier before its documents and tax compliance PIN expire, and tells you when something lapses. R15,00 a month per supplier."
      trigger={<Button>Start monitoring</Button>}
      footer={
        <>
          <DialogClose asChild>
            <Button intent="secondary">Cancel</Button>
          </DialogClose>
          <Button loading={enrol.isPending} onClick={submit}>
            Start monitoring
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Callout tone={needConsent ? 'caution' : 'refused'} title={error} /> : null}
        <Checkbox
          label="Lock payments automatically when something lapses"
          hint="TshepoVet tells your accounting system through your webhook endpoint."
          checked={lock}
          onCheckedChange={setLock}
        />
        {needConsent ? (
          <>
            <Checkbox label="The supplier agreed to continuous monitoring" checked={agreed} onCheckedChange={setAgreed} />
            <Field label="Where the evidence is kept" hint="For example: signed onboarding form SOF-2026-014.">
              {(p) => <Input {...p} value={evidence} onChange={(e) => setEvidence(e.target.value)} maxLength={200} />}
            </Field>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}

function PaymentLock({ id, status }: { id: string; status: string }) {
  const [target, setTarget] = useState<'locked' | 'unlocked' | 'override' | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const change = useChange((b: unknown) => api<SupplierListItem>(`/api/monitoring/${id}/payment-lock`, { method: 'POST', body: b }), {
    invalidate: [`/api/suppliers/${id}`, '/api/monitoring', '/api/suppliers'],
    success: (r) => (r.payment_lock_status === 'locked' ? 'Payments locked' : 'Payments unlocked'),
  });
  const options = status === 'locked' ? (['unlocked', 'override'] as const) : (['locked'] as const);
  const labels = { locked: 'Lock payments', unlocked: 'Unlock payments', override: 'Override the lock' };
  return (
    <div className="mt-5 flex flex-wrap gap-2 border-t border-rule pt-4">
      {options.map((o) => (
        <Button key={o} intent={o === 'locked' ? 'secondary' : 'secondary'} onClick={() => setTarget(o)}>
          {o === 'locked' ? <Lock aria-hidden="true" /> : <LockOpen aria-hidden="true" />}
          {labels[o]}
        </Button>
      ))}
      <Dialog
        open={target !== null}
        onOpenChange={(v) => !v && setTarget(null)}
        title={target ? labels[target] : ''}
        description={target === 'locked' ? 'Your accounting system is told at once, through your webhook endpoint.' : 'The reason is kept in the audit log.'}
        footer={
          <>
            <DialogClose asChild>
              <Button intent="secondary">Cancel</Button>
            </DialogClose>
            <Button
              loading={change.isPending}
              onClick={async () => {
                const err = rules.required(reason, 'Give a reason.');
                setError(err);
                if (err || !target) return;
                try {
                  await change.mutateAsync({ status: target, reason });
                  setTarget(null);
                  setReason('');
                } catch (e) {
                  setError(e instanceof ApiProblem ? e.message : 'That did not work. Try again.');
                }
              }}
            >
              {target ? labels[target] : ''}
            </Button>
          </>
        }
      >
        <Field label="Reason" error={error}>
          {(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}
        </Field>
      </Dialog>
    </div>
  );
}

function ChecksTab({ s }: { s: SupplierDetail }) {
  if (!s.checks.length) return <EmptyState title="No checks yet">Run a company check to verify registration, directors, VAT and tax compliance.</EmptyState>;
  return (
    <Sheet flush>
      <ul className="flex flex-col divide-y divide-rule">
        {s.checks.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 sm:px-6">
            <div>
              <Link href={`/app/checks/${c.id}`} className="font-semibold">
                {c.type === 'company' ? 'Company check' : 'Driver check'}
              </Link>
              <p className="text-sm text-ink-2">
                <When value={c.requested_at} />
                {c.risk_flags.length ? `, ${c.risk_flags.length} warning${c.risk_flags.length === 1 ? '' : 's'}` : ''}
              </p>
            </div>
            <OutcomeStamp outcome={c.outcome} status={c.status} />
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

function AuditTrail({ id }: { id: string }) {
  const [before, setBefore] = useState<number | undefined>();
  const q = useApi<AuditList>(`/api/suppliers/${id}/audit`, { before_id: before, limit: 25 });
  return (
    <Loaded q={q} label="The audit trail">
      {(a) => (
        <Sheet title="Audit trail" description="Every change to this supplier and its checks, newest first. The log is hash-chained: entries cannot be edited.">
          <Timeline
            items={a.items.map((e) => ({
              id: e.id,
              title: `${humanise(e.action.replace('.', ': '))}`,
              when: (
                <>
                  {e.actor.name ?? humanise(e.actor.type)}, <When value={e.occurred_at} showExact />
                </>
              ),
              detail: typeof e.details.reason === 'string' ? `Reason: ${e.details.reason}` : undefined,
            }))}
          />
          {a.next_before_id ? (
            <Button intent="secondary" className="mt-5" onClick={() => setBefore(a.next_before_id!)}>
              Show older entries
            </Button>
          ) : null}
        </Sheet>
      )}
    </Loaded>
  );
}

function StatusActions({ id, current }: { id: string; current: string }) {
  const [action, setAction] = useState<(typeof STATUS_ACTIONS)[number] | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const change = useChange((b: unknown) => api(`/api/suppliers/${id}/status`, { method: 'POST', body: b }), {
    invalidate: [`/api/suppliers/${id}`, '/api/suppliers', '/api/overview'],
    success: () => action?.done ?? 'Status changed',
  });
  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button intent="secondary">
            Change status
            <ChevronDown aria-hidden="true" />
          </Button>
        </MenuTrigger>
        <MenuContent>
          {STATUS_ACTIONS.filter((a) => a.status !== current).map((a) => (
            <MenuItem key={a.status} destructive={['rejected', 'suspended', 'offboarded'].includes(a.status)} onSelect={() => setAction(a)}>
              {a.status === 'suspended' ? <ShieldAlert aria-hidden="true" /> : null}
              {a.label}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      <Dialog
        open={action !== null}
        onOpenChange={(v) => !v && setAction(null)}
        title={`${action?.label} this supplier?`}
        description={action?.consequence}
        footer={
          <>
            <DialogClose asChild>
              <Button intent="secondary">Cancel</Button>
            </DialogClose>
            <Button
              intent={action?.needsReason ? 'danger' : 'primary'}
              loading={change.isPending}
              onClick={async () => {
                const err = action?.needsReason ? rules.required(reason, 'Give a reason: it is kept in the audit log.') : undefined;
                setError(err);
                if (err || !action) return;
                try {
                  await change.mutateAsync({ status: action.status, ...(reason ? { reason } : {}) });
                  setAction(null);
                  setReason('');
                } catch (e) {
                  setError(e instanceof ApiProblem ? e.message : 'That did not work. Try again.');
                }
              }}
            >
              {action?.label}
            </Button>
          </>
        }
      >
        <Field label="Reason" optional={!action?.needsReason} error={error}>
          {(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}
        </Field>
      </Dialog>
    </>
  );
}

function EditSupplier({ id, s }: { id: string; s: SupplierDetail }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<{ external_ref: string; risk_rating: string; industry_profile: string }>({
    external_ref: s.relationship.external_ref ?? '',
    risk_rating: s.relationship.risk_rating ?? 'none',
    industry_profile: s.relationship.industry_profile ?? 'general',
  });
  const [error, setError] = useState<string>();
  const save = useChange((b: unknown) => api(`/api/suppliers/${id}`, { method: 'PATCH', body: b }), { invalidate: [`/api/suppliers/${id}`, '/api/suppliers'], success: 'Changes saved' });
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Edit supplier details"
      trigger={
        <Button intent="secondary">
          <Pencil aria-hidden="true" />
          Edit
        </Button>
      }
      footer={
        <>
          <DialogClose asChild>
            <Button intent="secondary">Cancel</Button>
          </DialogClose>
          <Button
            loading={save.isPending}
            onClick={async () => {
              try {
                await save.mutateAsync({
                  external_ref: v.external_ref.trim() || null,
                  risk_rating: v.risk_rating === 'none' ? null : v.risk_rating,
                  industry_profile: v.industry_profile,
                });
                setOpen(false);
              } catch (e) {
                setError(e instanceof ApiProblem ? e.message : 'The changes could not be saved.');
              }
            }}
          >
            Save changes
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {error ? <Callout tone="refused" title={error} /> : null}
        <Field label="Your reference" optional>
          {(p) => <Input {...p} value={v.external_ref} onChange={(e) => setV((x) => ({ ...x, external_ref: e.target.value }))} maxLength={100} />}
        </Field>
        <Field label="Risk rating">
          {(p) => <Select {...p} value={v.risk_rating} onValueChange={(x) => setV((y) => ({ ...y, risk_rating: x }))} options={[{ value: 'none', label: 'Not rated' }, ...RISK_OPTIONS]} />}
        </Field>
        <Field label="Industry">
          {(p) => <Select {...p} value={v.industry_profile} onValueChange={(x) => setV((y) => ({ ...y, industry_profile: x }))} options={INDUSTRY_OPTIONS} />}
        </Field>
      </div>
    </Dialog>
  );
}
