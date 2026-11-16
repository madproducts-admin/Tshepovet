import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/**
 * Buttons. Every size is at least 44 by 44 CSS pixels (WCAG 2.5.5, AAA target size). Stamp
 * ink (violet) means "you can do this"; red is kept for what cannot be undone.
 */
export const buttonVariants = cva(
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-control font-semibold whitespace-nowrap transition-[background-color,border-color,color,box-shadow] duration-150 select-none disabled:cursor-not-allowed disabled:opacity-60 aria-busy:cursor-progress [&_svg]:size-[1.125rem] [&_svg]:shrink-0',
  {
    variants: {
      intent: {
        primary: 'bg-violet text-on-violet hover:bg-violet-strong',
        secondary: 'border border-edge bg-sheet text-ink hover:border-ink hover:bg-sheet-2',
        quiet: 'text-violet hover:bg-violet-tint',
        danger: 'bg-red text-sheet hover:opacity-90',
      },
      size: {
        md: 'px-5 text-base',
        sm: 'px-3.5 text-sm',
        icon: 'size-11 p-0',
      },
      block: { true: 'w-full' },
    },
    defaultVariants: { intent: 'primary', size: 'md' },
  },
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element (a link) with button styling. */
    asChild?: boolean;
    /** Shows progress and blocks repeat presses; the label stays readable. */
    loading?: boolean;
  };

export function Button({ className, intent, size, block, asChild, loading, disabled, children, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      className={cn(buttonVariants({ intent, size, block }), className)}
      disabled={asChild ? undefined : disabled || loading}
      aria-busy={loading || undefined}
      type={asChild ? undefined : (type ?? 'button')}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
          {children}
        </>
      )}
    </Comp>
  );
}
