import Prism from 'prismjs';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-clike';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';

const EXTENSIONS: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  css: 'css',
  scss: 'css',
  html: 'markup',
  htm: 'markup',
  svg: 'markup',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  sh: 'bash',
  ps1: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  go: 'go',
  rs: 'rust',
};

export function highlightLanguage(path: string): string | null {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  const language = EXTENSIONS[extension];
  return language && Prism.languages[language] ? language : null;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Prism emits one HTML string; the preview shows a line-number gutter, so split
 * it per line while re-opening tokens that span the break (block comments,
 * template literals) to keep every line's markup balanced.
 */
function splitLines(html: string): string[] {
  const lines: string[] = [];
  const stack: string[] = [];
  let current = '';
  let index = 0;
  while (index < html.length) {
    const char = html[index];
    if (char === '<') {
      const end = html.indexOf('>', index);
      if (end === -1) {
        current += html.slice(index);
        break;
      }
      const tag = html.slice(index, end + 1);
      if (tag.startsWith('</')) stack.pop();
      else if (!tag.endsWith('/>')) stack.push(tag);
      current += tag;
      index = end + 1;
      continue;
    }
    if (char === '\n') {
      lines.push(current + '</span>'.repeat(stack.length));
      current = stack.join('');
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  lines.push(current);
  return lines;
}

/** Highlighted, per-line HTML for the code preview; plain escaped text when the language is unknown. */
export function highlightLines(code: string, language: string | null): string[] {
  if (!language || !Prism.languages[language]) return code.split(/\r?\n/).map(escapeHtml);
  return splitLines(Prism.highlight(code, Prism.languages[language], language));
}
