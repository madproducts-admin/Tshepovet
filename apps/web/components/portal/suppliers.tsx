'use client';

import { Bookmark, Download, Plus, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import type { SavedViewSchema, SupplierListItem, SupplierPageSchema } from '@tshepovet/contracts';
import { Button } from '@/components/ui/button';
import { type Column, DataTable, Pagination, When } from '@/components/ui/data';
import { Callout, OutcomeStamp, Stamp, SupplierStatusStamp } from '@/components/ui/feedback';
import { ErrorSummary, Field, Input, SearchField, Select } from '@/components/ui/form';
import { PageHeader, Sheet } from '@/components/ui/layout';
import { Dialog, DialogClose, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/overlay';
import { api, ApiProblem, withQuery } from '@/lib/api';
import { formatDay } from '@/lib/format';
import { check, fromProblem, rules } from '@/lib/forms';
import { useApi, useChange, useSession } from '@/lib/queries';
import { FilterBar, Loaded, useListParams } from './common';

type SupplierPage = z.infer<typeof SupplierPageSchema>;
type SavedView = z.infer<typeof SavedViewSchema>;

export const STATUS_OPTIONS = [
  { value: 'all', label: 'Any status' },
  { value: 'invited', label: 'Invited' },
  { value: 'onboarding', label: 'Onboarding' },
  { value: 'pending_review', label: 'Awaiting review' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'offboarded', label: 'Offboarded' },
];
export const RISK_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];
export const INDUSTRY_OPTIONS = [
  { value: 'general', label: 'General' },
  { value: 'construction', label: 'Construction' },
  { value: 'logistics', label: 'Logistics' },
];

const DEFAULTS = { q: '', status: 'all', risk: 'all', monitored: 'all', sort: 'created_at', order: 'desc', page: '1' };

function useDebounced(value: string, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function SuppliersPage() {
  const { can } = useSession();
  const { values, set } = useListParams(DEFAULTS);
  const [search, setSearch] = useState(values.q);
  const debounced = useDebounced(search);
  useEffect(() => {
    if (debounced !== values.q) set({ q: debounced });
  }, [debounced]); // eslint-disable-line react-hooks/exhaustive-deps

  const query = {
    q: values.q || undefined,
    status: values.status === 'all' ? undefined : values.status,
    risk: values.risk === 'all' ? undefined : values.risk,
    monitored: values.monitored === 'all' ? undefined : values.monitored,
    sort: values.sort,
    order: values.order,
    page: Number(values.page),
    page_size: 25,
  };
  const q = useApi<SupplierPage>('/api/suppliers', query);

  const columns: Column<SupplierListItem>[] = [
    {
      key: 'legal_name',
      header: 'Supplier',
      sortable: true,
      rowHeader: true,
      cell: (s) => (
        <div className="flex min-w-56 flex-col">
          <Link href={`/app/suppliers/${s.id}`} className="font-semibold">
            {s.legal_name}
          </Link>
          <span className="font-mono text-sm text-ink-2">{s.registration_number ?? 'No registration number'}</span>
          {s.external_ref ? <span className="text-sm text-ink-2">Your reference: {s.external_ref}</span> : null}
        </div>
      ),
    },
    { key: 'status', header: 'Status', sortable: true, cell: (s) => <SupplierStatusStamp status={s.status} /> },
    {
      key: 'last_verified_at',
      header: 'Last check',
      sortable: true,
      cell: (s) =>
        s.last_verified_at ? (
          <div className="flex flex-col items-start gap-1">
            <OutcomeStamp outcome={s.last_outcome} />
            <span className="text-sm text-ink-2">
              <When value={s.last_verified_at} />
            </span>
          </div>
        ) : (
          <span className="text-ink-2">Not checked yet</span>
        ),
    },
    { key: 'risk_rating', header: 'Risk', sortable: true, cell: (s) => (s.risk_rating ? <span className="capitalize">{s.risk_rating}</span> : <span className="text-ink-2">Not rated</span>) },
    {
      key: 'monitored',
      header: 'Monitoring',
      cell: (s) => (
        <div className="flex flex-col items-start gap-1">
          {s.monitored ? <span>Monitored</span> : <span className="text-ink-2">Not monitored</span>}
          {s.payment_lock_status === 'locked' ? (
            <Stamp tone="refused" icon={ShieldAlert}>
              Payments locked
            </Stamp>
          ) : null}
        </div>
      ),
    },
    {
      key: 'next_expiry_on',
      header: 'Next expiry',
      sortable: true,
      cell: (s) => (s.next_expiry_on ? formatDay(s.next_expiry_on, true) : <span className="text-ink-2">None recorded</span>),
    },
  ];

  const exportHref = withQuery('/api/suppliers/export.csv', { ...query, page: undefined, page_size: undefined });

  return (
    <>
      <PageHeader
        title="Suppliers"
        description="Everyone you pay or plan to pay, with their latest checks and what expires next."
        actions={
          <>
            {can('suppliers:write') ? <AddSupplier /> : null}
            {can('checks:run') ? (
              <Button intent="secondary" asChild>
                <Link href="/app/checks/new">Run a check</Link>
              </Button>
            ) : null}
          </>
        }
      />
      <Sheet flush>
        <FilterBar>
          <SearchField label="Search" placeholder="Name, registration number or your reference" value={search} onChange={(e) => setSearch(e.target.value)} className="min-w-64 flex-1" />
          <Field label="Status" className="w-48">
            {(p) => <Select {...p} value={values.status} onValueChange={(v) => set({ status: v })} options={STATUS_OPTIONS} />}
          </Field>
          <Field label="Risk" className="w-40">
            {(p) => <Select {...p} value={values.risk} onValueChange={(v) => set({ risk: v })} options={[{ value: 'all', label: 'Any risk' }, ...RISK_OPTIONS]} />}
          </Field>
          <Field label="Monitoring" className="w-44">
            {(p) => (
              <Select
                {...p}
                value={values.monitored}
                onValueChange={(v) => set({ monitored: v })}
                options={[
                  { value: 'all', label: 'All suppliers' },
                  { value: 'true', label: 'Monitored' },
                  { value: 'false', label: 'Not monitored' },
                ]}
              />
            )}
          </Field>
          <div className="flex gap-2">
            <SavedViews current={values} onApply={(qv) => set({ ...DEFAULTS, ...qv })} />
            <Button intent="secondary" asChild>
              <a href={exportHref} download>
                <Download aria-hidden="true" />
                Export CSV
              </a>
            </Button>
          </div>
        </FilterBar>
        <div className="border-t border-rule">
          <Loaded q={q} label="Suppliers">
            {(page) => (
              <>
                <DataTable
                  caption="Suppliers"
                  captionHidden
                  columns={columns}
                  rows={page.items}
                  rowKey={(s) => s.id}
                  sort={{ sort: values.sort, order: values.order as 'asc' | 'desc' }}
                  onSort={(s) => set({ sort: s.sort, order: s.order })}
                  empty={values.q || values.status !== 'all' ? 'No suppliers match these filters.' : 'No suppliers yet. Add one by registration number, or run a check: the supplier is added for you.'}
                />
                <div className="border-t border-rule">
                  <Pagination page={page.page} pageSize={page.page_size} total={page.total} noun={['supplier', 'suppliers']} onPage={(p) => set({ page: p }, false)} />
                </div>
              </>
            )}
          </Loaded>
        </div>
      </Sheet>
    </>
  );
}

function SavedViews({ current, onApply }: { current: Record<string, string>; onApply: (q: Record<string, string>) => void }) {
  const views = useApi<SavedView[]>('/api/saved-views', { scope: 'suppliers' });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const save = useChange((b: unknown) => api('/api/saved-views', { method: 'POST', body: b }), { invalidate: ['/api/saved-views'], success: 'View saved' });
  const remove = useChange((id: string) => api(`/api/saved-views/${id}`, { method: 'DELETE' }), { invalidate: ['/api/saved-views'], success: 'View deleted' });
  const filters = Object.fromEntries(Object.entries(current).filter(([k, v]) => k !== 'page' && v && v !== 'all' && !(k === 'sort' && v === 'created_at') && !(k === 'order' && v === 'desc')));
  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button intent="secondary">
            <Bookmark aria-hidden="true" />
            Views
          </Button>
        </MenuTrigger>
        <MenuContent>
          <MenuLabel>Your saved views</MenuLabel>
          {(views.data ?? []).length === 0 ? <MenuLabel>None yet</MenuLabel> : null}
          {(views.data ?? []).map((v) => (
            <MenuItem key={v.id} onSelect={() => onApply(Object.fromEntries(Object.entries(v.query).map(([k, x]) => [k, String(x)])))}>
              {v.name}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onSelect={() => setOpen(true)}>
            <Plus aria-hidden="true" />
            Save this view
          </MenuItem>
          {(views.data ?? []).map((v) => (
            <MenuItem key={`del-${v.id}`} destructive onSelect={() => remove.mutate(v.id)}>
              Delete “{v.name}”
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Save this view"
        description={Object.keys(filters).length ? 'The current search, filters and sort order, under a name you choose.' : 'There are no filters yet: this saves the full list.'}
        footer={
          <>
            <DialogClose asChild>
              <Button intent="secondary">Cancel</Button>
            </DialogClose>
            <Button
              loading={save.isPending}
              onClick={async () => {
                const err = rules.required(name, 'Give the view a name.');
                setError(err);
                if (err) return;
                try {
                  await save.mutateAsync({ scope: 'suppliers', name, query: filters });
                  setOpen(false);
                  setName('');
                } catch (e) {
                  setError(e instanceof ApiProblem ? e.message : 'The view could not be saved.');
                }
              }}
            >
              Save view
            </Button>
          </>
        }
      >
        <Field label="Name" error={error}>
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />}
        </Field>
      </Dialog>
    </>
  );
}

type AK = 'registration_number' | 'external_ref';
function AddSupplier() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ registration_number: '', external_ref: '', industry_profile: 'general' });
  const [errors, setErrors] = useState<Partial<Record<AK, string>>>({});
  const [existing, setExisting] = useState<string | null>(null);
  const add = useChange((b: unknown) => api<SupplierListItem>('/api/suppliers', { method: 'POST', body: b }), {
    invalidate: ['/api/suppliers', '/api/overview'],
    success: 'Supplier added',
    onSuccess: (s) => router.push(`/app/suppliers/${s.id}`),
  });
  const submit = async () => {
    const found = check<AK>({ registration_number: [rules.registration(v.registration_number)], external_ref: [] });
    setErrors(found);
    setExisting(null);
    if (Object.keys(found).length) return;
    try {
      await add.mutateAsync({ registration_number: v.registration_number, industry_profile: v.industry_profile, ...(v.external_ref ? { external_ref: v.external_ref } : {}) });
      setOpen(false);
    } catch (e) {
      if (e instanceof ApiProblem && e.code === 'already_added') setExisting(String(e.details.supplier_id));
      else setErrors(fromProblem(e, ['registration_number', 'external_ref'] as const).errors);
      if (e instanceof ApiProblem && !['already_added', 'validation_error'].includes(e.code)) setErrors((x) => ({ ...x, [e.code === 'external_ref_in_use' ? 'external_ref' : 'registration_number']: e.message }));
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Add a supplier"
      description="TshepoVet looks the company up on the CIPC register. Adding a supplier is free; checks are charged when you run them."
      trigger={
        <Button>
          <Plus aria-hidden="true" />
          Add a supplier
        </Button>
      }
      footer={
        <>
          <DialogClose asChild>
            <Button intent="secondary">Cancel</Button>
          </DialogClose>
          <Button loading={add.isPending} onClick={submit}>
            Add supplier
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <ErrorSummary errors={Object.entries(errors).map(([field, message]) => ({ field: `add-${field}`, message: message! }))} />
        {existing ? (
          <Callout tone="info" title="This supplier is already on your list">
            <p>
              <Link href={`/app/suppliers/${existing}`}>Open the supplier</Link>
            </p>
          </Callout>
        ) : null}
        <Field id="add-registration_number" label="Registration number" hint="As on the CIPC certificate, for example 2019/123456/07." error={errors.registration_number}>
          {(p) => <Input {...p} mono autoComplete="off" spellCheck={false} value={v.registration_number} onChange={(e) => setV((s) => ({ ...s, registration_number: e.target.value }))} />}
        </Field>
        <Field id="add-external_ref" label="Your reference" optional hint="Your own supplier number, if you have one." error={errors.external_ref}>
          {(p) => <Input {...p} value={v.external_ref} onChange={(e) => setV((s) => ({ ...s, external_ref: e.target.value }))} maxLength={100} />}
        </Field>
        <Field label="Industry" hint="Construction and logistics suppliers get the extra documents those industries need.">
          {(p) => <Select {...p} value={v.industry_profile} onValueChange={(x) => setV((s) => ({ ...s, industry_profile: x }))} options={INDUSTRY_OPTIONS} />}
        </Field>
      </div>
    </Dialog>
  );
}

