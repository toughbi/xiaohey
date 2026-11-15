import { Children, isValidElement, useMemo, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { highlightLines } from '../lib/highlight';
import { CopyButton } from './CopyButton';

interface CodeBlockProps {
  code: string;
  /** Prism grammar id; null keeps the text plain. */
  language?: string | null;
  /** Header label when the file's language id is not a Prism grammar. */
  label?: string;
  /** Show the 1-based line number rail. */
  gutter?: boolean;
  /** 1-based number of the first line; the rail width follows the last one. */
  firstLine?: number;
}

/**
 * One code surface for every place code is shown: the file preview, fenced
 * blocks in replies and docs. The gutter is a grid column, so a soft-wrapped
 * line continues under the code instead of running back under the numbers, and
 * Prism's per-line HTML keeps cross-line tokens balanced.
 */
export function CodeBlock({ code, language = null, label, gutter = true, firstLine = 1 }: CodeBlockProps) {
  const lines = useMemo(() => highlightLines(code, language), [code, language]);
  const lastLine = firstLine + Math.max(lines.length - 1, 0);
  const gutterCh = Math.max(2, String(lastLine).length);

  return (
    <div className="code-panel">
      <div className="code-panel-head">
        <span className="code-lang">{label ?? language ?? 'text'}</span>
        {lines.length > 1 ? <span className="code-count">{lines.length} 行</span> : null}
        <CopyButton text={code} label="复制代码" />
      </div>
      <div
        className={`code-panel-body ${gutter ? '' : 'plain'}`.trim()}
        style={gutter ? ({ '--code-gutter': `${gutterCh}ch` } as CSSProperties) : undefined}
      >
        {lines.map((line, index) => (
          <div className="code-row" key={index}>
            {gutter ? <span className="code-gutter">{firstLine + index}</span> : null}
            <code className="code-text" dangerouslySetInnerHTML={{ __html: line || ' ' }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Markdown `<pre>` override: fenced blocks become a CodeBlock, labelled ones get a gutter. */
export function CodeFence({ children }: { children?: ReactNode }) {
  const child = Children.toArray(children).find(
    (node): node is ReactElement<{ className?: string; children?: ReactNode }> => isValidElement(node),
  );
  if (!child) return <pre className="md-pre">{children}</pre>;

  const match = /language-([\w+#.-]+)/.exec(child.props.className ?? '');
  const content = child.props.children;
  const raw = (Array.isArray(content) ? content.join('') : String(content ?? '')).replace(/\n$/, '');
  const language = match ? match[1].toLowerCase() : null;
  const lineCount = raw.split('\n').length;

  return <CodeBlock code={raw} language={language} gutter={lineCount >= 3} />;
}
