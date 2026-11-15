import { useCallback, useEffect, useLayoutEffect, useState } from 'react';

interface TurnEntry {
  id: string;
  title: string;
  excerpt: string;
}

interface TurnMinimapProps {
  scroller: React.RefObject<HTMLDivElement | null>;
  turns: TurnEntry[];
  /** Bump to recompute after items render. */
  version: number;
}

/**
 * A quiet tick rail on the right edge of the transcript: one dash per turn,
 * vertically centred. Hovering shows the question and an excerpt of the answer;
 * clicking scrolls that turn into view.
 */
export function TurnMinimap({ scroller, turns, version }: TurnMinimapProps) {
  const [height, setHeight] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);

  const measure = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    setHeight(node.clientHeight);
  }, [scroller]);

  useLayoutEffect(() => {
    measure();
    const node = scroller.current;
    if (!node) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure, version, scroller]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => measure());
    return () => cancelAnimationFrame(frame);
  }, [measure, version]);

  const jump = (id: string): void => {
    const node = scroller.current;
    if (!node) return;
    const element = node.querySelector<HTMLElement>(`[data-turn="${id}"]`);
    if (!element) return;
    const offset = element.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop;
    node.scrollTo({ top: Math.max(0, offset - 8), behavior: 'smooth' });
  };

  if (turns.length < 2) return null;

  const available = Math.max(0, height - 24);
  const pitch = Math.min(9, Math.max(3, available / Math.max(1, turns.length)));
  const block = Math.max(0, (turns.length - 1) * pitch);
  const offset = Math.max(0, Math.round((available - block) / 2));

  return (
    <div className="minimap" aria-label="对话导航">
      {turns.map((turn, index) => {
        const active = index === turns.length - 1;
        const open = hovered === turn.id;
        return (
          <div key={turn.id} className="minimap-slot" style={{ top: offset + Math.round(index * pitch) }}>
            <button
              type="button"
              className={`minimap-stripe ${active ? 'active' : ''} ${open ? 'hovered' : ''}`}
              aria-label={`跳到：${turn.title.slice(0, 40)}`}
              onMouseEnter={() => setHovered(turn.id)}
              onMouseLeave={() => setHovered((value) => (value === turn.id ? null : value))}
              onFocus={() => setHovered(turn.id)}
              onBlur={() => setHovered((value) => (value === turn.id ? null : value))}
              onClick={() => jump(turn.id)}
            />
            {open ? (
              <div className="minimap-tip" role="tooltip">
                <strong>{turn.title || '（空消息）'}</strong>
                {turn.excerpt ? <p>{turn.excerpt}</p> : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
