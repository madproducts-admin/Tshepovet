'use client';

import { Plus } from 'lucide-react';
import { useState } from 'react';
import { ROLE_LABELS, ROLE_PERMISSIONS, type Role } from '@tshepovet/contracts';
import { Button } from '@/components/ui/button';
import { type Column, DataTable, When } from '@/components/ui/data';
import { Stamp } from '@/components/ui/feedback';
import { Field, Input, Select } from '@/components/ui/form';
import { PageHeader, Sheet } from '@/components/ui/layout';
import { ConfirmDialog, Dialog, DialogClose } from '@/components/ui/overlay';
import { api, ApiProblem } from '@/lib/api';
import { rules } from '@/lib/forms';
import { useApi, useChange, useSession } from '@/lib/queries';
import { Loaded } from './common';

interface Member {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  mfa_enrolled: boolean;
  email_verified_at: string | null;
  last_login_at: string | null;
  disabled_at: string | null;
  created_at: string;
}
interface TeamView {
  members: Member[];
  invitations: Array<{ id: string; email: string; role: Role; expires_at: string; created_at: string }>;
  assignable_roles: Role[];
}

const ROLE_HINTS: Record<Role, string> = {
  owner: 'Everything, including other owners. Must use two-step verification.',
  admin: 'Everything except changing owners. Must use two-step verification.',
  compliance_officer: 'Suppliers, checks, monitoring, consent and the audit log.',
  procurement: 'Suppliers, checks and monitoring.',
  ap_clerk: 'Sees suppliers, manages payment locks and tops up the wallet.',
  viewer: 'Can look, cannot change anything.',
};

export function TeamPage() {
  const { session, can } = useSession();
  const q = useApi<TeamView>('/api/team');
  const manage = can('team:manage');
  return (
    <>
      <PageHeader title="Team" description="Who can use TshepoVet for your organisation, and what each role may do." actions={manage && q.data ? <Invite roles={q.data.assignable_roles} /> : null} />
      <Loaded q={q} label="The team">
        {(t) => {
          const cols: Column<Member>[] = [
            {
              key: 'name',
              header: 'Name',
              rowHeader: true,
              cell: (m) => (
                <div className="flex flex-col">
                  <span className="font-semibold">
                    {m.full_name}
                    {m.id === session.user.id ? ' (you)' : ''}
                  </span>
                  <span className="text-sm text-ink-2">{m.email}</span>
                </div>
              ),
            },
            { key: 'role', header: 'Role', cell: (m) => (manage && !m.disabled_at && m.id !== session.user.id ? <RoleChange m={m} roles={t.assignable_roles} /> : ROLE_LABELS[m.role]) },
            { key: 'mfa', header: 'Two-step verification', cell: (m) => (m.mfa_enrolled ? <Stamp tone="verified">On</Stamp> : <Stamp tone="caution">Off</Stamp>) },
            { key: 'seen', header: 'Last signed in', cell: (m) => (m.disabled_at ? <Stamp tone="neutral">Removed</Stamp> : m.last_login_at ? <When value={m.last_login_at} /> : <span className="text-ink-2">Not yet</span>) },
            {
              key: 'actions',
              header: 'Actions',
              cell: (m) => (manage && !m.disabled_at && m.id !== session.user.id && (m.role !== 'owner' || session.user.role === 'owner') ? <Remove m={m} /> : null),
            },
          ];
          return (
            <div className="flex flex-col gap-6">
              <Sheet title="Members" flush>
                <DataTable caption="Members" captionHidden columns={cols} rows={t.members} rowKey={(m) => m.id} />
              </Sheet>
              {t.invitations.length ? (
                <Sheet title="Waiting to accept">
                  <ul className="flex flex-col divide-y divide-rule">
                    {t.invitations.map((i) => (
                      <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                        <div>
                          <p className="font-semibold">{i.email}</p>
                          <p className="text-sm text-ink-2">
                            {ROLE_LABELS[i.role]}, invitation expires <When value={i.expires_at} />
                          </p>
                        </div>
                        {manage ? <Withdraw id={i.id} email={i.email} /> : null}
                      </li>
                    ))}
                  </ul>
                </Sheet>
              ) : null}
              <Sheet title="What each role may do">
                <dl className="grid gap-4 sm:grid-cols-2">
                  {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                    <div key={r} className="border-t border-rule pt-3">
                      <dt className="font-bold">{ROLE_LABELS[r]}</dt>
                      <dd className="text-ink-2">{ROLE_HINTS[r]}</dd>
                      <dd className="mt-1 text-sm text-ink-2">{ROLE_PERMISSIONS[r].length} permissions</dd>
                    </div>
                  ))}
                </dl>
              </Sheet>
            </div>
          );
        }}
      </Loaded>
    </>
  );
}

