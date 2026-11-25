// The Tasks mark: three list lines in the theme's accent tones, sealed with
// an ink tick. Built from the same primitives as the Cookbook and
// finance marks - three accents around an ink anchor - so the Pior Labs apps
// read as siblings, while the form belongs to a list.
export function BrandMark({ size = 34, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <rect x="3" y="4" width="22" height="5.5" rx="2.75" fill="var(--tk-mark-1)" />
      <rect x="3" y="12.5" width="16" height="5.5" rx="2.75" fill="var(--tk-mark-2)" />
      <rect x="3" y="21" width="11" height="5.5" rx="2.75" fill="var(--tk-mark-3)" />
      {/* The ink seal: a ticked circle over the end of the list. */}
      <circle cx="23" cy="22.5" r="7.5" fill="var(--tk-mark-ink)" stroke="var(--cream)" strokeWidth="1.5" />
      <path
        d="M19.8 22.6L22.1 24.9L26.4 20.2"
        stroke="var(--cream)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Mark plus wordmark, for the rail, the phone bar and the sign-in screen.
export function Wordmark({ size = 32, textClass = 'text-[22px]' }: { size?: number; textClass?: string }) {
  return (
    <>
      <BrandMark size={size} />
      <span className={`font-serif ${textClass} font-medium italic tracking-tight`}>Tasks</span>
    </>
  );
}
