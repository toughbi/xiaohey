import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ActivityDay, ActivityResult } from '../../shared/types';
import { tokens as formatTokens } from '../lib/format';

interface ActivityHeatmapProps {
  days: ActivityDay[];
  weeks: number;
}

interface Hovered {
  date: string;
  tokens: number;
  count: number;
  x: number;
  y: number;
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Token volume, not message count: five steps from quiet to saturated. */
function level(tokens: number): number {
  if (tokens <= 0) return 0;
  if (tokens <= 2_000) return 1;
  if (tokens <= 8_000) return 2;
  if (tokens <= 20_000) return 3;
  return 4;
}

/**
 * Contribution-style token grid: one column per week, one cell per day,
 * shading by prompt + completion tokens spent that day. Weeks start Monday.
 */
export function ActivityHeatmap({ days, weeks }: ActivityHeatmapProps) {
  const [hovered, setHovered] = useState<Hovered | null>(null);

  const columns = useMemo(() => {
    const byDate = new Map(days.map((day) => [day.date, day]));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - (weeks * 7 - 1));
    // back up to the Monday of that week so rows read Mon..Sun
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));

    const result: Array<{
      key: string;
      label: string;
      cells: Array<{ date: string; tokens: number; count: number; future: boolean }>;
    }> = [];
    const cursor = new Date(start);
    let lastMonth = -1;
    while (cursor <= today) {
      const cells: Array<{ date: string; tokens: number; count: number; future: boolean }> = [];
      let label = '';
      for (let index = 0; index < 7; index += 1) {
        const date = new Date(cursor);
        const future = date > today;
        if (!future && date.getMonth() !== lastMonth) {
          lastMonth = date.getMonth();
          if (result.length > 0) label = `${date.getMonth() + 1}月`;
        }
        const key = dayKey(date);
        const entry = byDate.get(key);
        cells.push({ date: key, tokens: entry?.tokens ?? 0, count: entry?.count ?? 0, future });
        cursor.setDate(cursor.getDate() + 1);
      }
      result.push({ key: cells[0].date, label, cells });
    }
    return result;
  }, [days, weeks]);

  return (
    <div className="heatmap" role="img" aria-label="每日 token 使用量">
      <div className="hm-grid">
        {columns.map((column) => (
          <div key={column.key} className="hm-col">
            {column.cells.map((cell) => (
              <span
                key={cell.date}
                className={`hm-cell l${level(cell.tokens)}${cell.future ? ' future' : ''}`}
                aria-label={cell.future ? undefined : `${cell.date}：${cell.tokens} tokens`}
                onMouseEnter={
                  cell.future
                    ? undefined
                    : (event) =>
                        setHovered({
                          date: cell.date,
                          tokens: cell.tokens,
                          count: cell.count,
                          x: event.clientX,
                          y: event.clientY,
                        })
                }
                onMouseLeave={cell.future ? undefined : () => setHovered(null)}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="hm-months" aria-hidden="true">
        {columns.map((column) => (
          <span key={column.key} className="hm-month">
            {column.label}
          </span>
        ))}
      </div>
      {hovered ? (
        <div className="hm-tip" style={{ left: hovered.x + 12, top: hovered.y - 12 }} role="tooltip">
          <strong>{hovered.date}</strong>
          <span>{hovered.tokens > 0 ? `${formatTokens(hovered.tokens)} tokens` : '没有使用'}</span>
          {hovered.count > 0 ? <span className="dim">{hovered.count} 条记录</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/** The card as it appears on the empty session and in Usage settings. */
export function ActivityCard({ activity }: { activity: ActivityResult | null }) {
  const total = useMemo(
    () => (activity ? activity.days.reduce((sum, day) => sum + day.tokens, 0) : 0),
    [activity],
  );
  return (
    <div className="heatmap-card">
      <div className="hm-head">
        <span className="hm-title">Token 使用</span>
        {activity ? <span className="hm-total mono">{formatTokens(total)}</span> : null}
      </div>
      {activity ? <ActivityHeatmap days={activity.days} weeks={activity.weeks} /> : null}
    </div>
  );
}