function Invite({ roles }: { roles: Role[] }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>(roles.includes('procurement') ? 'procurement' : roles[0] ?? 'viewer');
  const [error, setError] = useState<string>();
  const send = useChange((b: unknown) => api('/api/team/invitations', { method: 'POST', body: b }), { invalidate: ['/api/team'], success: 'Invitation sent' });
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Invite someone"
      description="They get an email with a link that works for 7 days."
      trigger={
        <Button>
          <Plus aria-hidden="true" />
          Invite someone
        </Button>
      }
      footer={
        <>
          <DialogClose asChild>
            <Button intent="secondary">Cancel</Button>
          </DialogClose>
          <Button
            loading={send.isPending}
            onClick={async () => {
              const err = rules.required(email, 'Enter their work email address.') ?? rules.email(email);
              setError(err);
              if (err) return;
              try {
                await send.mutateAsync({ email, role });
                setOpen(false);
                setEmail('');
              } catch (e) {
                setError(e instanceof ApiProblem ? e.message : 'The invitation could not be sent.');
              }
            }}
          >
            Send invitation
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="Email address" error={error}>
          {(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field label="Role" hint={ROLE_HINTS[role as Role]}>
          {(p) => <Select {...p} value={role} onValueChange={setRole} options={roles.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} />}
        </Field>
      </div>
    </Dialog>
  );
}

function RoleChange({ m, roles }: { m: Member; roles: Role[] }) {
  const [error, setError] = useState<string | null>(null);
  const change = useChange((role: string) => api(`/api/team/members/${m.id}`, { method: 'PATCH', body: { role } }), { invalidate: ['/api/team'], success: `${m.full_name}’s role changed` });
  return (
    <div className="flex min-w-48 flex-col gap-1">
      <Select
        aria-describedby={undefined}
        id={`role-${m.id}`}
        value={m.role}
        onValueChange={async (role) => {
          setError(null);
          try {
            await change.mutateAsync(role);
          } catch (e) {
            setError(e instanceof ApiProblem ? e.message : 'The role could not be changed.');
          }
        }}
        options={(roles.includes(m.role) ? roles : [m.role, ...roles]).map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
      />
      <label htmlFor={`role-${m.id}`} className="sr-only">
        Role for {m.full_name}
      </label>
      {error ? <p className="text-sm font-semibold text-red">{error}</p> : null}
    </div>
  );
}

function Remove({ m }: { m: Member }) {
  const remove = useChange(() => api(`/api/team/members/${m.id}/disable`, { method: 'POST' }), { invalidate: ['/api/team'], success: `${m.full_name} removed` });
  return (
    <ConfirmDialog
      trigger={
        <Button intent="quiet" size="sm">
          Remove
        </Button>
      }
      title={`Remove ${m.full_name}?`}
      consequence={<p>They are signed out everywhere at once and cannot sign in again. Their past actions stay in the audit log.</p>}
      confirmLabel="Remove from the team"
      destructive
      busy={remove.isPending}
      onConfirm={() => remove.mutate(undefined)}
    />
  );
}

function Withdraw({ id, email }: { id: string; email: string }) {
  const withdraw = useChange(() => api(`/api/team/invitations/${id}`, { method: 'DELETE' }), { invalidate: ['/api/team'], success: 'Invitation withdrawn' });
  return (
    <ConfirmDialog
      trigger={
        <Button intent="quiet" size="sm">
          Withdraw
        </Button>
      }
      title={`Withdraw the invitation to ${email}?`}
      consequence={<p>The link in their email stops working. You can invite them again later.</p>}
      confirmLabel="Withdraw invitation"
      busy={withdraw.isPending}
      onConfirm={() => withdraw.mutate(undefined)}
    />
  );
}

