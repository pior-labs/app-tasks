import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

// The app's control vocabulary, after the Cookbook's: screens compose these
// rather than restating the same twenty utilities, so a button in Manage lists
// is the same button as one in a task row.
//
// Pending controls in Tasks are locked with aria-disabled instead of disabled
// (a disabled control drops keyboard focus), so every control dims on
// aria-disabled as well as on disabled.

export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-cream';

export type ButtonVariant = 'primary' | 'ghost' | 'quiet' | 'danger';
export type ButtonSize = 'default' | 'small';

const VARIANTS: Record<ButtonVariant, string> = {
  // The one solid action in a place. Everything else steps back from it.
  primary:
    'border-ink/10 bg-ink text-cream shadow-[var(--tk-action-shadow)] hover:bg-[var(--tk-action-hover-bg)] hover:shadow-[var(--tk-action-shadow-hover)]',
  ghost:
    'border-frost/80 bg-[rgba(var(--surface-rgb),0.92)] text-ink shadow-[var(--tk-control-shadow)] hover:bg-frost',
  // Lower emphasis, not invisible: a light resting surface still reads as an
  // action without needing a hover.
  quiet: 'border-transparent bg-ink/[0.05] text-ink-2 hover:bg-ink/[0.09] hover:text-ink',
  // Only for the confirm of an irreversible action.
  danger:
    'border-transparent bg-destructive text-cream shadow-[0_10px_24px_-12px_var(--tk-danger-border)] hover:brightness-95',
};

// A coarse pointer gets the full touch target back on the dense small size.
const SIZES: Record<ButtonSize, string> = {
  default: 'min-h-11 px-5 text-[15px]',
  small: 'min-h-[34px] px-3.5 text-[13px] pointer-coarse:min-h-11 pointer-coarse:px-4',
};

export function buttonClass(variant: ButtonVariant = 'ghost', size: ButtonSize = 'default', className?: string) {
  return cn(
    'inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full border py-1.5 font-medium whitespace-nowrap',
    'transition-[background-color,box-shadow,color,filter] duration-200 ease-out',
    'disabled:pointer-events-none disabled:opacity-55 aria-disabled:opacity-50 aria-disabled:cursor-progress',
    focusRing,
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

// A round control that shows only an icon. Its accessible name is its
// aria-label, which callers always give.
export function iconButtonClass(tone: 'default' | 'danger' = 'default', className?: string) {
  return cn(
    'inline-grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border border-transparent bg-transparent text-ink-3',
    'transition-colors duration-200 aria-disabled:opacity-50 aria-disabled:cursor-progress pointer-coarse:size-11',
    tone === 'danger' ? 'hover:bg-destructive/10 hover:text-destructive' : 'hover:bg-ink/[0.06] hover:text-ink',
    focusRing,
    className,
  );
}

// Light fields lift off glass with a near-opaque fill and soft depth. Only
// focus and errors draw a coloured border. A locked (read-only) field dims.
export const controlClass = cn(
  'min-h-11 rounded-full border border-transparent bg-[rgba(var(--surface-rgb),0.96)] px-4 py-2 text-[15px] text-ink',
  'shadow-[var(--tk-control-shadow)] transition-[background-color,border-color,box-shadow] duration-200',
  'placeholder:text-ink-3 hover:bg-frost focus:border-accent focus:shadow-[var(--tk-focus-shadow)] focus:outline-none',
  'aria-[invalid=true]:border-destructive read-only:opacity-60',
);
// The same field, one step denser, for rows and Manage lists.
export const smallControlClass = cn(controlClass, 'min-h-10 px-3.5 text-[14px]');
export const selectClass = 'cursor-pointer appearance-none bg-no-repeat pr-9 tk-select';
export const textareaClass = 'rounded-2xl leading-relaxed resize-y';

export const labelClass = 'block text-[13px] font-medium text-ink-2';

// The text of a field's error, below it.
export function FieldError({ id, children, className }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <p id={id} role="alert" className={cn('m-0 text-[13px] font-medium text-destructive', className)}>
      {children}
    </p>
  );
}

export function Button({
  variant,
  size,
  className,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button className={buttonClass(variant, size, className)} type={type} {...rest} />;
}

// Glass, for chrome and short content over the mesh.
export const panelClass = 'theme-glass rounded-[26px] p-4 sm:rounded-[30px] sm:p-5';
// A near-opaque sheet, for the task lists.
export const sheetClass =
  'overflow-hidden rounded-[22px] bg-[var(--tk-sheet-bg)] shadow-[var(--tk-sheet-shadow)] backdrop-blur-md';

export const menuClass =
  'rounded-[18px] border border-frost/80 bg-[var(--tk-menu-bg)] p-1.5 shadow-[var(--tk-menu-shadow)] backdrop-blur-xl backdrop-saturate-150';
export const menuItemClass = cn(
  'flex w-full cursor-pointer items-center gap-2.5 rounded-xl border-0 bg-transparent px-3 py-2.5 text-left font-[inherit] text-[13px] text-ink transition-colors hover:bg-ink/5',
  focusRing,
);
