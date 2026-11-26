import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ContextGauge, ContextPartId } from '../../shared/types';

/**
 * The context chip under the composer: a ring and a percentage that open into
 * the breakdown of what that percentage is made of. The numbers come from the
 * live assembly when a turn is running and from a prefix estimate otherwise, so
 * the bar always adds up to the same total the chip prints.
 */

const LABEL: Record<ContextPartId, string> = {
  system: '系统提示词',
  tools: '工具定义',
  memory: '长期记忆',
  history: '历史对话',
  working: '本轮工作',
};

const ORDER: ContextPartId[] = ['system', 'tools', 'memory', 'history', 'working'];

/** 441_000 -> "~441K", 1_048_576 -> "1.0M". */
function compact(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}K`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(tokens);
}

function ContextRing({ percent }: { percent: number }) {
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg width={12} height={12} viewBox="0 0 14 14" className="cm-ring" aria-hidden="true">
      <circle cx={7} cy={7} r={radius} fill="none" stroke="currentColor" strokeWidth={1.6} opacity={0.25} />
      <circle
        cx={7}
        cy={7}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeDasharray={`${(percent / 100) * circumference} ${circumference}`}
        transform="rotate(-90 7 7)"
      />
    </svg>
  );
}

export function ContextMeter({
  gauge,
  percent,
  onOpen,
}: {
  gauge: ContextGauge | null;
  percent: number;
  /** Refresh from the main process when the panel opens. */
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);

  const toggle = (): void => {
    if (!open) onOpen?.();
    setOpen((value) => !value);
  };

  // The panel is portalled: the meta row clips its children, and a breakdown
  // wider than the chip would otherwise be cut off at the panel edge.
  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    const place = (): void => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      setAnchor({
        right: Math.max(12, window.innerWidth - rect.right),
        bottom: Math.max(12, window.innerHeight - rect.top + 10),
      });
    };
    place();
    window.addEventListener('resize', place);
    // Escape closes the panel, and must not reach the turn's global Escape
    // (which cancels a running turn).
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      event.preventDefault();
      setOpen(false);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('keydown', onKey, { capture: true });
    };
  }, [open]);

  const capacity = gauge?.window ?? gauge?.tokensBudget ?? 0;
  const used = gauge?.tokensUsed ?? 0;
  const slices = (gauge?.parts ?? [])
    .filter((part) => part.tokens > 0)
    .sort((left, right) => ORDER.indexOf(left.id) - ORDER.indexOf(right.id));
  const reserved = (gauge?.outputReserve ?? 0) + (gauge?.safetyMargin ?? 0);
  const total = Math.max(capacity, used + reserved, 1);
  const share = (tokens: number): string => `${Math.max(0, Math.min(100, (tokens / total) * 100))}%`;
  const free = Math.max(0, capacity - used - reserved);

  return (
    <span className="ctx-meter">
      <button
        ref={trigger}
        type="button"
        className={`cm-item ctx-trigger${open ? ' open' : ''}`}
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="上下文已用 / 窗口大小 · 点击看构成"
      >
        <ContextRing percent={percent} />
        {percent}%
      </button>

      {open && anchor
        ? createPortal(
            <>
              <div className="policy-backdrop" onClick={() => setOpen(false)} />
              <div
                className="ctx-menu"
                role="dialog"
                aria-label="上下文构成"
                style={{ right: anchor.right, bottom: anchor.bottom }}
              >
            <div className="ctx-head">
              <span className="ctx-title">
                上下文已用 <strong>{percent}%</strong>
              </span>
              <span className="ctx-count mono">
                ~{compact(used)} / {compact(capacity)}
              </span>
            </div>

            <div className="ctx-bar" role="img" aria-label="上下文构成">
              {slices.length > 0 ? (
                slices.map((part) => (
                  <span
                    key={part.id}
                    className={`ctx-seg ctx-part-${part.id}`}
                    style={{ width: share(part.tokens) }}
                    title={`${LABEL[part.id]} ~${part.tokens}`}
                  />
                ))
              ) : (
                <span className="ctx-seg ctx-part-empty" style={{ width: share(used) }} />
              )}
              {reserved > 0 ? (
                <span className="ctx-seg ctx-part-reserved" style={{ width: share(reserved) }} title={`输出预留 + 安全边际 ~${reserved}`} />
              ) : null}
              <span className="ctx-seg ctx-part-free" style={{ width: share(free) }} title={`剩余 ~${free}`} />
            </div>

            {slices.length > 0 ? (
              <ul className="ctx-rows">
                {slices.map((part) => (
                  <li key={part.id}>
                    <span className={`ctx-swatch ctx-part-${part.id}`} aria-hidden="true" />
                    <span className="ctx-label">{LABEL[part.id]}</span>
                    <span className="ctx-value mono">~{compact(part.tokens)}</span>
                  </li>
                ))}
                {gauge && gauge.outputReserve > 0 ? (
                  <li className="ctx-quiet">
                    <span className="ctx-swatch ctx-part-reserved" aria-hidden="true" />
                    <span className="ctx-label">输出预留</span>
                    <span className="ctx-value mono">~{compact(gauge.outputReserve)}</span>
                  </li>
                ) : null}
                {gauge && gauge.safetyMargin > 0 ? (
                  <li className="ctx-quiet">
                    <span className="ctx-swatch ctx-part-reserved" aria-hidden="true" />
                    <span className="ctx-label">安全边际</span>
                    <span className="ctx-value mono">~{compact(gauge.safetyMargin)}</span>
                  </li>
                ) : null}
                <li className="ctx-quiet">
                  <span className="ctx-swatch ctx-part-free" aria-hidden="true" />
                  <span className="ctx-label">剩余</span>
                  <span className="ctx-value mono">~{compact(free)}</span>
                </li>
              </ul>
            ) : (
              <p className="ctx-note">这一轮还没有装配上下文；发送一句话之后这里会显示各部分占比。</p>
            )}

            <p className="ctx-note">
              按约 4 字符/token 估算；工具结果超过阈值会折叠成句柄，历史轮次按 L0–L3 压缩，所以数字会随轮次跳动。
            </p>
              </div>
            </>,
            document.body,
          )
        : null}
    </span>
  );
}
