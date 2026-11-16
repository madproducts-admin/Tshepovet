/**
 * The TshepoVet seal: a guilloche rosette, the engraved line-work of banknotes and passports.
 * The one decorative element of the design system: it marks the brand, a verified passport,
 * and (as a wave band) the sandbox specimen. Generated here, on the server, as plain SVG
 * paths: no images, no client JavaScript.
 */
type Pt = [number, number];

const round = (n: number) => Math.round(n * 100) / 100;

function path(points: Pt[]): string {
  return `M${points.map(([x, y]) => `${round(x)} ${round(y)}`).join('L')}Z`;
}

function sample(steps: number, period: number, fn: (t: number) => Pt): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < steps; i++) out.push(fn((i / steps) * period));
  return out;
}

/** A hypotrochoid (spirograph) centred on (c, c): the rosette's heart. */
function hypotrochoid(c: number, R: number, r: number, d: number, steps = 720): string {
  const k = (R - r) / r;
  return path(sample(steps, 2 * Math.PI * r, (t) => [c + (R - r) * Math.cos(t / r) + d * Math.cos(k * (t / r)), c + (R - r) * Math.sin(t / r) - d * Math.sin(k * (t / r))]));
}

/** A wave wrapped round a circle: the engraved border rings. */
function waveRing(c: number, radius: number, amp: number, lobes: number, phase: number, steps = 540): string {
  return path(sample(steps, 2 * Math.PI, (t) => {
    const r = radius + amp * Math.sin(lobes * t + phase);
    return [c + r * Math.cos(t), c + r * Math.sin(t)];
  }));
}

const C = 100;
const RINGS = [0, 1, 2, 3].map((i) => waveRing(C, 86 - i * 1.6, 5.5, 36, (i * Math.PI) / 4));
const INNER = [0, 1, 2].map((i) => waveRing(C, 60 - i * 1.4, 3.2, 24, (i * Math.PI) / 3 + Math.PI / 6));
const HEART = [hypotrochoid(C, 50, 15, 30), hypotrochoid(C, 50, 15, 22)];

/** At icon sizes hairlines vanish: a heavier, simpler cut of the same engraving. */
const SMALL_RINGS = [0, 1].map((i) => waveRing(C, 78 - i * 16, 9, 14, (i * Math.PI) / 2, 240));

export function Seal({ size = 40, label, verified = false, className }: { size?: number; label?: string; verified?: boolean; className?: string }) {
  if (size <= 56) {
    return (
      <svg viewBox="0 0 200 200" width={size} height={size} className={className} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} focusable="false">
        <circle cx={C} cy={C} r={94} fill="none" stroke="var(--seal-1)" strokeWidth={10} />
        <path d={SMALL_RINGS[0]} fill="none" stroke="var(--seal-1)" strokeWidth={7} strokeLinejoin="round" />
        <path d={SMALL_RINGS[1]} fill="none" stroke="var(--seal-2)" strokeWidth={7} strokeLinejoin="round" />
        {verified ? (
          <path d="M72 102 L92 122 L130 80" fill="none" stroke="var(--seal-1)" strokeWidth={16} strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <circle cx={C} cy={C} r={20} fill="var(--seal-1)" />
        )}
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 200 200"
      width={size}
      height={size}
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <circle cx={C} cy={C} r={97} fill="none" stroke="var(--seal-1)" strokeWidth={2} />
      <g fill="none" stroke="var(--seal-1)" strokeWidth={0.7} strokeLinejoin="round">
        {RINGS.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
      <g fill="none" stroke="var(--seal-2)" strokeWidth={0.7} strokeLinejoin="round">
        {INNER.map((d, i) => (
          <path key={i} d={d} />
        ))}
        {HEART.map((d, i) => (
          <path key={i} d={d} opacity={i ? 0.7 : 1} />
        ))}
      </g>
      {verified ? (
        <path d="M78 101 L94 117 L124 84" fill="none" stroke="var(--seal-1)" strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <circle cx={C} cy={C} r={6} fill="var(--seal-1)" />
      )}
    </svg>
  );
}

/** Engraved waves across a strip (the specimen band's pattern). */
export function GuillocheBand({ width = 480, height = 40, className }: { width?: number; height?: number; className?: string }) {
  const lines = [0, 1, 2, 3, 4, 5].map((i) =>
    sample(240, width, (x) => [x, height / 2 + (height / 2.6) * Math.sin(x / 18 + i * 0.55) * Math.cos(x / 61 + i * 0.3)]),
  );
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={className} aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth={0.6}>
        {lines.map((pts, i) => (
          <path key={i} d={`M${pts.map(([x, y]) => `${round(x)} ${round(y)}`).join('L')}`} />
        ))}
      </g>
    </svg>
  );
}
