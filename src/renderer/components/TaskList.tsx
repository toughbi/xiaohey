import { useState } from 'react';
import { ChevronDown, CircleCheck, ListChecks, Loader2 } from 'lucide-react';
import type { PlanStep } from '../../shared/types';

interface TaskListProps {
  steps: PlanStep[];
}

/**
 * The live task breakdown, docked right above the composer while a turn runs.
 * Hidden when the model did not split the work into steps.
 */
export function TaskList({ steps }: TaskListProps) {
  const [collapsed, setCollapsed] = useState(false);
  const visible = steps.filter((step) => step.status !== 'dropped');
  if (visible.length < 2) return null;

  const done = visible.filter((step) => step.status === 'done').length;
  const active = visible.filter((step) => step.status === 'active').length;
  const pending = visible.filter((step) => step.status === 'pending').length;
  const counts = [
    done > 0 ? `${done} 已完成` : '',
    active > 0 ? `${active} 进行中` : '',
    pending > 0 ? `${pending} 待处理` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <section className="task-panel" aria-label="任务清单">
      <button type="button" className="task-head" onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed}>
        <ListChecks size={14} strokeWidth={1.8} />
        <span className="task-name">任务</span>
        <span className="task-counts">{counts || '已完成'}</span>
        <ChevronDown size={14} strokeWidth={1.8} className={collapsed ? 'task-chevron collapsed' : 'task-chevron'} />
      </button>

      {collapsed ? null : (
        <ol className="task-list">
          {visible.map((step) => (
            <li key={step.id} className={`task-step task-${step.status}`}>
              <span className="task-icon" aria-hidden="true">
                {step.status === 'done' ? (
                  <CircleCheck size={13} strokeWidth={1.7} />
                ) : step.status === 'active' ? (
                  <Loader2 size={13} strokeWidth={2} className="spin" />
                ) : (
                  <span className="task-ring" />
                )}
              </span>
              <span className="task-text">{step.title}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
