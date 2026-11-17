'use client';

import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { X } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from './button';

/**
 * Overlays. Dialogs trap focus and return it on close (Radix); confirmations name the action
 * on both buttons, and what cannot be undone says so (WCAG 3.3.6: review before committing).
 */
const surface = 'rounded-sheet border border-rule bg-sheet text-ink shadow-sheet';
const scrim = 'fixed inset-0 z-40 bg-[rgb(8_18_23/0.55)] data-[state=open]:animate-in';

export function Dialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger> : null}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={scrim} />
        <DialogPrimitive.Content
          className={cn(surface, 'fixed top-1/2 left-1/2 z-50 flex max-h-[min(90dvh,48rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col', wide ? 'max-w-3xl' : 'max-w-lg')}
          aria-describedby={description ? undefined : undefined}
        >
          <div className="flex items-start justify-between gap-4 border-b border-rule px-6 pt-5 pb-4">
            <div>
              <DialogPrimitive.Title className="text-xl font-bold">{title}</DialogPrimitive.Title>
              {description ? <DialogPrimitive.Description className="mt-1 text-ink-2">{description}</DialogPrimitive.Description> : null}
            </div>
            <DialogPrimitive.Close asChild>
              <Button intent="quiet" size="icon" aria-label="Close">
                <X aria-hidden="true" />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className="overflow-y-auto px-6 py-5">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-3 border-t border-rule px-6 py-4">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export const DialogClose = DialogPrimitive.Close;

/** "Are you sure?" with the consequence spelled out and the action named on the button. */
export function ConfirmDialog({
  open,
  onOpenChange,
  trigger,
  title,
  consequence,
  confirmLabel,
  cancelLabel = 'Keep it',
  destructive,
  busy,
  onConfirm,
}: {
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  trigger?: ReactNode;
  title: ReactNode;
  consequence: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <AlertDialogPrimitive.Trigger asChild>{trigger}</AlertDialogPrimitive.Trigger> : null}
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className={scrim} />
        <AlertDialogPrimitive.Content className={cn(surface, 'fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 p-6')}>
          <AlertDialogPrimitive.Title className="text-xl font-bold">{title}</AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description asChild>
            <div className="mt-2 text-ink-2">{consequence}</div>
          </AlertDialogPrimitive.Description>
          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <AlertDialogPrimitive.Cancel asChild>
              <Button intent="secondary">{cancelLabel}</Button>
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action asChild>
              <Button
                intent={destructive ? 'danger' : 'primary'}
                loading={busy}
                onClick={(e) => {
                  e.preventDefault();
                  onConfirm();
                }}
              >
                {confirmLabel}
              </Button>
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}

// --- Menus ---------------------------------------------------------------------------------
/** Menus are not modal: the page stays readable and reachable behind an open menu (focus still
 *  moves into it, Escape closes it and returns focus to the button). */
export function Menu(props: ComponentProps<typeof MenuPrimitive.Root>) {
  return <MenuPrimitive.Root modal={false} {...props} />;
}
export const MenuTrigger = MenuPrimitive.Trigger;

export function MenuContent({ className, children, ...props }: ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    // Rendered beside its button, not in a portal: it stays inside the same landmark.
    <MenuPrimitive.Content sideOffset={6} align="end" className={cn(surface, 'z-50 min-w-56 p-1', className)} {...props}>
      {children}
    </MenuPrimitive.Content>
  );
}

export function MenuItem({ className, destructive, ...props }: ComponentProps<typeof MenuPrimitive.Item> & { destructive?: boolean }) {
  return (
    <MenuPrimitive.Item
      className={cn(
        'flex min-h-11 cursor-default items-center gap-2.5 rounded-[4px] px-3 text-base outline-none select-none data-disabled:opacity-60 data-highlighted:bg-violet-tint [&_svg]:size-[1.125rem]',
        destructive && 'text-red',
        className,
      )}
      {...props}
    />
  );
}

export function MenuLabel({ className, ...props }: ComponentProps<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={cn('px-3 pt-2 pb-1 text-sm text-ink-2', className)} {...props} />;
}

export function MenuSeparator() {
  return <MenuPrimitive.Separator className="my-1 h-px bg-rule" />;
}

// --- Popover and tooltip -----------------------------------------------------------------------
export function Popover({ trigger, children, label }: { trigger: ReactNode; children: ReactNode; label: string }) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Content aria-label={label} sideOffset={6} className={cn(surface, 'z-50 w-80 max-w-[calc(100vw-2rem)] p-4')}>
        {children}
        <PopoverPrimitive.Arrow className="fill-sheet" />
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Root>
  );
}

/**
 * A tooltip repeats what a control already says to assistive technology (its aria-label); it
 * never carries information found nowhere else. It stays while hovered and closes on Escape.
 */
export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Content sideOffset={6} className="z-50 max-w-xs rounded-control bg-ink px-3 py-2 text-sm text-paper">
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
