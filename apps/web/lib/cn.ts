import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/** Tailwind-aware class joining (the design tokens add their own text sizes and radii). */
const merge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl'],
      radius: ['stamp', 'control', 'sheet'],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return merge(clsx(inputs));
}
