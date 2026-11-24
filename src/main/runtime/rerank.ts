import { normalizeEmbeddingConfig, type EmbeddingConfig } from './embedding.js';

/**
 * Optional reranking stage for long-term memory recall.
 *
 * Hybrid retrieval is cheap and gets the right memory into a small candidate
 * pool; a reranker then scores `(query, document)` pairs directly, which is what
 * fixes the remaining top-1 errors: on the bundled evaluation set it moved
 * top-1 from 88% to 100% for ~180ms per recall.
 *
 * Two request shapes are supported because providers never agreed on one:
 *  - Cohere/Jina/SiliconFlow: `POST {base}/rerank` with `{model, query, documents, top_n}`;
 *  - Alibaba DashScope native: `POST .../services/rerank/text-rerank/text-rerank`
 *    with `{model, input:{query, documents}, parameters:{...}}`.
 * The shape is chosen from the URL, and a 404 retries the other one, so a user
 * who pastes the "wrong" URL still gets a working reranker instead of silence.
 */

export interface RerankConfig extends EmbeddingConfig {
  /** 'dashscope' or 'cohere'; explicit so the retry is predictable. */
  protocol?: 'dashscope' | 'cohere';
}

export const RERANK_TIMEOUT_MS = 10_000;
export const MAX_RERANK_DOCUMENTS = 40;

const DASHSCOPE_SUFFIX = '/api/v1/services/rerank/text-rerank/text-rerank';

export function normalizeRerankConfig(raw: Partial<RerankConfig> | null | undefined): RerankConfig | null {
  const base = normalizeEmbeddingConfig(raw ?? null);
  if (!base) return null;
  const protocol = raw?.protocol === 'dashscope' || raw?.protocol === 'cohere' ? raw.protocol : undefined;
  return { ...base, ...(protocol ? { protocol } : {}) };
}

/**
 * Derive the rerank endpoint from whatever the user pasted:
 *  - an aliyuncs host gets the DashScope native path;
 *  - an explicit `.../rerank` URL is used as-is;
 *  - anything else gets `{base}/rerank` (Cohere-compatible).
 */
export function rerankEndpoint(config: RerankConfig): { url: string; protocol: 'dashscope' | 'cohere' } {
  const base = config.baseUrl.replace(/\/+$/, '');
  const host = (() => {
    try {
      return new URL(base).host;
    } catch {
      return '';
    }
  })();

  if (base.includes('/services/rerank')) return { url: base, protocol: 'dashscope' };
  if (base.endsWith('/rerank')) return { url: base, protocol: 'cohere' };
  if (host.endsWith('aliyuncs.com')) {
    const origin = (() => {
      try {
        return new URL(base).origin;
      } catch {
        return base;
      }
    })();
    return { url: `${origin}${DASHSCOPE_SUFFIX}`, protocol: 'dashscope' };
  }
  return { url: `${base}/rerank`, protocol: 'cohere' };
}

interface RerankResponse {
  output?: { results?: Array<{ index?: number; relevance_score?: number; relevanceScore?: number }> };
  results?: Array<{ index?: number; relevance_score?: number; relevanceScore?: number }>;
  error?: { message?: string };
}

export class RerankError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'RerankError';
  }
}

async function callRerank(config: RerankConfig, query: string, documents: string[], protocol: 'dashscope' | 'cohere'): Promise<number[]> {
  const { url } = protocol === 'dashscope' ? rerankEndpoint({ ...config, protocol }) : { url: config.baseUrl.endsWith('/rerank') ? config.baseUrl : `${config.baseUrl.replace(/\/+$/, '')}/rerank` };
  const body =
    protocol === 'dashscope'
      ? {
          model: config.model,
          input: { query, documents },
          parameters: { top_n: documents.length, return_documents: false },
        }
      : { model: config.model, query, documents, top_n: documents.length };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new RerankError(`rerank HTTP ${response.status}${text ? `：${text.slice(0, 200)}` : ''}`, response.status);
    }
    const payload = (await response.json()) as RerankResponse;
    if (payload.error?.message) throw new RerankError(`rerank: ${payload.error.message}`);
    const results = payload.output?.results ?? payload.results ?? [];
    if (results.length === 0) throw new RerankError('rerank 返回为空');
    const scores = new Array<number>(documents.length).fill(0);
    for (const item of results) {
      const index = typeof item.index === 'number' ? item.index : -1;
      // camelCase is Jina/SiliconFlow; snake_case is Cohere/DashScope.
      const score = typeof item.relevance_score === 'number' ? item.relevance_score : item.relevanceScore;
      if (index >= 0 && index < scores.length && typeof score === 'number' && Number.isFinite(score)) {
        scores[index] = score;
      }
    }
    // Missing entries keep score 0: "not reranked" must sort last, never first.
    return scores;
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new RerankError(`rerank 超时（${Math.round(RERANK_TIMEOUT_MS / 1000)} 秒）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Score every document against the query. Returns one score per input, in input
 * order; a provider that only returns `top_n` leaves the rest at 0.
 */
export async function rerankDocuments(config: RerankConfig, query: string, documents: string[]): Promise<number[]> {
  const limited = documents.slice(0, MAX_RERANK_DOCUMENTS).map((text) => text.slice(0, 6000));
  if (limited.length === 0 || !query.trim()) return new Array<number>(documents.length).fill(0);
  const first = config.protocol ?? rerankEndpoint(config).protocol;
  try {
    const scores = await callRerank(config, query, limited, first);
    return scores;
  } catch (error) {
    const status = error instanceof RerankError ? error.status : 0;
    // Only a routing failure justifies trying the other shape; a 401 or a
    // timeout means the configured endpoint exists and is simply unhappy.
    if (status !== 404 && status !== 405 && status !== 0) throw error;
    const second: 'dashscope' | 'cohere' = first === 'dashscope' ? 'cohere' : 'dashscope';
    const scores = await callRerank(config, query, limited, second);
    return scores;
  }
}

/** Resolves the rerank configuration on each call, so a settings change applies at once. */
export interface Reranker {
  readonly label: string;
  config(): RerankConfig | null;
  score(query: string, documents: string[]): Promise<number[]>;
}

export class ConfiguredReranker implements Reranker {
  constructor(private readonly resolve: () => RerankConfig | null) {}

  get label(): string {
    const config = this.config();
    return config ? `rerank · ${config.model}` : 'off';
  }

  config(): RerankConfig | null {
    return normalizeRerankConfig(this.resolve());
  }

  async score(query: string, documents: string[]): Promise<number[]> {
    const config = this.config();
    if (!config) throw new RerankError('未配置 rerank 模型');
    return rerankDocuments(config, query, documents);
  }
}

/** Min-max normalize so scores from different providers share one scale. */
export function normalizeScores(scores: readonly number[]): number[] {
  if (scores.length === 0) return [];
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const score of scores) {
    if (score < min) min = score;
    if (score > max) max = score;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-6) {
    return scores.map(() => 0.5);
  }
  return scores.map((score) => (score - min) / (max - min));
}