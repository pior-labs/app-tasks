import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Check, LogOut } from 'lucide-react';
import { useTheme } from '@pior-labs/design-system';
import { cn } from './cn';
import { focusRing, menuClass, menuItemClass } from './ui';

export type Account = { name: string; email: string };

// The page behind a modal, which is inert while the modal is open: the add
// sheet repeats the messages posted in it then (see AddSheet.tsx).
export const PAGE_ID = 'page';

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

// Who is signed in, behind one round avatar at the top right: the theme and
// Sign out live in its menu. Escape or a click elsewhere closes the menu, and
// Escape hands focus back to the avatar.
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
    <div ref={holder} className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-label={`${account.name}, account`}
        aria-expanded={open}
        aria-controls={open ? 'account-menu' : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'grid size-10 cursor-pointer place-items-center rounded-full border-0 font-serif text-[16px] text-ink shadow-[inset_0_0_0_1px_rgba(var(--frost-rgb),0.6)] transition-[filter] hover:brightness-95 pointer-coarse:size-11',
          focusRing,
        )}
        style={{ background: 'var(--tk-avatar-bg)' }}
      >
        <span aria-hidden="true">{account.name.trim()[0]?.toUpperCase() ?? '?'}</span>
      </button>
      {open && (
        <div
          id="account-menu"
          role="menu"
          aria-label="Account"
          className={cn(menuClass, 'tk-pop absolute top-full right-0 z-40 mt-2 w-64 max-w-[calc(100vw-2.5rem)]')}
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

// The frame every signed-in screen shares: one calm column, about 36rem wide,
// over the mesh. The header holds the view title with its picker (`title`)
// and the account avatar; the column below is the main content. `overlay`
// (the + button and the add sheet) sits outside the column, and while a modal
// is open (`inert`) the column cannot be reached at all.
export function AppShell({
  account,
  signingOut,
  onSignOut,
  title,
  inert = false,
  overlay,
  children,
}: {
  account: Account;
  signingOut: boolean;
  onSignOut: () => void;
  title?: ReactNode;
  inert?: boolean;
  overlay?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="relative min-h-dvh text-[15px] leading-[1.55] text-ink">
      <MeshBackdrop />
      <div id={PAGE_ID} inert={inert} className="relative z-2">
        <a
          href="#main-content"
          className={cn(
            'absolute top-3 left-3 z-50 -translate-y-24 rounded-full border border-ink/15 bg-cream px-4 py-2.5 text-sm font-medium text-ink transition-transform focus:translate-y-0 motion-reduce:transition-none',
            focusRing,
          )}
        >
          Skip to tasks
        </a>
        {/* Bottom padding leaves room to scroll the last task clear of the + button. */}
        <div className="mx-auto flex max-w-xl flex-col gap-6 px-5 pt-10 pb-36 sm:pt-16">
          <header className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">{title}</div>
            <AccountMenu account={account} signingOut={signingOut} onSignOut={onSignOut} />
          </header>
          <main id="main-content" tabIndex={-1} className="flex min-w-0 flex-col gap-4 focus:outline-none">
            {children}
          </main>
        </div>
      </div>
      {overlay}
    </div>
  );
}
