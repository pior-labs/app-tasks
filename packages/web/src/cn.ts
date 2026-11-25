import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Joins class names, and lets a later Tailwind utility override an earlier one
// of the same kind, so a caller's className can adjust a primitive's defaults.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
