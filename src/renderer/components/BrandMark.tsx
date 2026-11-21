import { useEffect, useRef, useState } from 'react';

export type BrandExpression = 'idle' | 'happy' | 'blink' | 'surprised' | 'wink' | 'sleepy';

interface BrandMarkProps {
  size?: number;
  className?: string;
  /** Force an expression; omit to let hover/blink drive it. */
  expression?: BrandExpression;
  /** Set false for static marks (favicon previews, docs). */
  interactive?: boolean;
  title?: string;
}

/**
 * The mark is a black tile with two eyes: a vertical bar and a `<` chevron.
 * Hover widens the bar and nudges the chevron, pressing dips the glyph, and
 * the chevron blinks on its own at random intervals when the mark is left alone.
 */
export function BrandMark({ size = 20, className = '', expression, interactive = true, title = 'xiaohey' }: BrandMarkProps) {
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [blink, setBlink] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!interactive || expression) return;
    // Uneven beats: a quick double-take now and then, a longer pause later.
    const pause = (): number => {
      const roll = Math.random();
      if (roll < 0.35) return 1800 + Math.random() * 1400;
      if (roll < 0.8) return 3200 + Math.random() * 3300;
      return 6500 + Math.random() * 5500;
    };
    const schedule = (): void => {
      timer.current = window.setTimeout(() => {
        setBlink(true);
        window.setTimeout(() => setBlink(false), 360 + Math.random() * 320);
        schedule();
      }, pause());
    };
    schedule();
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [interactive, expression]);

  const current: BrandExpression =
    expression ?? (pressed ? 'surprised' : hover ? 'happy' : blink ? 'blink' : 'idle');

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      className={`brand-mark brand-mark-${current} ${className}`.trim()}
      data-expression={current}
      role="img"
      aria-label={title}
      onPointerEnter={interactive ? () => setHover(true) : undefined}
      onPointerLeave={
        interactive
          ? () => {
              setHover(false);
              setPressed(false);
            }
          : undefined
      }
      onPointerDown={interactive ? () => setPressed(true) : undefined}
      onPointerUp={interactive ? () => setPressed(false) : undefined}
    >
      <title>{title}</title>
      <defs>
        <linearGradient id="mark-tile" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--mark-tile-top)" />
          <stop offset="0.45" stopColor="var(--mark-tile-mid)" />
          <stop offset="1" stopColor="var(--mark-tile-bottom)" />
        </linearGradient>
      </defs>
      <g className="brand-mark-body">
        <rect width="512" height="512" rx="104" fill="url(#mark-tile)" />
        <rect x="1.5" y="1.5" width="509" height="509" rx="103" fill="none" stroke="var(--mark-rim)" strokeWidth="3" />
        <g className="brand-prompt">
          <path
            className="brand-chevron"
            d="M351 200 L257 256 L351 312"
            fill="none"
            stroke="var(--mark-ink)"
            strokeWidth="48"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <rect className="brand-cursor" x="137" y="176" width="48" height="160" rx="24" fill="var(--mark-ink)" />
        </g>
      </g>
    </svg>
  );
}
