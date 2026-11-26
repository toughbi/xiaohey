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
 * vertically centred. The dash of the turn being read stays long and follows
 * the scroll; hovering stretches one dash and shows the question plus an
 * excerpt of the answer; clicking scrolls that turn into view.
 */
export function TurnMinimap({ scroller, turns, version }: TurnMinimapProps) {
  const [height, setHeight] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);

  const measure = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    // The viewport runs under the floating dock; the rail belongs to the part
    // that is actually visible, so subtract the dock's height (`--dock-h`).
    const reserved = Number.parseFloat(getComputedStyle(node).getPropertyValue('--dock-h')) || 0;
    setHeight(Math.max(0, node.clientHeight - reserved));
  }, [scroller]);

  useLayoutEffect(() => {
    measure();
    const node = scroller.current;
    if (!node) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(node);
    const dock = node.parentElement?.querySelector('.composer-dock');
    if (dock) observer.observe(dock);
    return () => observer.disconnect();
  }, [measure, version, scroller]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => measure());
    return () => cancelAnimationFrame(frame);
  }, [measure, version]);

  // The long dash marks the turn currently being read, not always the last one.
  useEffect(() => {
    const node = scroller.current;
    if (!node || turns.length === 0) return;
    const known = new Set(turns.map((turn) => turn.id));
    const first = turns[0].id;
    const last = turns[turns.length - 1].id;
    let frame = 0;

    const read = (): void => {
      // Everything fits, or the reader is parked at the newest turn.
      if (node.scrollHeight - node.scrollTop - node.clientHeight < 24) {
        setReading(last);
        return;
      }
      // The turn covering the upper third of the viewport is the one being read.
      const line = node.getBoundingClientRect().top + node.clientHeight * 0.34;
      let current = first;
      for (const element of node.querySelectorAll<HTMLElement>('[data-turn]')) {
        if (element.getBoundingClientRect().top > line) break;
        const id = element.dataset.turn;
        if (id && known.has(id)) current = id;
      }
      setReading(current);
    };

    const schedule = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    };

    read();
    node.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => {
      cancelAnimationFrame(frame);
      node.removeEventListener('scroll', schedule);
      observer.disconnect();
    };
  }, [scroller, turns]);

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
  const activeId = reading ?? turns[turns.length - 1].id;

  return (
    <div className="minimap" aria-label="对话导航">
      {turns.map((turn, index) => {
        const active = turn.id === activeId;
        const open = hovered === turn.id;
        return (
          <div
            key={turn.id}
            className="minimap-slot"
            style={{ top: offset + Math.round(index * pitch) }}
            onMouseEnter={() => setHovered(turn.id)}
            onMouseLeave={() => setHovered((value) => (value === turn.id ? null : value))}
            onClick={() => jump(turn.id)}
          >
            <button
              type="button"
              className={`minimap-stripe ${active ? 'active' : ''} ${open ? 'hovered' : ''}`}
              aria-label={`跳到：${turn.title.slice(0, 40)}`}
              aria-current={active ? 'location' : undefined}
              onFocus={() => setHovered(turn.id)}
              onBlur={() => setHovered((value) => (value === turn.id ? null : value))}
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
