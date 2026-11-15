import { useState } from 'react';
import { ArrowUp, ChevronDown, ListOrdered, Pencil, Trash2 } from 'lucide-react';

export interface QueuedMessage {
  id: string;
  text: string;
}

interface QueuedMessagesProps {
  items: QueuedMessage[];
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onSendNow: (id: string) => void;
}

/** Messages typed while a turn is running, pinned above the composer. */
export function QueuedMessages({ items, onEdit, onDelete, onSendNow }: QueuedMessagesProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  if (items.length === 0) return null;

  const commit = (id: string): void => {
    const text = draft.trim();
    if (text) onEdit(id, text);
    setEditing(null);
    setDraft('');
  };

  return (
    <div className="queue-panel">
      <div className="queue-head">
        <button type="button" className="queue-title" onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed}>
          <ListOrdered size={14} strokeWidth={1.8} />
          <span>{items.length} 条排队消息</span>
          <ChevronDown size={14} strokeWidth={1.8} className={collapsed ? 'queue-chevron collapsed' : 'queue-chevron'} />
        </button>
      </div>

      {collapsed ? null : (
        <ul className="queue-list">
          {items.map((item) => (
            <li key={item.id} className="queue-item">
              {editing === item.id ? (
                <input
                  className="queue-edit"
                  autoFocus
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      commit(item.id);
                    }
                    if (event.key === 'Escape') {
                      setEditing(null);
                      setDraft('');
                    }
                  }}
                  onBlur={() => commit(item.id)}
                  aria-label="编辑排队消息"
                />
              ) : (
                <span className="queue-text" title={item.text}>
                  {item.text}
                </span>
              )}
              <span className="queue-actions">
                <button
                  type="button"
                  aria-label="编辑"
                  title="编辑"
                  onClick={() => {
                    setEditing(item.id);
                    setDraft(item.text);
                  }}
                >
                  <Pencil size={13} strokeWidth={1.8} />
                </button>
                <button type="button" aria-label="删除" title="删除" onClick={() => onDelete(item.id)}>
                  <Trash2 size={13} strokeWidth={1.8} />
                </button>
                <button type="button" aria-label="立即发送" title="立即发送" onClick={() => onSendNow(item.id)}>
                  <ArrowUp size={14} strokeWidth={2} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
