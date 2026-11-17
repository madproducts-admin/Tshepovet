'use client';

import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as RadioPrimitive from '@radix-ui/react-radio-group';
import * as SelectPrimitive from '@radix-ui/react-select';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { Check, ChevronDown, CircleAlert, Search } from 'lucide-react';
import { type ComponentProps, type ReactNode, useId } from 'react';
import { cn } from '@/lib/cn';

/**
 * Form controls. A field always has a visible label; hints and errors are tied to the control
 * with aria-describedby, and an error says what to do, next to the field it is about. Optional
 * fields are marked "(optional)" rather than required ones with a symbol.
 */
export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  'aria-required'?: true;
}

export function Field({
  label,
  hint,
  error,
  optional,
  children,
  className,
  id: fixedId,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  children: (control: FieldControlProps) => ReactNode;
  className?: string;
  /** A stable id for the control, so an error summary can link to it. */
  id?: string;
}) {
  const generated = useId();
  const id = fixedId ?? generated;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-base font-semibold text-ink">
        {label}
        {optional ? <span className="font-normal text-ink-2"> (optional)</span> : null}
      </label>
      {hint ? (
        <p id={hintId} className="text-sm text-ink-2">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 text-sm font-semibold text-red">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            <span className="sr-only">Error: </span>
            {error}
          </span>
        </p>
      ) : null}
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined, 'aria-required': optional ? undefined : true })}
    </div>
  );
}

const control =
  'w-full rounded-control border border-edge bg-sheet px-3 text-base text-ink placeholder:text-ink-2 transition-[border-color,box-shadow] hover:border-ink aria-invalid:border-2 aria-invalid:border-red disabled:cursor-not-allowed disabled:bg-sheet-2';

export function Input({ className, mono, ...props }: ComponentProps<'input'> & { mono?: boolean }) {
  return <input className={cn(control, 'min-h-11', mono && 'font-mono tracking-wide', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(control, 'min-h-28 py-2.5 leading-relaxed', className)} {...props} />;
}

/** A search box with a visible label (or an accessible one when the context makes it plain). */
export function SearchField({ label, hideLabel, className, ...props }: ComponentProps<'input'> & { label: string; hideLabel?: boolean }) {
  const id = useId();
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'text-base font-semibold'}>
        {label}
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-[1.125rem] -translate-y-1/2 text-ink-2" aria-hidden="true" />
        <input id={id} type="search" className={cn(control, 'min-h-11 pl-10')} {...props} />
      </div>
    </div>
  );
}

export interface Option {
  value: string;
  label: string;
}

export function Select({
  options,
  value,
  onValueChange,
  placeholder = 'Choose one',
  ...control_
}: Partial<FieldControlProps> & { options: Option[]; value?: string; onValueChange: (v: string) => void; placeholder?: string; disabled?: boolean }) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={control_.disabled}>
      <SelectPrimitive.Trigger
        id={control_.id}
        aria-describedby={control_['aria-describedby']}
        aria-invalid={control_['aria-invalid']}
        className={cn(control, 'inline-flex min-h-11 items-center justify-between gap-2 text-left data-placeholder:text-ink-2')}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown className="size-[1.125rem]" aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={4} className="z-50 max-h-80 min-w-(--radix-select-trigger-width) overflow-hidden rounded-control border border-edge bg-sheet shadow-sheet">
          <SelectPrimitive.Viewport className="p-1">
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                className="relative flex min-h-11 cursor-default items-center rounded-[4px] py-2 pr-3 pl-9 text-base outline-none select-none data-highlighted:bg-violet-tint data-highlighted:text-ink"
              >
                <SelectPrimitive.ItemIndicator className="absolute left-2.5">
                  <Check className="size-4 text-violet" aria-hidden="true" />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

/**
 * A checkbox with its label. The label wraps the control, so the whole row (at least 44px
 * tall) is the target (WCAG 2.5.5); the hint sits below and is read as the description.
 */
