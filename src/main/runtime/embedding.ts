import { createHash } from 'node:crypto';

/**
 * Embedding support for long-term memory recall.
 *
 * Two implementations behind one interface:
 *  - `provider`: any OpenAI-compatible `POST /embeddings`, so semantic vectors
 *    work with OpenAI, SiliconFlow, a local llama.cpp server, etc.;
 *  - `local`: a deterministic signed feature-hash vector (CJK chars/bigrams,
 *    Latin words/4-grams). It needs no network and no model, and keeps hybrid
 *    recall working offline. It is lexical, not semantic — configure a provider
 *    model for real semantic retrieval.
 *
 * The embedder identity (`id`) is stored with the index: changing the model or
 * endpoint invalidates old vectors instead of mixing vector spaces.
 */

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface Embedder {
  readonly id: string;
  readonly label: string;
  readonly local: boolean;
  embed(texts: string[]): Promise<number[][]>;
}

export const LOCAL_EMBEDDING_DIM = 384;
export const EMBEDDING_TIMEOUT_MS = 10_000;
/**
 * Conservative batch size. DashScope-compatible endpoints reject more than 20
 * inputs per request, and classic text-embedding-v3 allows 10; oversize batches
 * are split automatically, so this is a starting point, not a hard limit.
 */
export const EMBEDDING_BATCH = 10;

const shortHash = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 8);

export function normalizeEmbeddingConfig(raw: Partial<EmbeddingConfig> | null | undefined): EmbeddingConfig | null {
  if (!raw) return null;
  const baseUrl = String(raw.baseUrl ?? '').trim().replace(/\/+$/, '');
  const model = String(raw.model ?? '').trim();
  if (!baseUrl || !model) return null;
  return { baseUrl, apiKey: String(raw.apiKey ?? '').trim(), model };
}

function endpoint(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, '');
  return root.endsWith('/embeddings') ? root : `${root}/embeddings`;
}

const toVector = (value: unknown): number[] | null => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const vector: number[] = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) return null;
    vector.push(item);
  }
  return vector;
};

/** POST /embeddings in batches; returns one vector per input in input order. */
export async function providerEmbeddings(config: EmbeddingConfig, texts: string[]): Promise<number[][]> {
  const output: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += EMBEDDING_BATCH) {
    const batch = texts.slice(offset, offset + EMBEDDING_BATCH);
    output.push(...(await embedBatch(config, batch)));
  }
  return output;
}

/** A provider that caps inputs rejects the batch with a 4xx; split and retry. */
function isBatchSizeError(error: unknown): boolean {
  const message = `${(error as Error)?.message ?? ''}`;
  return /batch size|should not be larger|too many|maximum .*input|max_batch|invalid_parameter/i.test(message);
}

async function embedBatch(config: EmbeddingConfig, batch: string[]): Promise<number[][]> {
  try {
    return await embedRequest(config, batch);
  } catch (error) {
    if (batch.length > 1 && isBatchSizeError(error)) {
      const middle = Math.ceil(batch.length / 2);
      const head = await embedBatch(config, batch.slice(0, middle));
      const tail = await embedBatch(config, batch.slice(middle));
      return [...head, ...tail];
    }
    throw error;
  }
}

