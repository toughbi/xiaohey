import type { ModelSettings } from '../../shared/types.js';

/**
 * Minimal OpenAI-compatible chat client: streaming deltas, tool calls, usage.
 * No SDK, so any endpoint that speaks /chat/completions works (DeepSeek, OpenAI,
 * a local llama.cpp server, an internal gateway).
 */

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /**
   * DeepSeek thinking models require the assistant's reasoning to be replayed
   * with the message it belongs to, otherwise the follow-up call fails with
   * HTTP 400 ("reasoning_content ... must be passed back").
   */
  reasoning_content?: string | null;
}

export interface CompletionResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: { promptTokens: number; completionTokens: number };
  finishReason: string;
  servedModel: string;
}

export interface StreamHooks {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolCall?: (call: ToolCall) => void;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly hint: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

function endpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
}

function describeHttpError(status: number, body: string): LlmError {
  if (status === 401 || status === 403) {
    return new LlmError(
      `接口拒绝了这把 key（HTTP ${status}）`,
      status,
      false,
      '打开「设置」核对 API Key 与接口地址，key 一般以 sk- 开头。',
    );
  }
  if (status === 404) {
    return new LlmError(
      '模型或路由不存在（HTTP 404）',
      status,
      false,
      '核对模型名，并确认接口地址指向 OpenAI 兼容根路径，例如 https://api.deepseek.com/v1。',
    );
  }
  if (status === 429) {
    return new LlmError('被限流了（HTTP 429）', status, true, '等过限流窗口再发一次。');
  }
  if (status >= 500) {
    return new LlmError(`服务端异常（HTTP ${status}）`, status, true, '属于临时故障，退避后重试。');
  }
  return new LlmError(`请求失败（HTTP ${status}）`, status, false, body.slice(0, 400) || '检查模型配置。');
}

interface SsePayload {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
  error?: { message?: string };
}

/**
 * Thinking models require reasoning_content on every assistant tool-call
 * message. A response may carry no reasoning at all, so if the endpoint
 * complains, replay the tool-call turns with an empty string and retry once.
 */
function withReasoningReplay(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) =>
    message.role === 'assistant' && message.reasoning_content === undefined
      ? { ...message, reasoning_content: '' }
      : message,
  );
}

export async function complete(
  settings: ModelSettings,
  messages: ChatMessage[],
  options: { tools?: unknown[]; signal?: AbortSignal; hooks?: StreamHooks; retries?: number } = {},
): Promise<CompletionResult> {
  const retries = options.retries ?? 2;
  let attempt = 0;
  let lastError: unknown;
  let outgoing = messages;
  let replayed = false;

  while (attempt <= retries) {
    try {
      return await once(settings, outgoing, options);
    } catch (error) {
      lastError = error;
      const aborted = options.signal?.aborted === true || (error as { name?: string } | null)?.name === 'AbortError';
      // A cancelled turn must not sit through the retry backoff.
      if (aborted) break;
      const text = `${String((error as Error)?.message ?? '')} ${String((error as { hint?: string } | null)?.hint ?? '')}`;
      if (!replayed && /reasoning_content/i.test(text) && messages.some((message) => message.role === 'assistant')) {
        replayed = true;
        outgoing = withReasoningReplay(messages);
        continue;
      }
      const retryable = error instanceof LlmError ? error.retryable : true;
      if (!retryable || attempt === retries) break;
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
      attempt += 1;
    }
  }
  throw lastError;
}

async function once(
  settings: ModelSettings,
  messages: ChatMessage[],
  options: { tools?: unknown[]; signal?: AbortSignal; hooks?: StreamHooks },
): Promise<CompletionResult> {
  if (process.env.XIAOHEY_LLM_DEBUG) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.XIAOHEY_LLM_DEBUG, JSON.stringify({ at: Date.now(), messages }) + '\\n').catch(() => undefined);
  }

  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    temperature: settings.temperature,
    max_tokens: settings.maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = 'auto';
  }

  const response = await fetch(endpoint(settings.baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw describeHttpError(response.status, text);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let finishReason = '';
  let servedModel = settings.model;
  const usage = { promptTokens: 0, completionTokens: 0 };
  const calls: Array<{ id: string; name: string; args: string }> = [];

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let payload: SsePayload;
      try {
        payload = JSON.parse(data) as SsePayload;
      } catch {
        continue;
      }
      if (payload.error?.message) {
        throw new LlmError(payload.error.message, 200, true, 'The endpoint returned an error mid-stream; retry.');
      }
      if (payload.model) servedModel = payload.model;
      if (payload.usage) {
        usage.promptTokens = payload.usage.prompt_tokens ?? usage.promptTokens;
        usage.completionTokens = payload.usage.completion_tokens ?? usage.completionTokens;
      }
      const choice = payload.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (delta?.reasoning_content) {
        reasoning += delta.reasoning_content;
        options.hooks?.onReasoning?.(delta.reasoning_content);
      }
      if (delta?.content) {
        content += delta.content;
        options.hooks?.onText?.(delta.content);
      }
      for (const part of delta?.tool_calls ?? []) {
        const slot = (calls[part.index] ??= { id: '', name: '', args: '' });
        if (part.id) slot.id = part.id;
        if (part.function?.name) slot.name = part.function.name;
        if (part.function?.arguments) slot.args += part.function.arguments;
      }
    }
  }

  const toolCalls: ToolCall[] = calls
    .filter((call) => call && call.name)
    .map((call, index) => ({
      id: call.id || `call_${index}_${Date.now().toString(36)}`,
      type: 'function' as const,
      function: { name: call.name, arguments: call.args || '{}' },
    }));

  for (const call of toolCalls) options.hooks?.onToolCall?.(call);

  return { content, reasoning, toolCalls, usage, finishReason, servedModel };
}

/** One tiny round trip used by the settings page's "test" button. */
export async function testModel(settings: ModelSettings): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
  const started = Date.now();
  try {
    const result = await complete(
      { ...settings, maxOutputTokens: 16, temperature: 0 },
      [
        { role: 'system', content: 'Reply with the single word: ready' },
        { role: 'user', content: 'ping' },
      ],
      { retries: 0 },
    );
    return { ok: true, detail: `${result.servedModel} replied "${result.content.trim().slice(0, 40) || 'ready'}"`, latencyMs: Date.now() - started };
  } catch (error) {
    const raw = error instanceof LlmError ? `${error.message} — ${error.hint}` : (error as Error).message;
    const detail =
      /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|network/i.test(raw)
        ? `连不上 ${settings.baseUrl} —— 检查地址是否正确、本机服务或代理是否已启动`
        : raw;
    return { ok: false, detail, latencyMs: Date.now() - started };
  }
}
