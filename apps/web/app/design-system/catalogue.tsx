'use client';

import { Download, LogOut, MoreHorizontal, Plus, Settings, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { CodeBlock, type Column, DataTable, Money, Pagination, SecretReveal, type SortState, Tabs, Term, When } from '@/components/ui/data';
import { Checkbox, ErrorSummary, Field, Input, RadioGroup, SearchField, Select, Switch, Textarea } from '@/components/ui/form';
import { ConfirmDialog, Dialog, DialogClose, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Popover, Tooltip } from '@/components/ui/overlay';
import { toast } from '@/components/ui/toast';
import { ThemeSwitch } from '@/components/ui/theme';
import type { ThemeChoice } from '@/lib/theme';

/** The interactive half of the catalogue: controls you can press, type into and open. */
interface Row {
  id: string;
  name: string;
  reg: string;
  outcome: string;
  spend: number;
  checked: string;
}

const ROWS: Row[] = [
  { id: '1', name: 'Acme Trading (Pty) Ltd', reg: '2019/123456/07', outcome: 'Verified', spend: 1_250_000, checked: '2026-11-12T09:30:00Z' },
  { id: '2', name: 'Khumalo Haulage CC', reg: '2008/045512/23', outcome: 'Verified, with warnings', spend: 412_050, checked: '2026-11-03T14:05:00Z' },
  { id: '3', name: 'Ubuntu Office Supplies (Pty) Ltd', reg: '2021/778201/07', outcome: 'Failed checks', spend: 98_000, checked: '2026-10-28T07:45:00Z' },
  { id: '4', name: 'Mokoena Engineering (Pty) Ltd', reg: '2015/300984/07', outcome: 'Not found', spend: 0, checked: '2026-10-02T11:00:00Z' },
];

export function InteractiveCatalogue({ theme }: { theme: ThemeChoice }) {
  const [sort, setSort] = useState<SortState>({ sort: 'name', order: 'asc' });
  const [page, setPage] = useState(1);
  const [entity, setEntity] = useState('');
  const [freshness, setFreshness] = useState('cached_ok');
  const [consent, setConsent] = useState(false);
  const [monitor, setMonitor] = useState(true);
  const [reg, setReg] = useState('2019/12345/07');
  const [submitted, setSubmitted] = useState(false);

  const rows = useMemo(() => {
    const key = sort.sort as keyof Row;
    return [...ROWS].sort((a, b) => (a[key] > b[key] ? 1 : -1) * (sort.order === 'asc' ? 1 : -1));
  }, [sort]);
  const columns: Column<Row>[] = [
    { key: 'name', header: 'Supplier', sortable: true, rowHeader: true, cell: (r) => <span className="font-semibold">{r.name}</span> },
    { key: 'reg', header: 'Registration number', cell: (r) => <span className="font-mono">{r.reg}</span> },
    { key: 'outcome', header: 'Last check', sortable: true, cell: (r) => r.outcome },
    { key: 'spend', header: 'Spend this year', sortable: true, align: 'end', cell: (r) => <Money cents={r.spend} /> },
    { key: 'checked', header: 'Checked', sortable: true, cell: (r) => <When value={r.checked} /> },
  ];
  const regError = submitted && !/^\d{4}\/\d{6}\/\d{2}$/.test(reg) ? 'Use the CIPC format: four digits, six digits and two digits, for example 2019/123456/07.' : undefined;
  const consentError = submitted && !consent ? 'Confirm that the supplier agreed to the check.' : undefined;

  return (
    <div className="flex flex-col gap-12">
      <section aria-labelledby="buttons" className="flex flex-col gap-4">
        <h2 id="buttons" className="text-2xl font-bold">
          Buttons
        </h2>
        <p className="text-ink-2">Stamp ink for what you can do; red only for what cannot be undone. Every target is at least 44 pixels square.</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => toast.success('Check started', 'Acme Trading (Pty) Ltd is being checked.')}>
            <Plus aria-hidden="true" />
            Run a check
          </Button>
          <Button intent="secondary">
            <Download aria-hidden="true" />
            Export CSV
          </Button>
          <Button intent="quiet">Cancel</Button>
          <Button intent="danger" onClick={() => toast.error('Could not revoke the key', 'The connection dropped. Try again.')}>
            Revoke key
          </Button>
          <Button loading>Saving</Button>
          <Button disabled>Not available</Button>
          <Tooltip content="Settings">
            <Button intent="secondary" size="icon" aria-label="Settings">
              <Settings aria-hidden="true" />
            </Button>
          </Tooltip>
        </div>
      </section>

      <section aria-labelledby="forms" className="flex flex-col gap-4">
        <h2 id="forms" className="text-2xl font-bold">
          Forms
        </h2>
        <p className="text-ink-2">Labels always visible, hints before the field, errors that say how to fix the problem. Press &ldquo;Check the form&rdquo; to see them.</p>
        <form
          noValidate
          className="flex max-w-xl flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(true);
          }}
        >
          {submitted && (regError || consentError) ? (
            <ErrorSummary errors={[...(regError ? [{ field: 'demo-reg', message: regError }] : []), ...(consentError ? [{ message: consentError }] : [])]} />
          ) : null}
          <Field id="demo-reg" label="Registration number" hint={<>As it appears on the supplier&rsquo;s <Term term="CIPC" /> certificate.</>} error={regError}>
            {(p) => <Input {...p} mono value={reg} onChange={(e) => setReg(e.target.value)} autoComplete="off" spellCheck={false} />}
          </Field>
          <Field label="Your reference" optional hint="Your own supplier number, if you have one.">
            {(p) => <Input {...p} />}
          </Field>
          <Field label="Entity type">
            {(p) => (
              <Select
                {...p}
                value={entity}
                onValueChange={setEntity}
                options={[
                  { value: 'private_company', label: 'Private company (Pty) Ltd' },
                  { value: 'close_corporation', label: 'Close corporation (CC)' },
                  { value: 'sole_proprietor', label: 'Sole proprietor' },
                ]}
              />
            )}
          </Field>
          <RadioGroup
            legend="How fresh must the data be?"
            value={freshness}
            onValueChange={setFreshness}
            options={[
              { value: 'cached_ok', label: 'A recent result is fine', hint: 'Uses a result from the last 24 hours when there is one. R3,00.' },
              { value: 'live', label: 'Ask the bureaus now', hint: 'Always a fresh lookup. R6,00.' },
            ]}
          />
          <Field label="Notes" optional>
            {(p) => <Textarea {...p} />}
          </Field>
          <Checkbox
            label="The supplier agreed to this check"
            hint="Keep their signed onboarding form: TshepoVet records your reference to it."
            checked={consent}
            onCheckedChange={setConsent}
            invalid={Boolean(consentError)}
          />
          <Switch label="Keep monitoring this supplier" hint="Re-checks before expiry dates and warns you when something lapses." checked={monitor} onCheckedChange={setMonitor} />
          <SearchField label="Search suppliers" placeholder="Name, registration number or your reference" />
          <div className="flex gap-3">
            <Button type="submit">Check the form</Button>
            <Button intent="secondary" onClick={() => setSubmitted(false)}>
              Clear errors
            </Button>
          </div>
        </form>
      </section>

      <section aria-labelledby="overlays" className="flex flex-col gap-4">
        <h2 id="overlays" className="text-2xl font-bold">
          Dialogs and menus
        </h2>
        <div className="flex flex-wrap gap-3">
          <Dialog
            trigger={<Button intent="secondary">Open a dialog</Button>}
            title="Add a supplier"
            description="Enter the registration number. TshepoVet looks the company up on the CIPC register."
            footer={
              <>
                <DialogClose asChild>
                  <Button intent="secondary">Cancel</Button>
                </DialogClose>
                <Button>Add supplier</Button>
              </>
            }
          >
            <Field label="Registration number">{(p) => <Input {...p} mono />}</Field>
          </Dialog>
          <ConfirmDialog
            trigger={<Button intent="secondary">Ask for confirmation</Button>}
            title="Revoke this API key?"
            consequence={
              <p>
                Systems using <code className="font-mono">tv_test_8f3k2m1q</code> stop working at once. This cannot be undone: you would make a new key.
              </p>
            }
            confirmLabel="Revoke key"
            cancelLabel="Keep the key"
            destructive
            onConfirm={() => toast.success('Key revoked')}
          />
          <Menu>
            <MenuTrigger asChild>
              <Button intent="secondary" aria-label="More actions">
                <MoreHorizontal aria-hidden="true" />
                More
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuLabel>Thandi Mokoena</MenuLabel>
              <MenuItem>
                <Settings aria-hidden="true" />
                Account settings
              </MenuItem>
              <MenuSeparator />
              <MenuItem destructive>
                <Trash2 aria-hidden="true" />
                Remove supplier
              </MenuItem>
              <MenuItem>
                <LogOut aria-hidden="true" />
                Sign out
              </MenuItem>
            </MenuContent>
          </Menu>
          <Popover label="What is a TCS PIN?" trigger={<Button intent="quiet">What is a TCS PIN?</Button>}>
            <p className="text-sm">
              A PIN the supplier creates on SARS eFiling. It lets you see their tax compliance status, live, until it expires. It is not their tax number.
            </p>
          </Popover>
        </div>
      </section>

      <section aria-labelledby="tables" className="flex flex-col gap-4">
        <h2 id="tables" className="text-2xl font-bold">
          Tables
        </h2>
        <div className="overflow-hidden rounded-sheet border border-rule bg-sheet shadow-sheet">
          <DataTable caption="Suppliers (example data)" columns={columns} rows={rows} rowKey={(r) => r.id} sort={sort} onSort={setSort} />
          <div className="border-t border-rule">
            <Pagination page={page} pageSize={4} total={37} noun={['supplier', 'suppliers']} onPage={setPage} />
          </div>
        </div>
      </section>

      <section aria-labelledby="tabs" className="flex flex-col gap-4">
        <h2 id="tabs" className="text-2xl font-bold">
          Tabs
        </h2>
        <Tabs
          label="Supplier record"
          tabs={[
            { value: 'facts', label: 'Facts', content: <p>Registration, directors and tax status, each with the date it was true.</p> },
            { value: 'checks', label: 'Checks', content: <p>Every check run on this supplier, newest first.</p> },
            { value: 'documents', label: 'Documents', content: <p>Certificates and letters, with their expiry dates.</p> },
          ]}
        />
      </section>

      <section aria-labelledby="secrets" className="flex flex-col gap-4">
        <h2 id="secrets" className="text-2xl font-bold">
          Secrets and code
        </h2>
        <SecretReveal label="Your new test key" secret="tv_test_8f3k2m1q.Qm9vZ2xlLWV4YW1wbGUtc2VjcmV0LW5vdC1yZWFs" />
        <CodeBlock
          label="Check a company with curl"
          code={`curl https://tshepovet.madproducts.ai/v1/verify/company \\
  -H "Authorization: Bearer $TSHEPOVET_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"registration_number":"2019/123456/07"}'`}
        />
      </section>

      <section aria-labelledby="theme" className="flex flex-col gap-4">
        <h2 id="theme" className="text-2xl font-bold">
          Theme
        </h2>
        <p className="text-ink-2">Both themes meet AAA contrast. The choice is remembered on this device.</p>
        <div className="max-w-sm">
          <ThemeSwitch initial={theme} />
        </div>
      </section>
    </div>
  );
}
