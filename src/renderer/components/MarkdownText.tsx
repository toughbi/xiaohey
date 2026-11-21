import { memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { call } from '../lib/client';
import { CodeFence } from './CodeBlock';

const REMARK_PLUGINS = [remarkGfm];

const COMPONENTS: Components = {
  pre: CodeFence,
  code: ({ children }: { children?: ReactNode }) => <code className="md-inline-code">{children}</code>,
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
