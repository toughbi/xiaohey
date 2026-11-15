import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface CopyButtonProps {
  text: string;
  label?: string;
  className?: string;
}

/** Small clipboard affordance used on messages, tool output and code blocks. */
export function CopyButton({ text, label = '复制', className = '' }: CopyButtonProps) {
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
      {done ? <Check size={12} strokeWidth={2.2} /> : <Copy size={12} strokeWidth={1.7} />}
    </button>
  );
}
