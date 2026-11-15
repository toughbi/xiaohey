import type { RequestMap, RequestName, RequestResult } from '../../shared/types';

/** Thin typed client over the preload bridge. */
export async function call<K extends RequestName>(
  method: K,
  params: RequestMap[K]['params'],
): Promise<RequestResult<K>> {
  const envelope = await window.xiaohey.request(method as string, params as unknown);
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.value as RequestResult<K>;
}

export function subscribe(listener: (event: Parameters<typeof window.xiaohey.onEvent>[0] extends (event: infer E) => void ? E : never) => void): () => void {
  return window.xiaohey.onEvent(listener as never);
}
