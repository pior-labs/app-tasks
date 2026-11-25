import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Check, ChevronsUpDown, LogOut } from 'lucide-react';
import { useTheme } from '@pior-labs/design-system';
import { Wordmark } from './BrandMark';
import { cn } from './cn';
import { focusRing, menuClass, menuItemClass } from './ui';

export type Account = { name: string; email: string };

// The design system's drifting mesh and grain, the ambient layer every screen
// sits on. Fixed and inert: blobs at z-index 0, grain at 1, so content that
// wants to be above them takes 2.
export function MeshBackdrop() {
  return (
    <>
      <div className="theme-mesh" aria-hidden="true">
        <div className="theme-blob b1" />
        <div className="theme-blob b2" />
        <div className="theme-blob b3" />
        <div className="theme-blob b4" />
        <div className="theme-blob b5" />
      </div>
      <div className="theme-grain" aria-hidden="true" />
    </>
  );
}

// The theme choices, as radio items of the account menu: a live swatch, the
// name and hint, and a check on the active one.
export function ThemeSwitcher({ role = 'menuitemradio' }: { role?: 'menuitemradio' | 'radio' }) {
  const { theme, setTheme, themes } = useTheme();
  return (
    <div role={role === 'radio' ? 'radiogroup' : 'group'} aria-label="Theme">
      <div aria-hidden="true" className="px-3 pt-1.5 pb-1 font-serif text-[11px] tracking-wide text-ink-2 italic">Theme</div>
      <div className="flex flex-col gap-0.5">
        {themes.map((option) => {
          const active = option.id === theme;
          return (
            <button
              key={option.id}
              type="button"
              role={role}
              aria-checked={active}
              onClick={() => setTheme(option.id)}
              className={cn(menuItemClass, 'py-2', active ? 'bg-ink/5' : '')}
            >
              <span
                aria-hidden="true"
                className="flex size-5 shrink-0 items-center justify-center rounded-full shadow-[inset_0_0_0_1px_rgba(var(--frost-rgb),0.5)]"
                style={{ background: option.swatch[0] }}
              >
                <span className="flex size-2.5 overflow-hidden rounded-full">
                  <span className="h-full w-1/2" style={{ background: option.swatch[1] }} />
                  <span className="h-full w-1/2" style={{ background: option.swatch[2] }} />
                </span>
              </span>
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate text-[13px] text-ink">{option.name}</span>
                <span className="truncate text-[11px] text-ink-2">{option.hint}</span>
              </span>
              {active && <Check aria-hidden="true" className="size-3.5 shrink-0 text-accent" strokeWidth={2.5} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Who is signed in, behind one control: the theme and Sign out live in its
// menu. Escape or a click elsewhere closes the menu, and Escape hands focus
// back to the control that opened it.
function AccountMenu({ account, signingOut, onSignOut }: { account: Account; signingOut: boolean; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (holder.current && !holder.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={holder} className="relative min-w-0">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-label={`${account.name}, account`}
        aria-expanded={open}
        aria-controls={open ? 'account-menu' : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-2xl border-0 bg-transparent p-1.5 text-left font-[inherit] transition-colors hover:bg-frost/50 md:p-2',
          open ? 'bg-frost/70' : '',
          focusRing,
        )}
      >
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full font-serif text-[15px] text-ink shadow-[inset_0_0_0_1px_rgba(var(--frost-rgb),0.6)]"
          style={{ background: 'var(--tk-avatar-bg)' }}
        >
          {account.name.trim()[0]?.toUpperCase() ?? '?'}
        </span>
        <span className="hidden min-w-0 flex-1 flex-col leading-[1.15] md:flex">
          <span className="truncate font-serif text-[15px] text-ink">{account.name}</span>
          <span className="truncate text-[11px] text-ink-2">Account</span>
        </span>
        <ChevronsUpDown aria-hidden="true" className="hidden size-3.5 shrink-0 text-ink-3 md:block" />
      </button>
      {open && (
        <div
          id="account-menu"
          role="menu"
          aria-label="Account"
          className={cn(
            menuClass,
            'absolute right-0 z-40 mt-2 w-64 md:right-auto md:bottom-full md:left-0 md:mt-0 md:mb-2 md:w-full md:min-w-56',
          )}
        >
          <div className="border-b border-dashed border-ink/10 px-3 pt-2 pb-2.5">
            <p className="m-0 truncate text-[13px] text-ink">Signed in as {account.name}</p>
            <p className="m-0 truncate text-[11px] text-ink-2">{account.email}</p>
          </div>
          <div className="pt-1">
            <ThemeSwitcher />
          </div>
          <div className="my-1 border-t border-dashed border-ink/10" />
          <button
            type="button"
            role="menuitem"
            aria-disabled={signingOut || undefined}
            onClick={() => {
              if (signingOut) return;
              setOpen(false);
              onSignOut();
            }}
            className={menuItemClass}
          >
            <LogOut aria-hidden="true" className="size-3.5 text-ink-2" strokeWidth={2.2} />
            {signingOut ? 'Signing out...' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  );
}

// The frame every signed-in screen shares. On a wide screen the rail is a
// sticky glass card beside the content, holding the mark, the views and lists
// (`nav`), and the account; on a phone the same rail is a bar above the
// content with the tabs in a sideways row. It is one element either way, so
// each control exists once and keyboard order follows what is seen.
export function AppShell({
  account,
  signingOut,
  onSignOut,
  nav,
  children,
}: {
  account: Account;
  signingOut: boolean;
  onSignOut: () => void;
  nav?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="relative min-h-dvh text-[15px] leading-[1.55] text-ink">
      <MeshBackdrop />
      <a
        href="#main-content"
        className={cn(
          'absolute top-3 left-3 z-50 -translate-y-24 rounded-full border border-ink/15 bg-cream px-4 py-2.5 text-sm font-medium text-ink transition-transform focus:translate-y-0',
          focusRing,
        )}
      >
        Skip to tasks
      </a>
      <div className="relative z-2 mx-auto grid max-w-300 grid-cols-[minmax(0,1fr)] gap-4 px-3 pt-3 pb-12 sm:px-5 md:grid-cols-[248px_minmax(0,1fr)] md:gap-7 md:px-8 md:pt-6 md:pb-16">
        <aside
          aria-label="Tasks"
          // On a phone the rail wraps: the mark, then the tab row, then the
          // list actions with the account at the end of the same row. `nav`
          // takes part in that wrap directly (display: contents), so its
          // parts size themselves with basis-full or flex-1.
          className={cn(
            'relative z-20 flex min-w-0 flex-wrap items-center gap-2 rounded-[26px] border border-frost/80 bg-[rgba(var(--surface-rgb),0.6)] p-3',
            'shadow-[0_8px_32px_color-mix(in_srgb,var(--ink)_8%,transparent),inset_0_0_0_1px_rgba(var(--frost-rgb),0.5)] backdrop-blur-xl backdrop-saturate-150',
            'md:sticky md:top-6 md:max-h-[calc(100dvh-3rem)] md:flex-col md:flex-nowrap md:items-stretch md:self-start md:rounded-4xl md:px-4 md:pt-5 md:pb-4',
          )}
        >
          <p className="m-0 flex basis-full items-center gap-2.5 px-1.5 md:mb-1 md:basis-auto md:border-b md:border-dashed md:border-ink/10 md:px-2 md:pb-3.5">
            <Wordmark size={30} textClass="text-[21px]" />
          </p>
          <div className="contents md:-mx-1 md:flex md:min-h-0 md:flex-1 md:flex-col md:gap-2 md:overflow-y-auto md:px-1 md:py-1">
            {nav}
          </div>
          <div className="ml-auto md:mt-1 md:ml-0 md:border-t md:border-dashed md:border-ink/10 md:pt-3">
            <AccountMenu account={account} signingOut={signingOut} onSignOut={onSignOut} />
          </div>
        </aside>
        <main id="main-content" tabIndex={-1} className="flex min-w-0 flex-col gap-5 focus:outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}
