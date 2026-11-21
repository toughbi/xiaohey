import { useEffect, useRef, useState } from 'react';

interface CopyButtonProps {
  text: string;
  label?: string;
  className?: string;
  /** Rendered size in px. The glyph is drawn on a 16px grid, so 1 unit = 1px
   *  at size 16 and the 1.5 stroke stays crisp instead of thinning out. */
  size?: number;
}

/** Two sheets offset by a corner: the copy mark, drawn on a 16px grid so it
 *  keeps its 1.5px stroke weight at small sizes (a 24px-grid lucide icon at
 *  12px halves every stroke and turns the back sheet into a stray tick). */
function CopyMark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="6.4" y="6.4" width="8" height="8" rx="2" />
      <path d="M4.9 11.4H4.4a1.9 1.9 0 0 1-1.9-1.9V4.4a1.9 1.9 0 0 1 1.9-1.9h5.1a1.9 1.9 0 0 1 1.9 1.9" />
    </svg>
  );
}

function CheckMark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.2 8.6 6.4 11.6 12.8 4.4" />
    </svg>
  );
}

/** Small clipboard affordance used on messages, tool output and code blocks. */
export function CopyButton({ text, label = '复制', className = '', size = 16 }: CopyButtonProps) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  return (
    <button
      type="button"
      className={`copy-btn ${done ? 'done' : ''} ${className}`.trim()}
      title={done ? '已复制' : label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true);
            if (timer.current !== null) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setDone(false), 1400);
          })
          .catch(() => undefined);
      }}
    >
      {done ? <CheckMark size={size} /> : <CopyMark size={size} />}
    </button>
  );
}
