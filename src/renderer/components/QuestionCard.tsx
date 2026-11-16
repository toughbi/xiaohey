import { useState } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import type { QuestionItem } from '../../shared/types';

interface QuestionCardProps {
  item: QuestionItem;
  onAnswer: (questionId: string, answer: string) => Promise<void>;
}

/**
 * A mid-turn clarification: the assistant pauses, the user picks an option or
 * writes their own answer, and the same turn continues with that answer.
 * The pending one lives in the composer dock; settled ones stay in the timeline.
 */
export function QuestionCard({ item, onAnswer }: QuestionCardProps) {
  const [custom, setCustom] = useState('');
  const [sending, setSending] = useState(false);
  const pending = item.status === 'running';

  const answer = async (text: string): Promise<void> => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      await onAnswer(item.id, value);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={`question-card ${pending ? 'question-pending' : ''}`}>
      <div className="question-head">
        <span className="question-kicker">
          <MessageCircleQuestion size={14} strokeWidth={1.6} />
          {item.header || '需要你确认'}
        </span>
        {pending ? (
          <span className="question-state">等待你的回答</span>
        ) : item.answer ? (
          <span className="chip chip-ok">已回答</span>
        ) : (
          <span className="chip chip-quiet">已取消</span>
        )}
      </div>
      <p className="question-text">{item.question}</p>
      {pending ? (
        <>
          <div className="question-options">
            {item.options.map((option) => (
              <button
                key={option.label}
                type="button"
                className="question-option"
                disabled={sending}
                onClick={() => void answer(option.label)}
              >
                <span className="question-option-label">{option.label}</span>
                {option.description ? <span className="question-option-desc">{option.description}</span> : null}
              </button>
            ))}
          </div>
          <form
            className="question-custom"
            onSubmit={(event) => {
              event.preventDefault();
              void answer(custom);
            }}
          >
            <input
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              placeholder="都不合适？写下你的答案…"
              aria-label="自定义回答"
              disabled={sending}
            />
            <button type="submit" className="mini" disabled={sending || !custom.trim()}>
              回答
            </button>
          </form>
        </>
      ) : item.answer ? (
        <p className="question-answer">
          <span>你的回答</span>
          {item.answer}
        </p>
      ) : null}
    </div>
  );
}
