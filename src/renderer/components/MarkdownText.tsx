import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { call } from '../lib/client';
import { CodeFence } from './CodeBlock';

/**
 * Assistant replies are Markdown: inline code, lists, fenced blocks, tables,
 * links. User messages stay plain text so their formatting is never "improved".
 */
export function MarkdownText({ text }: { text: string }) {
  return (
    <div className="md-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: CodeFence,
          code: ({ children }) => <code className="md-inline-code">{children}</code>,
          table: ({ children }) => (
            <div className="md-table-wrap">
              <table>{children}</table>
            </div>
          ),
          a: ({ href, children }) => (
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
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
