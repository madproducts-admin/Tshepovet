'use client';

import { useState } from 'react';
import type { z } from 'zod';
import type { SupplierInviteSchema } from '@tshepovet/contracts';
import { Button } from '@/components/ui/button';
import { type Column, DataTable, When } from '@/components/ui/data';
import { Callout, Stamp } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/form';
import { Sheet } from '@/components/ui/layout';
import { ConfirmDialog, Dialog, DialogClose } from '@/components/ui/overlay';
import { api } from '@/lib/api';
import { formatDay } from '@/lib/format';
import { fromProblem, rules } from '@/lib/forms';
import { useApi, useChange } from '@/lib/queries';
import { Loaded } from './common';

/** A buyer inviting a supplier to onboard itself, and the invitations sent so far. */
type SupplierInvite = z.infer<typeof SupplierInviteSchema>;

export function InviteSupplier({ id, name }: { id: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [contact, setContact] = useState('');
  const [errors, setErrors] = useState<{ email?: string; contact_name?: string; form?: string }>({});
  const send = useChange((b: unknown) => api<SupplierInvite>(`/api/suppliers/${id}/invitations`, { method: 'POST', body: b }), {
    invalidate: [`/api/suppliers/${id}`],
    success: (r) => `Invitation sent to ${r.email}`,
  });
  const submit = async () => {
    const err = rules.required(email, 'Enter the supplier contact’s email address.') ?? rules.email(email);
    setErrors(err ? { email: err } : {});
    if (err) return;
    try {
      await send.mutateAsync({ email: email.trim(), ...(contact.trim() ? { contact_name: contact.trim() } : {}) });
      setOpen(false);
      setEmail('');
      setContact('');
    } catch (e) {
      const f = fromProblem(e, ['email', 'contact_name'] as const);
      setErrors({ ...f.errors, form: Object.keys(f.errors).length ? undefined : f.message });
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Invite the supplier to onboard"
      description={`We email a link that works for 14 days, and ${name} adds its details itself. Only the newest link works.`}
      trigger={<Button intent="secondary">Invite to onboard</Button>}
      footer={
        <>
          <DialogClose asChild>
            <Button intent="secondary">Cancel</Button>
          </DialogClose>
          <Button loading={send.isPending} onClick={submit}>
            Send the invitation
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {errors.form ? <Callout tone="refused" title={errors.form} /> : null}
        <Field id="inv-email" label="Supplier contact’s email address" hint="Ideally a director: only a director can publish the supplier’s passport." error={errors.email}>
          {(p) => <Input {...p} type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field id="inv-name" label="Their name" optional error={errors.contact_name}>
          {(p) => <Input {...p} autoComplete="off" value={contact} onChange={(e) => setContact(e.target.value)} maxLength={120} />}
        </Field>
        <p className="text-sm text-ink-2">The register lookup and tax check run while the supplier onboards are charged to your wallet, at the usual prices.</p>
      </div>
    </Dialog>
  );
}

function inviteState(i: SupplierInvite): { tone: 'verified' | 'caution' | 'pending' | 'neutral'; label: string; open: boolean } {
  if (i.revoked_at) return { tone: 'neutral', label: 'Withdrawn', open: false };
  if (i.completed_at) return { tone: 'verified', label: 'Submitted', open: false };
  if (Date.parse(i.expires_at) < Date.now()) return { tone: 'caution', label: 'Expired', open: false };
  if (i.opened_at) return { tone: 'pending', label: 'Opened', open: true };
  return { tone: 'pending', label: 'Sent', open: true };
}

export function Invitations({ id, canWrite }: { id: string; canWrite: boolean }) {
  const q = useApi<SupplierInvite[]>(`/api/suppliers/${id}/invitations`);
  const [target, setTarget] = useState<SupplierInvite | null>(null);
  const withdraw = useChange((inviteId: string) => api(`/api/suppliers/${id}/invitations/${inviteId}`, { method: 'DELETE' }), {
    invalidate: [`/api/suppliers/${id}`],
    success: 'Invitation withdrawn',
  });
  const columns: Column<SupplierInvite>[] = [
    { key: 'email', header: 'Sent to', rowHeader: true, cell: (i) => <span className="font-semibold">{i.contact_name ? `${i.contact_name} (${i.email})` : i.email}</span> },
    {
      key: 'state',
      header: 'Status',
      cell: (i) => {
        const st = inviteState(i);
        return <Stamp tone={st.tone}>{st.label}</Stamp>;
      },
    },
    { key: 'sent', header: 'Sent', cell: (i) => <When value={i.created_at} /> },
    { key: 'until', header: 'Link works until', cell: (i) => formatDay(i.expires_at) },
  ];
  if (canWrite) {
    columns.push({
      key: 'actions',
      header: 'Actions',
      cell: (i) =>
        inviteState(i).open ? (
          <Button intent="secondary" size="sm" onClick={() => setTarget(i)}>
            Withdraw<span className="sr-only"> the invitation to {i.email}</span>
          </Button>
        ) : null,
    });
  }
  return (
    <Loaded q={q} label="Invitations">
      {(rows) => (
        <Sheet title="Onboarding invitations" description="The supplier fills in its own details from the emailed link. Newest first." flush>
          <DataTable
            caption="Onboarding invitations"
            captionHidden
            columns={columns}
            rows={rows}
            rowKey={(i) => i.id}
            empty="No invitations yet. Use “Invite to onboard” at the top of the page."
          />
          <ConfirmDialog
            open={target !== null}
            onOpenChange={(o) => !o && setTarget(null)}
            title="Withdraw the invitation?"
            consequence={target ? `The link sent to ${target.email} stops working at once. What the supplier already entered stays on the record.` : ''}
            confirmLabel="Withdraw the invitation"
            destructive
            busy={withdraw.isPending}
            onConfirm={async () => {
              if (!target) return;
              try {
                await withdraw.mutateAsync(target.id);
              } finally {
                setTarget(null);
              }
            }}
          />
        </Sheet>
      )}
    </Loaded>
  );
}
