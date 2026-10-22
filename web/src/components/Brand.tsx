/** The orrery mark: three bodies on two orbits. Spins once while loading. */
export function BrandMark({ size = 22, spinning = false }: { size?: number; spinning?: boolean }) {
  return (
    <svg className={`brand-mark ${spinning ? 'spinning' : ''}`} width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <circle cx="16" cy="16" r="12" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1" />
      <circle cx="16" cy="16" r="6.5" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1" />
      <circle cx="16" cy="16" r="2.4" fill="var(--pulse)" />
      <g className="orbit-outer">
        <circle cx="28" cy="16" r="1.9" fill="var(--cat-database)" />
      </g>
      <g className="orbit-inner">
        <circle cx="11.4" cy="11.4" r="1.7" fill="var(--cat-compute)" />
        <circle cx="19" cy="21.5" r="1.4" fill="var(--cat-integration)" />
      </g>
    </svg>
  );
}
