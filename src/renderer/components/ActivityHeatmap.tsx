import { useMemo } from 'react';
import type { ActivityDay, ActivityResult } from '../../shared/types';

interface ActivityHeatmapProps {
  days: ActivityDay[];
  weeks: number;
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function level(count: number): number {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}

/**
 * Contribution-style activity grid: one column per week, one cell per day,
 * shading by messages + tool calls that day. Weeks start on Monday.
 */
export function ActivityHeatmap({ days, weeks }: ActivityHeatmapProps) {
  const columns = useMemo(() => {
    const counts = new Map(days.map((day) => [day.date, day.count]));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - (weeks * 7 - 1));
    // back up to the Monday of that week so rows read Mon..Sun
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));

    const result: Array<{ key: string; label: string; cells: Array<{ date: string; count: number; future: boolean }> }> = [];
    const cursor = new Date(start);
    let lastMonth = -1;
    while (cursor <= today) {
      const cells: Array<{ date: string; count: number; future: boolean }> = [];
      let label = '';
      for (let index = 0; index < 7; index += 1) {
        const date = new Date(cursor);
        const future = date > today;
        if (!future && date.getMonth() !== lastMonth) {
          lastMonth = date.getMonth();
          if (result.length > 0) label = `${date.getMonth() + 1}月`;
        }
        cells.push({ date: dayKey(date), count: counts.get(dayKey(date)) ?? 0, future });
        cursor.setDate(cursor.getDate() + 1);
      }
      result.push({ key: cells[0].date, label, cells });
    }
    return result;
  }, [days, weeks]);

  return (
    <div className="heatmap" role="img" aria-label="每日使用频率">
      <div className="hm-grid">
        {columns.map((column) => (
          <div key={column.key} className="hm-col">
            {column.cells.map((cell) => (
              <span
                key={cell.date}
                className={`hm-cell l${level(cell.count)}${cell.future ? ' future' : ''}`}
                title={cell.future ? '' : `${cell.date} · ${cell.count} 次`}
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
    </div>
  );
}

/** The card as it appears on the empty session and in Usage settings. */
export function ActivityCard({ activity }: { activity: ActivityResult | null }) {
  return (
    <div className="heatmap-card">
      <div className="hm-head">
        <span className="hm-title">会话</span>
      </div>
      {activity ? <ActivityHeatmap days={activity.days} weeks={activity.weeks} /> : null}
    </div>
  );
}