export function Checkbox({
  label,
  hint,
  checked,
  onCheckedChange,
  disabled,
  invalid,
  describedBy,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col">
      <label htmlFor={id} className="flex min-h-11 cursor-pointer items-center gap-3 py-1.5 text-base leading-snug">
        <CheckboxPrimitive.Root
          id={id}
          checked={checked}
          onCheckedChange={(v) => onCheckedChange(v === true)}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={[hint ? `${id}-hint` : '', describedBy ?? ''].join(' ').trim() || undefined}
          className="grid size-6 shrink-0 place-items-center rounded-[4px] border-2 border-edge bg-sheet data-[state=checked]:border-violet data-[state=checked]:bg-violet aria-invalid:border-red"
        >
          <CheckboxPrimitive.Indicator>
            <Check className="size-4 text-on-violet" strokeWidth={3} aria-hidden="true" />
          </CheckboxPrimitive.Indicator>
        </CheckboxPrimitive.Root>
        <span>{label}</span>
      </label>
      {hint ? (
        <span id={`${id}-hint`} className="pl-9 text-sm text-ink-2">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function RadioGroup({
  legend,
  options,
  value,
  onValueChange,
  hint,
}: {
  legend: ReactNode;
  options: Array<Option & { hint?: string }>;
  value: string;
  onValueChange: (v: string) => void;
  hint?: ReactNode;
}) {
  const id = useId();
  return (
    <fieldset className="flex flex-col gap-1" aria-describedby={hint ? `${id}-hint` : undefined}>
      <legend className="mb-1 text-base font-semibold">{legend}</legend>
      {hint ? (
        <p id={`${id}-hint`} className="mb-1 text-sm text-ink-2">
          {hint}
        </p>
      ) : null}
      <RadioPrimitive.Root value={value} onValueChange={onValueChange} className="flex flex-col gap-1">
        {options.map((o) => (
          <div key={o.value} className="flex flex-col">
            <label htmlFor={`${id}-${o.value}`} className="flex min-h-11 cursor-pointer items-center gap-3 py-1.5 leading-snug">
              <RadioPrimitive.Item
                id={`${id}-${o.value}`}
                value={o.value}
                aria-describedby={o.hint ? `${id}-${o.value}-hint` : undefined}
                className="grid size-6 shrink-0 place-items-center rounded-full border-2 border-edge bg-sheet data-[state=checked]:border-violet"
              >
                <RadioPrimitive.Indicator className="size-3 rounded-full bg-violet" />
              </RadioPrimitive.Item>
              <span>{o.label}</span>
            </label>
            {o.hint ? (
              <span id={`${id}-${o.value}-hint`} className="pl-9 text-sm text-ink-2">
                {o.hint}
              </span>
            ) : null}
          </div>
        ))}
      </RadioPrimitive.Root>
    </fieldset>
  );
}

/**
 * An on/off setting that takes effect at once (inside a form that is submitted, use a
 * checkbox). The label row is the target; role="switch" announces on or off by itself.
 */
export function Switch({ label, hint, checked, onCheckedChange, disabled }: { label: ReactNode; hint?: ReactNode; checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex flex-col">
      <label htmlFor={id} className="flex min-h-11 cursor-pointer items-center justify-between gap-4 py-1.5">
        <span className="font-semibold">{label}</span>
        <SwitchPrimitive.Root
          id={id}
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className="relative inline-flex h-8 w-14 shrink-0 items-center rounded-full border-2 border-edge bg-sheet-2 transition-colors data-[state=checked]:border-violet data-[state=checked]:bg-violet"
        >
          <SwitchPrimitive.Thumb className="block size-5 translate-x-1 rounded-full bg-ink-2 transition-transform data-[state=checked]:translate-x-7 data-[state=checked]:bg-on-violet" />
        </SwitchPrimitive.Root>
      </label>
      {hint ? (
        <span id={`${id}-hint`} className="text-sm text-ink-2">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** A form-level error summary: it takes focus so screen reader and keyboard users land on it. */
export function ErrorSummary({ title = 'Check the form', errors }: { title?: string; errors: Array<{ field?: string; message: string }> }) {
  if (!errors.length) return null;
  return (
    <div role="alert" tabIndex={-1} ref={(el) => el?.focus()} className="rounded-sheet border-2 border-red bg-red-tint p-4 text-ink">
      <h2 className="flex items-center gap-2 text-lg font-bold text-red">
        <CircleAlert className="size-5" aria-hidden="true" />
        {title}
      </h2>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        {errors.map((e, i) => (
          <li key={i}>{e.field ? <a href={`#${e.field}`}>{e.message}</a> : e.message}</li>
        ))}
      </ul>
    </div>
  );
}
