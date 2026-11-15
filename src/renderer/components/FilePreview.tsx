import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ImageOff, Loader2 } from 'lucide-react';
import type { DocumentPayload } from '../../shared/types';
import { call } from '../lib/client';
import { CodeBlock, CodeFence } from './CodeBlock';
import { highlightLanguage } from '../lib/highlight';

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
const MARKDOWN_EXTENSION = /\.(md|markdown)$/i;

interface FilePreviewProps {
  doc: DocumentPayload;
  threadId: string;
  onOpenExternal: (url: string) => void;
}

/** Render by file type: markdown as a document, images as images, code highlighted. */
export function FilePreview({ doc, threadId, onOpenExternal }: FilePreviewProps) {
  if (IMAGE_EXTENSION.test(doc.path)) return <ImageView doc={doc} threadId={threadId} />;
  if (MARKDOWN_EXTENSION.test(doc.path)) return <MarkdownView text={doc.content} onOpenExternal={onOpenExternal} />;
  return <CodeView doc={doc} />;
}

function CodeView({ doc }: { doc: DocumentPayload }) {
  return (
    <>
      {doc.truncated ? <div className="docs-warn">文件较大，只显示前 400k 字符。</div> : null}
      <CodeBlock code={doc.content} language={highlightLanguage(doc.path)} label={doc.language} />
    </>
  );
}

function MarkdownView({ text, onOpenExternal }: { text: string; onOpenExternal: (url: string) => void }) {
  return (
    <article className="md-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            pre: CodeFence,
            code: ({ children }) => <code className="md-inline-code">{children}</code>,
            a: ({ href, children }) => (
              <a
                href={href ?? '#'}
                onClick={(event) => {
                  event.preventDefault();
                  if (href && /^https?:/i.test(href)) onOpenExternal(href);
                }}
              >
                {children}
              </a>
            ),
            img: ({ alt }) => <span className="md-image-placeholder">{alt || '图片'}</span>,
            table: ({ children }) => (
              <div className="md-table-wrap">
                <table>{children}</table>
              </div>
            ),
          }}
        >
          {text}
        </ReactMarkdown>
    </article>
  );
}

function ImageView({ doc, threadId }: { doc: DocumentPayload; threadId: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    setError(null);
    void call('fs/read-image', { threadId, path: doc.path })
      .then((result: { dataUrl: string; mime: string } | null) => {
        if (cancelled) return;
        if (result) setDataUrl(result.dataUrl);
        else setError('这个格式不支持内联预览，或文件超过 8 MB');
      })
      .catch((reason: Error) => {
        if (!cancelled) setError(reason.message);
      });
    return () => {
      cancelled = true;
    };
  }, [doc.path, threadId]);

  if (error) {
    return (
      <div className="docs-empty">
        <ImageOff size={18} strokeWidth={1.5} />
        <span>{error}</span>
      </div>
    );
  }
  if (!dataUrl) {
    return (
      <div className="docs-empty">
        <Loader2 size={18} strokeWidth={1.5} className="spin" />
        <span>正在读取图片…</span>
      </div>
    );
  }
  return (
    <div className="image-preview">
      <img src={dataUrl} alt={doc.path} />
      <p className="mono dim">{doc.path}</p>
    </div>
  );
}
