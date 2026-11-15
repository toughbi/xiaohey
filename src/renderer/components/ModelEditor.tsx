import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Eye, EyeOff, Loader2, Maximize2, Minimize2, RefreshCw, X } from 'lucide-react';
import type { ModelProfile } from '../../shared/types';
import { BILLING_TYPES, PROVIDER_GROUPS, providerById, type BillingType, type ModelProvider } from '../lib/providers';
import { billingLabel, effectiveProvider, modelTitle } from '../lib/modelLabel';

type ListModels = (baseUrl: string, apiKey: string) => Promise<{ ok: boolean; models: string[]; detail: string }>;

interface ModelEditorProps {
  mode: 'add' | 'edit';
  profile?: ModelProfile;
  onCancel: () => void;
  onAdd: (profiles: ModelProfile[]) => void;
  onSave: (profile: ModelProfile) => void;
  onTest: (profile: ModelProfile) => Promise<{ ok: boolean; detail: string; latencyMs: number }>;
  onListModels: ListModels;
  onOpenExternal: (url: string) => void;
}

function newId(index: number): string {
  return `m-${Date.now().toString(36)}-${index}`;
}

function draftsFrom(provider: ModelProvider, baseUrl: string, models: string[], apiKey: string): ModelProfile[] {
  return models.map((model, index) => ({
    id: newId(index),
    name: model,
    provider: provider.id,
    baseUrl: baseUrl || provider.baseUrl,
    apiKey,
    model,
    temperature: 0.4,
    maxOutputTokens: provider.maxOutputTokens ?? 4096,
    contextWindow: provider.contextWindow ?? 131_072,
  }));
}

