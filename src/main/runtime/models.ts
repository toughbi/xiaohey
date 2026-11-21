/**
 * Ask a provider for its model list instead of shipping a frozen catalogue:
 * every OpenAI-compatible endpoint exposes GET /models, and that list is the
 * only one guaranteed to match what the key can actually call.
 */
export interface ModelLimit {
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ModelListResult {
  ok: boolean;
  models: string[];
  limits: Record<string, ModelLimit>;
  detail: string;
}

const TIMEOUT_MS = 12_000;

export async function listModels(baseUrl: string, apiKey: string): Promise<ModelListResult> {
  const root = baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(root)) {
    return { ok: false, models: [], limits: {}, detail: '接口地址要以 http:// 或 https:// 开头' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${root}/models`, {
      headers: apiKey.trim() ? { authorization: `Bearer ${apiKey.trim()}` } : {},
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const hint = response.status === 401 || response.status === 403 ? '（Key 无效或没有权限）' : '';
      return {
        ok: false,
        models: [],
        limits: {},
        detail: `供应商返回 ${response.status}${hint}${body ? `：${body.slice(0, 120)}` : ''}`,
      };
    }
    const payload = (await response.json()) as { data?: Array<Record<string, unknown>> };
    const models: string[] = [];
    const limits: Record<string, ModelLimit> = {};
    for (const entry of payload.data ?? []) {
      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      if (!id) continue;
      models.push(id);
      const nested = (value: unknown): Record<string, unknown> =>
        value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
      const providerLimits = nested(entry.top_provider);
      const declared = nested(entry.limits);
      const read = (...values: unknown[]): number | undefined => {
        for (const value of values) {
          const numeric =
            typeof value === 'number'
              ? value
              : typeof value === 'string' && value.trim()
                ? Number(value)
                : Number.NaN;
          if (Number.isFinite(numeric) && numeric > 0) return Math.round(numeric);
        }
        return undefined;
      };
      const contextWindow = read(
        entry.context_length,
        entry.context_window,
        entry.contextWindow,
        entry.max_context_length,
        entry.max_context_tokens,
        declared.context,
        declared.context_window,
        providerLimits.context_length,
      );
      const maxOutputTokens = read(
        entry.max_completion_tokens,
        entry.max_output_tokens,
        entry.maxOutputTokens,
        entry.output_token_limit,
        declared.output,
        declared.max_output_tokens,
        providerLimits.max_completion_tokens,
        providerLimits.max_output_tokens,
      );
      if (contextWindow || maxOutputTokens) {
        limits[id] = {
          ...(contextWindow ? { contextWindow } : {}),
          ...(maxOutputTokens ? { maxOutputTokens } : {}),
        };
      }
    }
    const unique = [...new Set(models)].sort((a, b) => a.localeCompare(b));
    if (unique.length === 0) {
      return { ok: false, models: [], limits: {}, detail: '供应商没有返回任何模型，可以手动填写模型名' };
    }
    return { ok: true, models: unique, limits, detail: `拿到 ${unique.length} 个模型` };
  } catch (error) {
    const failure = error as Error;
    const message =
      failure.name === 'AbortError'
        ? `获取模型列表超时（${Math.round(TIMEOUT_MS / 1000)} 秒）`
        : /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET/i.test(failure.message)
          ? `连不上 ${root} —— 检查地址、Key 或本机网络`
          : failure.message;
    return { ok: false, models: [], limits: {}, detail: message };
  } finally {
    clearTimeout(timer);
  }
}
