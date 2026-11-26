/**
 * File paths inside a reply.
 *
 * The model writes paths as inline code (`app/page.tsx`), and a reader expects to
 * click them. Two pieces: a heuristic that decides what counts as a path, and a
 * one-slot registry so a deeply memoized Markdown renderer can open a document in
 * the panel without threading a callback through every message.
 */

const FILE_EXTENSION =
  /\.(tsx?|jsx?|mjs|cjs|json|mdx?|css|scss|html|py|go|rs|java|kt|c|h|cc|cpp|hpp|cs|rb|php|sh|ps1|bat|yml|yaml|toml|ini|sql|graphql|proto|txt|xml|svg|png|jpe?g|gif|webp|pdf)$/i;

/** Extensions nobody writes as a member expression: `README.md` is a file. */
const DOCUMENT_EXTENSION =
  /\.(mdx?|json|jsonc|ya?ml|toml|ini|txt|csv|css|scss|html|svg|png|jpe?g|gif|webp|pdf|xml|sql|graphql|proto|lock)$/i;

/**
 * `src/main/a.ts`, `app/page.tsx:42`, `package.json`, `greeter_test.go` → the path.
 *
 * A bare code filename (`main.go`, `a.ts`) is ambiguous with a member expression
 * (`console.log`), so those need a marker — a separator, an inner dot, an
 * underscore, a dash or a capital.
 */
export function fileTargetOf(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 180) return null;
  if (/\s/.test(trimmed)) return null;
  const bare = trimmed.replace(/:\d+(?::\d+)?$/, '');
  const last = bare.split(/[\\/]/).pop() ?? '';
  if (!last || !FILE_EXTENSION.test(last)) return null;
  if (DOCUMENT_EXTENSION.test(last)) return bare;
  if (/[\\/]/.test(bare)) return bare;
  if (last.split('.').length > 2) return bare;
  if (/[_-]/.test(last) || /[A-Z]/.test(last)) return bare;
  return null;
}

type Opener = (path: string) => void;

let opener: Opener | null = null;

export function setFileOpener(next: Opener | null): void {
  opener = next;
}

export function openFileTarget(path: string): void {
  opener?.(path);
}