export function ModelEditor({
  mode,
  profile,
  onCancel,
  onAdd,
  onSave,
  onTest,
  onListModels,
  onOpenExternal,
}: ModelEditorProps) {
  const editing = mode === 'edit';

  const [providerId, setProviderId] = useState('deepseek');
  const provider = useMemo(() => providerById(providerId), [providerId]);
  const [billing, setBilling] = useState<BillingType>(BILLING_TYPES[0]);
  const [apiKey, setApiKey] = useState(profile?.apiKey ?? '');
  const [showKey, setShowKey] = useState(false);
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customName, setCustomName] = useState('');
  const [collapsed, setCollapsed] = useState(false);

  const [providerOpen, setProviderOpen] = useState(false);
  const [billingOpen, setBillingOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [manual, setManual] = useState('');
  const keyRef = useRef<HTMLInputElement>(null);

  // Edit mode fields
  const [draft, setDraft] = useState<ModelProfile>(() => {
    const initial = profile ? { ...profile } : draftsFrom(provider, '', [], '')[0];
    return (
      initial ?? {
        id: 'draft',
        name: '',
        baseUrl: '',
        apiKey: '',
        model: '',
        temperature: 0.4,
        maxOutputTokens: 4096,
        contextWindow: 65536,
      }
    );
  });
  const [editKey, setEditKey] = useState('');
  const [validating, setValidating] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detail: string; latencyMs: number } | null>(null);
  const [forceAdd, setForceAdd] = useState(false);

  const baseUrl = provider.id === 'custom' ? customBaseUrl.trim() : provider.baseUrl;
  const needsKey = provider.id !== 'custom';
  const billingUrl = provider.id === 'custom' ? '' : billing === 'Token plan' ? provider.billingUrl : provider.apiKeyUrl;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (providerOpen || billingOpen || modelsOpen) {
        setProviderOpen(false);
        setBillingOpen(false);
        setModelsOpen(false);
      } else {
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel, providerOpen, billingOpen, modelsOpen]);

  // A different provider, key or address makes the old list stale.
  useEffect(() => {
    setModels(null);
    setSelected([]);
    setListError(null);
    setModelsOpen(false);
    setManual('');
    setForceAdd(false);
  }, [providerId, apiKey, customBaseUrl]);

  const loadModels = async (): Promise<string[] | null> => {
    if (loading) return models;
    if (!baseUrl) {
      setListError('先填接口地址，再拉取模型列表');
      return null;
    }
    if (needsKey && !apiKey.trim()) {
      setListError('先填 API Key，供应商才会返回模型列表');
      keyRef.current?.focus();
      return null;
    }
    setLoading(true);
    setListError(null);
    try {
      const response = await onListModels(baseUrl, apiKey);
      if (!response.ok) {
        setModels(null);
        setListError(response.detail);
        return null;
      }
      setModels(response.models);
      setSelected((current) => current.filter((id) => response.models.includes(id)));
      return response.models;
    } catch (error) {
      setListError((error as Error)?.message ?? String(error));
      return null;
    } finally {
      setLoading(false);
    }
  };

  const toggleModels = async (): Promise<void> => {
    if (modelsOpen) {
      setModelsOpen(false);
      return;
    }
    if (models?.length) {
      setModelsOpen(true);
      return;
    }
    const loaded = await loadModels();
    if (loaded) {
      setModelsOpen(true);
      setFilter('');
    }
  };

  const toggleModel = (id: string): void => {
    setSelected((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
    setForceAdd(false);
  };

  const commitManual = (): void => {
    const value = manual.trim();
    if (!value) return;
    setModels([value]);
    setSelected([value]);
    setListError(null);
    setModelsOpen(false);
  };

  const filtered = useMemo(() => {
    if (!models) return [];
    const query = filter.trim().toLowerCase();
    return query ? models.filter((id) => id.toLowerCase().includes(query)) : models;
  }, [models, filter]);

  const allSelected = Boolean(models && models.length > 0 && models.every((id) => selected.includes(id)));
  const chosen = selected.length > 0 ? selected : manual.trim() ? [manual.trim()] : [];

  const editUpdate = <K extends keyof ModelProfile>(key: K, value: ModelProfile[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
    setResult(null);
  };

  const candidates: ModelProfile[] = draftsFrom(provider, baseUrl, chosen, apiKey).map((entry) => ({
    ...entry,
    name: customName.trim() || chosen[0],
    enabled: true,
    billing: billing === 'Token plan' ? 'plan' : 'payg',
  }));

  const canSave = editing
    ? Boolean(draft.name.trim() && draft.model.trim() && draft.baseUrl.trim())
    : chosen.length > 0 && Boolean(baseUrl) && (!needsKey || apiKey.trim().length > 0);

  const validate = async (): Promise<void> => {
    const target = candidates[0];
    if (!target) return;
    setValidating(true);
    setResult(null);
    try {
      const outcome = await onTest(target);
      setResult(outcome);
      if (outcome.ok) onAdd(candidates);
      else setForceAdd(true);
    } catch (error) {
      setResult({ ok: false, detail: (error as Error).message, latencyMs: 0 });
      setForceAdd(true);
    } finally {
      setValidating(false);
    }
  };

  const editProvider = useMemo(
    () => effectiveProvider({ provider: draft.provider, baseUrl: draft.baseUrl }),
    [draft.provider, draft.baseUrl],
  );
  const editTarget = (): ModelProfile => ({ ...draft, apiKey: editKey.trim() || draft.apiKey });
  const validateEdit = async (): Promise<void> => {
    setValidating(true);
    setResult(null);
    try {
      const outcome = await onTest(editTarget());
      setResult(outcome);
      if (outcome.ok) onSave(editTarget());
      else setForceAdd(true);
    } catch (error) {
      setResult({ ok: false, detail: (error as Error).message, latencyMs: 0 });
      setForceAdd(true);
    } finally {
      setValidating(false);
    }
  };

  const modelLabel = loading
    ? '正在获取模型…'
    : selected.length === 0
      ? manual.trim() || '选择模型'
      : selected.length === 1
        ? selected[0]
        : `已选 ${selected.length} 个模型`;

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div className="dialog model-dialog" role="dialog" aria-modal="true" aria-label={editing ? '编辑模型' : '添加模型'}>
        <header className="dialog-head">
          <div>
            <h2>{editing ? '编辑模型' : '添加模型'}</h2>
          </div>
          <div className="dialog-head-actions">
            <button
              type="button"
              className="ghost icon"
              onClick={() => setCollapsed((value) => !value)}
              aria-label={collapsed ? '展开' : '收起'}
              title={collapsed ? '展开' : '收起'}
            >
              {collapsed ? <Maximize2 size={14} strokeWidth={1.6} /> : <Minimize2 size={14} strokeWidth={1.6} />}
            </button>
            <button type="button" className="ghost icon" onClick={onCancel} aria-label="关闭">
              <X size={16} strokeWidth={1.6} />
            </button>
          </div>
        </header>

        {collapsed ? null : (
          <div className="dialog-body">
            {editing ? (
              <>
                <div className="field">
                  <span>供应商</span>
                  <div className="select select-static">
                    <span className="provider-badge" style={{ background: editProvider.color }}>
                      {editProvider.name.slice(0, 1)}
                    </span>
                    {editProvider.name}
                    <ChevronDown size={14} strokeWidth={1.7} className="select-chevron" />
                  </div>
                </div>

                <div className="field">
                  <span>类型</span>
                  <div className="select select-static">
                    {billingLabel(draft.billing)}
                    <ChevronDown size={14} strokeWidth={1.7} className="select-chevron" />
                  </div>
                </div>

                <div className="field">
                  <span>模型</span>
                  <div className="select select-static">
                    {modelTitle(draft)}
                    <ChevronDown size={14} strokeWidth={1.7} className="select-chevron" />
                  </div>
                </div>

                <p className="field-hint">Provider、类型和模型在添加后不可更改；如需切换，请添加新模型。</p>

                <div className="field">
                  <div className="field-head">
                    <span>API Key</span>
                    {editProvider.apiKeyUrl ? (
                      <button type="button" className="field-link" onClick={() => onOpenExternal(editProvider.apiKeyUrl)}>
                        获取 API Key
                        <span aria-hidden="true">↗</span>
                      </button>
                    ) : null}
                  </div>
                  <div className="input-with-icon">
                    <input
                      value={editKey}
                      type={showKey ? 'text' : 'password'}
                      onChange={(event) => {
                        setEditKey(event.target.value);
                        setResult(null);
                      }}
                      spellCheck={false}
                      placeholder="留空以沿用当前 API Key"
                    />
                    <button type="button" className="input-eye" onClick={() => setShowKey((value) => !value)} aria-label="显示或隐藏">
                      {showKey ? <EyeOff size={15} strokeWidth={1.5} /> : <Eye size={15} strokeWidth={1.5} />}
                    </button>
                  </div>
                </div>

                {result && !result.ok ? (
                  <div className="validate-error">
                    <p>{result.detail}</p>
                    <div className="validate-actions">
                      {forceAdd ? (
                        <button type="button" className="mini" onClick={() => onSave(editTarget())}>
                          仍然保存
                        </button>
                      ) : null}
                      <button type="button" className="mini" onClick={() => void validateEdit()}>
                        重新校验
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <div className="field">
                  <span>供应商</span>
                  <div className="select-wrap">
                    <button
                      type="button"
                      className="select"
                      onClick={() => {
                        setProviderOpen((open) => !open);
                        setBillingOpen(false);
                        setModelsOpen(false);
                      }}
                      aria-haspopup="listbox"
                      aria-expanded={providerOpen}
                    >
                      <span className="provider-badge" style={{ background: provider.color }}>
                        {provider.name.slice(0, 1)}
                      </span>
                      {provider.name}
                      <ChevronDown size={14} strokeWidth={1.7} className="select-chevron" />
                    </button>
                    {providerOpen ? (
                      <div className="select-menu provider-menu" role="listbox" aria-label="供应商">
                        {PROVIDER_GROUPS.map((group) => (
                          <div key={group.label}>
                            <div className="select-group">{group.label}</div>
                            {group.items.map((item) => (
                              <button
                                key={item.id}
                                type="button"
                                role="option"
                                aria-selected={item.id === provider.id}
                                className={`select-item ${item.id === provider.id ? 'active' : ''}`}
                                onClick={() => {
                                  setProviderId(item.id);
                                  setProviderOpen(false);
                                }}
                              >
                                <span className="provider-badge" style={{ background: item.color }}>
                                  {item.name.slice(0, 1)}
                                </span>
                                {item.name}
                                {item.id === provider.id ? <Check size={14} strokeWidth={1.8} className="select-check" /> : null}
                              </button>
                            ))}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="field">
                  <div className="field-head">
                    <span>类型</span>
                    {billingUrl ? (
                      <button type="button" className="field-link" onClick={() => onOpenExternal(billingUrl)}>
                        {billing === 'Token plan' ? '购买 Token Plan' : '查看计费'}
                        <span aria-hidden="true">↗</span>
                      </button>
                    ) : null}
                  </div>
                  <div className="select-wrap">
                    <button
                      type="button"
                      className="select"
                      onClick={() => {
                        setBillingOpen((open) => !open);
                        setProviderOpen(false);
                        setModelsOpen(false);
                      }}
                      aria-haspopup="listbox"
                      aria-expanded={billingOpen}
                    >
                      {billing}
                      <ChevronDown size={14} strokeWidth={1.7} className="select-chevron" />
                    </button>
                    {billingOpen ? (
                      <div className="select-menu" role="listbox" aria-label="类型">
                        {BILLING_TYPES.map((option) => (
                          <button
                            key={option}
                            type="button"
                            role="option"
                            aria-selected={billing === option}
                            className={`select-item ${billing === option ? 'active' : ''}`}
                            onClick={() => {
                              setBilling(option);
                              setBillingOpen(false);
                            }}
                          >
                            {option}
                            {billing === option ? <Check size={14} strokeWidth={1.8} className="select-check" /> : null}
                          </button>
                        ))}
                        <p className="select-note">本机只保存 API Key，计费在供应商那边结算。</p>
                      </div>
                    ) : null}
                  </div>
                </div>

                {provider.id === 'custom' ? (
                  <label className="field">
                    <span>接口地址</span>
                    <input
                      value={customBaseUrl}
                      onChange={(event) => setCustomBaseUrl(event.target.value)}
                      placeholder="http://127.0.0.1:8080/v1"
                      spellCheck={false}
                    />
                  </label>
                ) : null}

                <div className="field">
                  <span>模型</span>
                  <div className="select-wrap">
                    <button
                      type="button"
                      className={`select ${chosen.length === 0 ? 'placeholder' : ''}`}
                      onClick={() => void toggleModels()}
                      aria-haspopup="listbox"
                      aria-expanded={modelsOpen}
                      disabled={loading}
                    >
                      {loading ? <Loader2 size={13} strokeWidth={1.7} className="spin" /> : null}
                      {modelLabel}
                      <ChevronDown size={14} strokeWidth={1.7} className="select-chevron" />
                    </button>

                    {listError ? (
                      <div className="model-fetch">
                        <p className="model-fetch-error">{listError}</p>
                        <div className="model-fetch-row">
                          <button type="button" className="mini" onClick={() => void loadModels()}>
                            <RefreshCw size={11} strokeWidth={1.8} />
                            重试
                          </button>
                          <input
                            className="model-manual"
                            value={manual}
                            onChange={(event) => setManual(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                commitManual();
                              }
                            }}
                            placeholder="或手动填模型名后回车"
                            spellCheck={false}
                          />
                        </div>
                      </div>
                    ) : null}

                    {modelsOpen && models ? (
                      <div className="select-menu model-menu-list" role="listbox" aria-label="模型" aria-multiselectable="true">
                        {models.length > 8 ? (
                          <input
                            className="model-filter"
                            value={filter}
                            onChange={(event) => setFilter(event.target.value)}
                            placeholder="筛选模型…"
                            aria-label="筛选模型"
                          />
                        ) : null}
                        <button
                          type="button"
                          role="option"
                          aria-selected={allSelected}
                          className={`check-item all ${allSelected ? 'checked' : ''}`}
                          onClick={() => setSelected(allSelected ? [] : [...models])}
                        >
                          <span className={`checkbox ${allSelected ? 'on' : ''}`}>
                            {allSelected ? <Check size={11} strokeWidth={2.4} /> : null}
                          </span>
                          全选
                          <span className="mono dim check-count">{models.length}</span>
                        </button>
                        {filtered.map((id) => {
                          const checked = selected.includes(id);
                          return (
                            <button
                              key={id}
                              type="button"
                              role="option"
                              aria-selected={checked}
                              className={`check-item ${checked ? 'checked' : ''}`}
                              onClick={() => toggleModel(id)}
                            >
                              <span className={`checkbox ${checked ? 'on' : ''}`}>
                                {checked ? <Check size={11} strokeWidth={2.4} /> : null}
                              </span>
                              <span className="mono">{id}</span>
                            </button>
                          );
                        })}
                        {filtered.length === 0 ? <p className="docs-empty">没有匹配的模型</p> : null}
                      </div>
                    ) : null}
                  </div>
                  <em className="model-source">
                    {models ? `来自 ${baseUrl} 的 ${models.length} 个模型` : '填好 API Key 后，点开这里从供应商的 /models 拉取'}
                  </em>
                </div>

                <div className="field">
                  <div className="field-head">
                    <span>API Key</span>
                    {provider.apiKeyUrl ? (
                      <button type="button" className="field-link" onClick={() => onOpenExternal(provider.apiKeyUrl)}>
                        获取 API Key
                        <span aria-hidden="true">↗</span>
                      </button>
                    ) : null}
                  </div>
                  <div className="input-with-icon">
                    <input
                      ref={keyRef}
                      value={apiKey}
                      type={showKey ? 'text' : 'password'}
                      onChange={(event) => setApiKey(event.target.value)}
                      spellCheck={false}
                      placeholder="请输入 API Key"
                    />
                    <button type="button" className="input-eye" onClick={() => setShowKey((value) => !value)} aria-label="显示或隐藏">
                      {showKey ? <EyeOff size={15} strokeWidth={1.5} /> : <Eye size={15} strokeWidth={1.5} />}
                    </button>
                  </div>
                  {provider.id === 'custom' ? <em>本地端点一般不需要 Key</em> : null}
                </div>

                {provider.id === 'custom' ? (
                  <label className="field">
                    <span>显示名称</span>
                    <input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="例如 本地 llama" />
                  </label>
                ) : null}

                {result && !result.ok ? (
                  <div className="validate-error">
                    <p>{result.detail}</p>
                    <div className="validate-actions">
                      {forceAdd ? (
                        <button type="button" className="mini" onClick={() => onAdd(candidates)}>
                          仍然添加
                        </button>
                      ) : null}
                      <button type="button" className="mini" onClick={() => void validate()}>
                        重新校验
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}

        <footer className="dialog-foot">
          <div className="dialog-actions">
            <button type="button" className="ghost" onClick={onCancel}>
              取消
            </button>
            {editing ? (
              <button type="button" className="primary" onClick={() => void validateEdit()} disabled={validating}>
                {validating ? <Loader2 size={13} strokeWidth={1.7} className="spin" /> : null}
                {validating ? '校验中…' : '校验并保存'}
              </button>
            ) : (
              <button type="button" className="primary" onClick={() => void validate()} disabled={!canSave || validating}>
                {validating ? <Loader2 size={13} strokeWidth={1.7} className="spin" /> : null}
                {validating ? '校验中…' : '校验并添加模型'}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