async function embedRequest(config: EmbeddingConfig, batch: string[]): Promise<number[][]> {
  const payloadTexts = batch.map((text) => text.slice(0, 8000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint(config.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: config.model, input: payloadTexts, encoding_format: 'float' }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const hint = response.status === 401 || response.status === 403 ? '（Key 无效或没有权限）' : '';
      throw new Error(`embeddings HTTP ${response.status}${hint}${body ? `：${body.slice(0, 200)}` : ''}`);
    }
    const payload = (await response.json()) as {
      data?: Array<{ embedding?: unknown; index?: number }>;
      embeddings?: unknown;
      error?: { message?: string };
    };
    if (payload.error?.message) throw new Error(`embeddings: ${payload.error.message}`);
    let vectors: Array<number[] | null> = [];
    if (Array.isArray(payload.data)) {
      vectors = [...payload.data]
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((entry) => toVector(entry.embedding));
    } else if (Array.isArray(payload.embeddings)) {
      vectors = payload.embeddings.map((entry) => toVector(entry));
    }
    if (vectors.length !== payloadTexts.length || vectors.some((vector) => vector === null)) {
      throw new Error('embeddings 返回数量或维度不匹配');
    }
    return vectors as number[][];
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error(`embeddings 超时（${Math.round(EMBEDDING_TIMEOUT_MS / 1000)} 秒）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const CJK = /[\u2e80-\u9fff\uf900-\ufaff]/;
const WORD = /[a-z0-9_-]/i;

function fnv1a(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Signed feature hashing of CJK chars/bigrams and Latin words/4-grams. */
export function localEmbedding(text: string, dimension = LOCAL_EMBEDDING_DIM): number[] {
  const vector = new Array<number>(dimension).fill(0);
  const normalized = text.toLowerCase();
  const add = (token: string): void => {
    const hash = fnv1a(token);
    const index = hash % dimension;
    vector[index] += hash >>> 31 ? -1 : 1;
  };
  let cursor = 0;
  while (cursor < normalized.length) {
    const char = normalized[cursor];
    if (CJK.test(char)) {
      let end = cursor;
      while (end < normalized.length && CJK.test(normalized[end])) end += 1;
      const run = normalized.slice(cursor, end);
      for (let index = 0; index < run.length; index += 1) add(`c:${run[index]}`);
      for (let index = 0; index < run.length - 1; index += 1) add(`b:${run.slice(index, index + 2)}`);
      cursor = end;
      continue;
    }
    if (WORD.test(char)) {
      let end = cursor;
      while (end < normalized.length && WORD.test(normalized[end])) end += 1;
      const word = normalized.slice(cursor, end);
      if (word) {
        add(`w:${word}`);
        if (word.length > 4) {
          for (let index = 0; index < word.length - 3; index += 1) add(`g:${word.slice(index, index + 4)}`);
        }
      }
      cursor = end;
      continue;
    }
    cursor += 1;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  if (norm > 0) {
    const scale = 1 / Math.sqrt(norm);
    for (let index = 0; index < vector.length; index += 1) vector[index] *= scale;
  }
  return vector;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

/**
 * Turn-path recall must not wait on a slow embedding provider: once the shared
 * budget is spent every embed rejects, and the callers fall back to keyword
 * ranking. The inner request keeps running but its result is simply unused.
 */
export function boundedEmbedder(inner: Embedder, budgetMs: number): Embedder {
  const deadline = Date.now() + budgetMs;
  const spent = (): Error => new Error('embedding budget exhausted');
  return {
    get id() {
      return inner.id;
    },
    get label() {
      return inner.label;
    },
    get local() {
      return inner.local;
    },
    embed(texts) {
      const left = deadline - Date.now();
      if (left <= 0) return Promise.reject(spent());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(spent()), left);
        inner.embed(texts).then(
          (vectors) => {
            clearTimeout(timer);
            resolve(vectors);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    },
  };
}

/**
 * Resolves the active embedding configuration on every call, so changing the
 * model in Settings takes effect without recreating the memory service.
 */
export class ConfiguredEmbedder implements Embedder {
  constructor(private readonly resolve: () => EmbeddingConfig | null) {}

  private current(): EmbeddingConfig | null {
    return normalizeEmbeddingConfig(this.resolve());
  }

  get id(): string {
    const config = this.current();
    return config ? `provider:${shortHash(config.baseUrl)}:${config.model}` : 'local-hash-v1';
  }

  get label(): string {
    const config = this.current();
    return config ? `provider · ${config.model}` : '本地哈希向量';
  }

  get local(): boolean {
    return this.current() === null;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const config = this.current();
    if (!config) return texts.map((text) => localEmbedding(text));
    return providerEmbeddings(config, texts);
  }
}
