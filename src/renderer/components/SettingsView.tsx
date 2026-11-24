import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  MoreHorizontal,
  Zap,
  ArrowLeft,
  BarChart3,
  Check,
  Info,
  Palette,
  Pencil,
  Plus,
  Settings2,
  Trash2,
} from 'lucide-react';
import type { ActivityResult, EmbeddingSettings, ModelProfile, Settings } from '../../shared/types';
import { ActivityCard } from './ActivityHeatmap';
import { ModelEditor } from './ModelEditor';
import { providerById } from '../lib/providers';
import { effectiveProvider, modelTitle } from '../lib/modelLabel';

type Page = 'appearance' | 'models' | 'usage' | 'about';

interface SettingsViewProps {
  settings: Settings;
  theme: 'dark' | 'light';
  activity: ActivityResult | null;
  workspace: { path: string; name: string; branch: string | null } | null;
  user: string;
  version: string;
  platform: string;
  onClose: () => void;
  onSave: (settings: Settings) => Promise<void>;
  onTest: (model: ModelProfile) => Promise<{ ok: boolean; detail: string; latencyMs: number }>;
  onListModels: (
    baseUrl: string,
    apiKey: string,
  ) => Promise<{
    ok: boolean;
    models: string[];
    limits: Record<string, { contextWindow?: number; maxOutputTokens?: number }>;
    detail: string;
  }>;
  onOpenExternal: (url: string) => void;
  onTheme: (theme: 'dark' | 'light') => void;
}

const NAV: Array<{ id: Page; label: string; icon: ReactNode }> = [
  { id: 'models', label: '模型', icon: <Settings2 size={15} strokeWidth={1.6} /> },
  { id: 'appearance', label: '外观', icon: <Palette size={15} strokeWidth={1.6} /> },
  { id: 'usage', label: '使用统计', icon: <BarChart3 size={15} strokeWidth={1.6} /> },
  { id: 'about', label: '关于', icon: <Info size={15} strokeWidth={1.6} /> },
];

const PAGE_META: Record<Page, { title: string; subtitle: string }> = {
  models: { title: '模型', subtitle: '使用自有 API Key 管理自定义模型。' },
  appearance: { title: '外观', subtitle: '浅色与深色共用一套结构，只是表面颜色不同。' },
  usage: { title: '使用统计', subtitle: '按天统计消息与工具调用，最近 52 周。' },
  about: { title: '关于', subtitle: '本机运行信息与数据位置。' },
};

const EMPTY_EMBEDDING: EmbeddingSettings = {
  enabled: false,
  baseUrl: '',
  apiKey: '',
  model: '',
  rerankModel: '',
  rerankBaseUrl: '',
};


