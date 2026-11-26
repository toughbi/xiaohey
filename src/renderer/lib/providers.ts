export type ProviderGroup = '推荐' | '更多' | '自定义';

export interface ModelProvider {
  id: string;
  name: string;
  /** OpenAI-compatible root URL; empty for the custom entry. */
  baseUrl: string;
  group: ProviderGroup;
  /** Badge colour, roughly the provider's brand colour. */
  color: string;
  /** Where the user creates an API key. */
  apiKeyUrl: string;
  /** Where the user buys / checks token plans. */
  billingUrl: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/**
 * Only endpoints and links live here; the model list is fetched from each
 * provider's `/models` at add time, so it reflects what the key can really call.
 */
export const PROVIDERS: ModelProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    group: '推荐',
    color: '#4d6bfe',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    billingUrl: 'https://platform.deepseek.com/top_up',
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
  },
  {
    id: 'dashscope',
    name: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    group: '推荐',
    color: '#ff6a00',
    apiKeyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    billingUrl: 'https://bailian.console.aliyun.com/?tab=model#/efm/model_plaza',
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
  },
  {
    id: 'zhipu',
    name: '智谱',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    group: '更多',
    color: '#2f6bff',
    apiKeyUrl: 'https://bigmodel.cn/usercenter/apikeys',
    billingUrl: 'https://bigmodel.cn/finance/overview',
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
  },
  {
    id: 'kimi',
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    group: '更多',
    color: '#111827',
    apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
    billingUrl: 'https://platform.moonshot.cn/console/account',
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    group: '更多',
    color: '#3b5bff',
    apiKeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    billingUrl: 'https://platform.minimaxi.com/user-center/payment/balance',
    contextWindow: 245_760,
    maxOutputTokens: 8_192,
  },
  {
    id: 'custom',
    // The protocol is not a vendor. Custom models carry their own provenance in
    // `provider`, so the catalogue only has to say "you configure this yourself".
    name: '自定义',
    baseUrl: '',
    group: '自定义',
    color: '#6b7280',
    apiKeyUrl: '',
    billingUrl: '',
  },
];

export const PROVIDER_GROUPS: Array<{ label: string; items: ModelProvider[] }> = [
  { label: '推荐', items: PROVIDERS.filter((provider) => provider.group === '推荐') },
  { label: '更多', items: PROVIDERS.filter((provider) => provider.group === '更多') },
  { label: '手动配置', items: PROVIDERS.filter((provider) => provider.group === '自定义') },
];

export const BILLING_TYPES = ['Token plan', '按量付费'] as const;
export type BillingType = (typeof BILLING_TYPES)[number];

const CUSTOM = PROVIDERS[PROVIDERS.length - 1];

/**
 * A profile may carry a vendor string the catalogue does not know: the user typed
 * it in the add dialog and it is stored as `provider`. Show it as typed — falling
 * back to the first catalogue entry would relabel every custom model "DeepSeek".
 */
export function providerById(id: string): ModelProvider {
  const trimmed = id.trim();
  if (!trimmed) return CUSTOM;
  const known = PROVIDERS.find((provider) => provider.id === trimmed);
  if (known) return known;
  return { ...CUSTOM, id: trimmed, name: trimmed };
}
