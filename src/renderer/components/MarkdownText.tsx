import { memo, type ReactNode } from 'react';
import { FileCode2 } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { call } from '../lib/client';
import { fileTargetOf, openFileTarget } from '../lib/fileLinks';
import { CodeFence } from './CodeBlock';

const REMARK_PLUGINS = [remarkGfm];

const COMPONENTS: Components = {
  pre: CodeFence,
  code: ({ children, className }: { children?: ReactNode; className?: string }) => {
    // Inline code that names a file becomes a door into the document panel; a
    // fenced block never does, and neither does anything that reads as a command.
    const text = String(Array.isArray(children) ? children.join('') : children ?? '');
    const target = className ? null : fileTargetOf(text);
    if (target) {
      return (
        <button
          type="button"
          className="md-file-ref"
          title={`在文档区打开 ${target}`}
          onClick={() => openFileTarget(target)}
        >
          <FileCode2 size={11} strokeWidth={1.7} aria-hidden="true" />
          {text}
        </button>
      );
    }
    return <code className="md-inline-code">{children}</code>;
  },
  table: ({ children }: { children?: ReactNode }) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  ),
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (href) void call('app/open-external', { url: href });
      }}
    >
      {children}
    </a>
  ),
};

/**
 * Assistant replies are Markdown: inline code, lists, fenced blocks, tables,
 * links. User messages stay plain text so their formatting is never "improved".
 * Memoized: the clock ticks and tool rows change every second during a turn,
 * and re-parsing an unchanged answer on those renders was pure jank.
 */
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div className="md-chat">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
