import { PROVIDERS, providerById, type ModelProvider } from './providers';
import type { ModelProfile } from '../../shared/types';

const capToken = (token: string): string =>
  /^[a-z]+\d[\w.]*$/i.test(token) ? token.toUpperCase() : token.charAt(0).toUpperCase() + token.slice(1);

/** Older profiles have no provider id; match their endpoint against the catalog. */
export function effectiveProvider(profile: Pick<ModelProfile, 'provider' | 'baseUrl'>): ModelProvider {
  const provider = providerById(profile.provider ?? 'custom');
  if (provider.id !== 'custom') return provider;
  const known = PROVIDERS.find((entry) => {
    if (!entry.baseUrl) return false;
    return profile.baseUrl.startsWith(entry.baseUrl.replace(/\/v1$/, ''));
  });
  return known ?? provider;
}

/** "deepseek-v4-pro" with provider DeepSeek -> "DeepSeek-V4-Pro". */
export function modelTitle(profile: ModelProfile): string {
  const provider = effectiveProvider(profile);
  const key = provider.id.toLowerCase();
  const tokens = profile.model.split(/[-_]/).filter(Boolean);
  const head = (tokens[0] ?? '').toLowerCase();
  if (key !== 'custom' && head.startsWith(key)) {
    return [provider.name, ...tokens.slice(1).map(capToken)].join('-');
  }
  return tokens.map(capToken).join('-');
}

/** "plan" -> "Token plan", anything else -> "按量付费". */
export function billingLabel(billing: ModelProfile['billing']): string {
  return billing === 'plan' ? 'Token plan' : '按量付费';
}