export function SettingsView({
  settings,
  theme,
  activity,
  workspace,
  user,
  version,
  platform,
  onClose,
  onSave,
  onTest,
  onListModels,
  onOpenExternal,
  onTheme,
}: SettingsViewProps) {
  const [page, setPage] = useState<Page>('models');
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<{ mode: 'add' } | { mode: 'edit'; profile: ModelProfile } | null>(null);

  const nav = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return NAV;
    return NAV.filter((item) => item.label.toLowerCase().includes(query));
  }, [search]);

  const meta = PAGE_META[page];
  const activeModelId = settings.activeModelId;

  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [embedding, setEmbedding] = useState<EmbeddingSettings>(settings.embedding ?? EMPTY_EMBEDDING);
  const [embeddingDirty, setEmbeddingDirty] = useState(false);

  useEffect(() => {
    setEmbedding(settings.embedding ?? EMPTY_EMBEDDING);
    setEmbeddingDirty(false);
  }, [settings.embedding]);

  const saveEmbedding = async (next: EmbeddingSettings): Promise<void> => {
    await onSave({ ...settings, embedding: next });
    setEmbeddingDirty(false);
  };

  const editEmbedding = (patch: Partial<EmbeddingSettings>): void => {
    setEmbedding((current) => ({ ...current, ...patch }));
    setEmbeddingDirty(true);
  };

  const toggleEmbedding = (): void => {
    const next = { ...embedding, enabled: !embedding.enabled };
    setEmbedding(next);
    void saveEmbedding(next).catch(() => setEmbeddingDirty(true));
  };

  const toggleModel = async (profile: ModelProfile): Promise<void> => {
    const enabled = profile.enabled !== false;
    const next = settings.models.map((entry) => (entry.id === profile.id ? { ...entry, enabled: !enabled } : entry));
    let nextActive = settings.activeModelId;
    if (enabled && nextActive === profile.id) nextActive = next.find((entry) => entry.enabled !== false)?.id ?? '';
    await saveModels(next, nextActive);
  };

  const saveModels = async (models: ModelProfile[], nextActive?: string): Promise<void> => {
    const activeModelId =
      nextActive ??
      (models.some((profile) => profile.id === settings.activeModelId) ? settings.activeModelId : (models[0]?.id ?? ''));
    await onSave({ ...settings, models, activeModelId });
  };

  const commitAdd = async (profiles: ModelProfile[]): Promise<void> => {
    if (profiles.length === 0) return;
    await saveModels([...settings.models, ...profiles]);
    setEditor(null);
  };

  const commitEdit = async (profile: ModelProfile): Promise<void> => {
    await saveModels(settings.models.map((entry) => (entry.id === profile.id ? profile : entry)));
    setEditor(null);
  };

  const removeModel = async (id: string): Promise<void> => {
    await saveModels(settings.models.filter((profile) => profile.id !== id));
  };

  return (
    <div className="settings-view">
      <aside className="settings-side">
        <button type="button" className="settings-back" onClick={onClose}>
          <ArrowLeft size={14} strokeWidth={1.6} />
          返回应用
        </button>
        <input
          className="settings-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索设置…"
          aria-label="搜索设置"
        />
        <nav className="settings-nav">
          <div className="settings-group">应用</div>
          {nav.map((item) => (
            <button
              key={item.id}
              type="button"
              className={page === item.id ? 'active' : ''}
              onClick={() => setPage(item.id)}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <section className="settings-pane">
        <header className="settings-head">
          <div>
            <h1>{meta.title}</h1>
            <p>{meta.subtitle}</p>
          </div>
          {page === 'models' ? (
            <button type="button" className="primary" onClick={() => setEditor({ mode: 'add' })}>
              <Plus size={15} strokeWidth={1.8} />
              添加模型
            </button>
          ) : null}
        </header>

        {page === 'models' ? (
          <>
            {settings.models.length === 0 ? (
            <div className="settings-empty">
              <span className="settings-empty-glyph">
                <Settings2 size={22} strokeWidth={1.4} />
              </span>
              <p>暂无自定义模型，点击添加模型开始使用</p>
            </div>
          ) : (
            <div className="model-panel">
              <ul className="model-rows model-cards">
                {settings.models
                  .filter((profile) => {
                    const query = search.trim().toLowerCase();
                    if (!query) return true;
                    return `${profile.name} ${profile.model} ${profile.baseUrl} ${providerById(profile.provider ?? 'custom').name}`
                      .toLowerCase()
                      .includes(query);
                  })
                  .map((profile) => {
                    const provider = effectiveProvider(profile);
                    const active = profile.id === activeModelId;
                    const enabled = profile.enabled !== false;
                    const title = modelTitle(profile);
                    const billing = profile.billing === 'plan' ? 'Token plan' : 'Pay As You Go';
                    return (
                      <li key={profile.id} className={`model-row ${enabled ? '' : 'disabled'} ${active ? 'active' : ''}`} data-model={profile.model}>
                        <span className="model-badge" style={{ color: provider.color }} aria-hidden="true">
                          <Zap size={14} strokeWidth={1.7} />
                        </span>
                        <div className="model-row-main">
                          <div className="model-row-title">
                            <span>{title}</span>
                            {active ? <span className="model-current">当前</span> : null}
                          </div>
                          <div className="model-row-sub">
                            {provider.name} · {billing}
                          </div>
                        </div>
                        <div className="model-row-actions">
                          <div className="model-row-menu-wrap">
                            <button
                              type="button"
                              className="ghost icon"
                              onClick={() => setRowMenu(rowMenu === profile.id ? null : profile.id)}
                              aria-label={`${title} 的操作`}
                              title="更多"
                            >
                              <MoreHorizontal size={16} strokeWidth={1.6} />
                            </button>
                            {rowMenu === profile.id ? (
                              <>
                                <div className="policy-backdrop" onClick={() => setRowMenu(null)} />
                                <div className="row-menu" role="menu">
                                  {!active ? (
                                    <button
                                      type="button"
                                      role="menuitem"
                                      onClick={() => {
                                        setRowMenu(null);
                                        void saveModels(settings.models, profile.id);
                                      }}
                                    >
                                      <Check size={13} strokeWidth={1.8} />
                                      设为当前
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      setRowMenu(null);
                                      setEditor({ mode: 'edit', profile: { ...profile } });
                                    }}
                                  >
                                    <Pencil size={13} strokeWidth={1.6} />
                                    编辑
                                  </button>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="danger"
                                    onClick={() => {
                                      setRowMenu(null);
                                      void removeModel(profile.id);
                                    }}
                                  >
                                    <Trash2 size={13} strokeWidth={1.6} />
                                    删除
                                  </button>
                                </div>
                              </>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={enabled}
                            aria-label={`${enabled ? '停用' : '启用'} ${title}`}
                            className={`switch ${enabled ? 'on' : ''}`}
                            onClick={() => void toggleModel(profile)}
                          >
                            <span className="switch-knob" />
                          </button>
                        </div>
                      </li>
                    );
                  })}
              </ul>
            </div>
          )}
            <div className="embedding-panel">
              <div className="embedding-head">
                <div>
                  <h2>记忆向量召回</h2>
                  <p>长期记忆使用向量检索 + 关键词匹配混合召回。接口需支持 OpenAI 兼容的 POST /embeddings；未配置时使用本地哈希向量，仍可离线工作。</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={embedding.enabled}
                  aria-label={`${embedding.enabled ? '停用' : '启用'}记忆向量召回`}
                  className={`switch ${embedding.enabled ? 'on' : ''}`}
                  onClick={toggleEmbedding}
                >
                  <span className="switch-knob" />
                </button>
              </div>
              <div className={`embedding-fields ${embedding.enabled ? '' : 'disabled'}`}>
                <label>
                  <span>Embedding 模型</span>
                  <input
                    value={embedding.model}
                    onChange={(event) => editEmbedding({ model: event.target.value })}
                    placeholder="例如 text-embedding-3-small / bge-m3"
                    disabled={!embedding.enabled}
                  />
                </label>
                <label>
                  <span>接口地址（可选）</span>
                  <input
                    value={embedding.baseUrl}
                    onChange={(event) => editEmbedding({ baseUrl: event.target.value })}
                    placeholder="留空复用当前模型的接口地址"
                    disabled={!embedding.enabled}
                  />
                </label>
                <label>
                  <span>API Key（可选）</span>
                  <input
                    type="password"
                    value={embedding.apiKey}
                    onChange={(event) => editEmbedding({ apiKey: event.target.value })}
                    placeholder="留空复用当前模型的 Key"
                    disabled={!embedding.enabled}
                  />
                </label>
                <label>
                  <span>重排模型（可选）</span>
                  <input
                    value={embedding.rerankModel}
                    onChange={(event) => editEmbedding({ rerankModel: event.target.value })}
                    placeholder="例如 qwen3.7-text-rerank / bge-reranker-v2-m3"
                    disabled={!embedding.enabled}
                  />
                </label>
                <label>
                  <span>重排接口（可选）</span>
                  <input
                    value={embedding.rerankBaseUrl}
                    onChange={(event) => editEmbedding({ rerankBaseUrl: event.target.value })}
                    placeholder="留空自动推断（阿里云走原生 rerank 路径，其余走 /rerank）"
                    disabled={!embedding.enabled}
                  />
                </label>
              </div>
              <div className="embedding-foot">
                <span>
                  {embedding.enabled && !embedding.model.trim()
                    ? '填写 Embedding 模型后才会启用语义向量；当前仍使用本地哈希向量。'
                    : embedding.rerankModel.trim()
                      ? '重排会在召回候选上再算一次相关度，能提高首条命中率，代价是一次额外请求（约 0.2 秒）。'
                      : '索引保存在 ~/.xiaohei/memory-vectors.json；更换模型会自动重建。'}
                </span>
                <button
                  type="button"
                  className="mini"
                  disabled={!embeddingDirty}
                  onClick={() => void saveEmbedding(embedding).catch(() => setEmbeddingDirty(true))}
                >
                  {embeddingDirty ? '保存向量设置' : '已保存'}
                </button>
              </div>
            </div>
          </>
        ) : null}

        {page === 'appearance' ? (
          <div className="theme-cards">
            <button
              type="button"
              className={`theme-card light ${theme === 'light' ? 'active' : ''}`}
              onClick={() => onTheme('light')}
            >
              <span className="theme-preview">
                <span className="theme-preview-rail" />
                <span className="theme-preview-panel" />
              </span>
              <span className="theme-name">浅色</span>
            </button>
            <button
              type="button"
              className={`theme-card dark ${theme === 'dark' ? 'active' : ''}`}
              onClick={() => onTheme('dark')}
            >
              <span className="theme-preview">
                <span className="theme-preview-rail" />
                <span className="theme-preview-panel" />
              </span>
              <span className="theme-name">深色</span>
            </button>
          </div>
        ) : null}

        {page === 'usage' ? (
          <div className="settings-usage">
            <ActivityCard activity={activity} />
            <dl className="settings-stats">
              <div>
                <dt>会话数</dt>
                <dd className="mono">{activity?.summary.sessions ?? 0}</dd>
              </div>
              <div>
                <dt>活跃天数</dt>
                <dd className="mono">{activity?.summary.activeDays ?? 0}</dd>
              </div>
              <div>
                <dt>记录条数</dt>
                <dd className="mono">{activity?.summary.records ?? 0}</dd>
              </div>
            </dl>
          </div>
        ) : null}

        {page === 'about' ? (
          <dl className="settings-about">
            <div>
              <dt>版本</dt>
              <dd className="mono">{version}</dd>
            </div>
            <div>
              <dt>运行平台</dt>
              <dd className="mono">{platform}</dd>
            </div>
            <div>
              <dt>用户</dt>
              <dd className="mono">{user}</dd>
            </div>
            <div>
              <dt>工作区</dt>
              <dd className="mono">{workspace?.path ?? '—'}</dd>
            </div>
            <div>
              <dt>分支</dt>
              <dd className="mono">{workspace?.branch ?? '非 git 仓库'}</dd>
            </div>
            <div>
              <dt>模型</dt>
              <dd className="mono">{settings.models.length} 个</dd>
            </div>
            <p className="settings-about-note">
              会话、检查点、记忆与设置全部保存在本机；应用不会主动上传工作区内容，只有模型请求会带上你在对话里给出的上下文。
            </p>
          </dl>
        ) : null}
      </section>

      {editor ? (
        <ModelEditor
          mode={editor.mode}
          profile={editor.mode === 'edit' ? editor.profile : undefined}
          onCancel={() => setEditor(null)}
          onAdd={(profiles) => void commitAdd(profiles)}
          onSave={(profile) => void commitEdit(profile)}
          onTest={onTest}
          onListModels={onListModels}
          onOpenExternal={onOpenExternal}
        />
      ) : null}
    </div>
  );
}
