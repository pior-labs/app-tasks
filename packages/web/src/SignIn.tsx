import { ArrowRight, LoaderCircle } from 'lucide-react';
import { Wordmark } from './BrandMark';
import { MeshBackdrop, ThemeSwitcher } from './AppShell';
import { cn } from './cn';
import { focusRing } from './ui';

// The signed-out screen, after the finance tracker's: the mark and a headline
// on one side, and a glass card with the one action on the other. The theme is
// a household preference, so it is offered before signing in too.
export function SignIn({
  loading,
  busy,
  error,
  onSignIn,
}: {
  // The session is still being restored: the card says so instead of offering
  // a sign-in that may not be needed.
  loading: boolean;
  busy: boolean;
  error: string;
  onSignIn: () => void;
}) {
  return (
    <div className="relative min-h-dvh overflow-hidden text-ink">
      <MeshBackdrop />
      <main className="relative z-2 mx-auto grid min-h-dvh w-full max-w-300 grid-cols-1 content-center gap-10 px-5 py-10 md:grid-cols-[1.1fr_1fr] md:gap-16 md:px-12 lg:px-16">
        <section aria-labelledby="sign-in-heading" className="theme-overlay-anim flex flex-col gap-8">
          <p className="m-0 flex items-center gap-3">
            <Wordmark size={36} textClass="text-[24px]" />
          </p>
          <div>
            <p className="m-0 font-mono text-[11px] font-semibold tracking-[0.18em] text-ink-3 uppercase">Pior Labs</p>
            <h1
              id="sign-in-heading"
              className="mt-3 mb-0 font-serif text-[clamp(44px,7.5vw,80px)] leading-[0.98] font-normal tracking-[-0.03em] text-ink"
            >
              Tasks
              <span className="text-accent">.</span>
            </h1>
            <p className="mt-6 mb-0 max-w-md text-[17px] leading-[1.6] text-ink-2">
              A little space for what comes next.
            </p>
          </div>
        </section>
        <section
          aria-label="Sign in"
          className="theme-overlay-anim flex w-full items-center justify-center md:justify-end"
          style={{ animationDelay: '120ms' }}
        >
          <div className="theme-glass w-full max-w-96 rounded-[28px] p-7 sm:p-9">
            {loading ? (
              <p role="status" className="m-0 flex items-center gap-2.5 text-[15px] text-ink-2">
                <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
                Loading your session...
              </p>
            ) : (
              <div className="flex flex-col gap-5">
                <div>
                  <p className="m-0 font-serif text-[11px] tracking-[0.24em] text-ink-2 uppercase">Single sign-on</p>
                  <h2 className="mt-2.5 mb-0 font-serif text-[26px] leading-[1.05] font-normal tracking-tight">
                    Sign <span className="text-accent italic">in</span>
                  </h2>
                </div>
                <p className="m-0 text-[15px] leading-[1.6] text-ink-2">
                  Tasks uses your Pior Labs account. You sign in there, then land right back here.
                </p>
                {error && (
                  <p
                    id="sign-in-error"
                    role="alert"
                    className="m-0 rounded-2xl border border-[var(--tk-danger-border)] bg-[var(--tk-danger-surface)] px-3.5 py-2.5 text-[13px] text-[var(--tk-danger-ink-strong)]"
                  >
                    {error}
                  </p>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={onSignIn}
                  aria-describedby={error ? 'sign-in-error' : undefined}
                  className={cn(
                    'group inline-flex min-h-12 w-full cursor-pointer items-center justify-center gap-2.5 rounded-full border border-ink/15 bg-ink px-6 py-3 text-[15px] font-medium text-cream',
                    'shadow-[var(--tk-action-shadow)] transition-[box-shadow,background-color] duration-300 ease-out hover:bg-[var(--tk-action-hover-bg)] hover:shadow-[var(--tk-action-shadow-hover)]',
                    'disabled:cursor-progress disabled:opacity-80',
                    focusRing,
                  )}
                >
                  {busy ? 'Please wait...' : 'Sign in with Pior Labs'}
                  {busy ? (
                    <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <ArrowRight
                      aria-hidden="true"
                      className="size-4 transition-transform duration-300 group-hover:translate-x-0.5 motion-reduce:transition-none"
                    />
                  )}
                </button>
                <div className="border-t border-dashed border-ink/10 pt-3">
                  <ThemeSwitcher role="radio" />
                </div>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
