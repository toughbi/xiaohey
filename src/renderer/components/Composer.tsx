import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUp,
  AtSign,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Database,
  Folder,
  GitBranch,
  Layers,
  Plus,
  RotateCw,
  Search,
  Shield,
  ShieldCheck,
  Unlock,
} from 'lucide-react';
import type { ApprovalPolicy, ApprovalRequest, ContextGauge, FileEntry, ModelProfile } from '../../shared/types';
import { tokens } from '../lib/format';
import { PROVIDERS, providerById } from '../lib/providers';
import { call } from '../lib/client';
import { ContextMeter } from './ContextMeter';

interface ComposerMeta {
  turns: number;
  steps: number;
  tokens: number;
  percent: number;
  workspace: string;
  branch: string | null;
  /** Session prompt tokens and how many the provider served from its cache. */
  cache: { prompt: number; cached: number } | null;
}

interface ComposerProps {
  /** True when there is no usable model: typing stays possible, sending does not. */
  blocked: boolean;
  /** No folder picked yet: sending asks for a workspace first. */
  needsWorkspace?: boolean;
  running: boolean;
  threadId: string | null;
  models: ModelProfile[];
  activeModelId: string;
  approval: ApprovalRequest | null;
  policy: ApprovalPolicy;
  meta: ComposerMeta;
  /** Token composition behind the percentage in the meta row. */
  context?: ContextGauge | null;
  onContextOpen?: () => void;
  onSend: (text: string) => boolean | Promise<boolean>;
  onQueue: (text: string) => boolean | Promise<boolean>;
  onStop: () => void;
  onApprove: (approvalId: string, decision: 'allow_once' | 'allow_always' | 'deny') => void;
  onAllowAlways: (approval: ApprovalRequest) => void;
  onPolicy: (policy: ApprovalPolicy) => void;
  onSelectModel: (id: string) => void;
  onUpdateModel: (id: string, patch: Partial<ModelProfile>) => void;
  onOpenFiles: () => void;
  onWorkspaceClick?: (rect: DOMRect) => void;
}

const POLICY_LABEL: Record<ApprovalPolicy, string> = {
  ask: '每次询问',
  auto: '自动审批',
  full: '完全访问',
};

const REASONING_LEVELS = [
  { value: 'default', label: '默认' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
] as const;

const CONTEXT_WINDOWS = [32_768, 65_536, 131_072, 204_800, 409_600, 1_048_576];
const OUTPUT_LIMITS = [4_096, 8_192, 16_384, 32_768, 65_536];

function contextWindowLabel(value: number): string {
  if (value >= 1_048_576) return `${Math.round((value / 1_048_576) * 10) / 10}M`;
  return `${Math.round(value / 1024)}K`;
}

const POLICY_OPTIONS: Array<{
  id: ApprovalPolicy;
  title: string;
  description: string;
  icon: ReactNode;
}> = [
  {
    id: 'ask',
    title: '每次询问',
    description: '每次命令执行和文件写入都先问你',
    icon: <ShieldCheck size={15} strokeWidth={1.6} />,
  },
  {
    id: 'auto',
    title: '自动审批',
    description: '只在危险命令或高风险写入时询问（覆盖大文件、敏感路径）',
    icon: <Shield size={15} strokeWidth={1.6} />,
  },
  {
    id: 'full',
    title: '完全访问',
    description: '不再询问，命令与写入直接执行，仍全程记录到日志与检查点',
    icon: <Unlock size={15} strokeWidth={1.6} />,
  },
];

export function Composer({
  blocked,
  needsWorkspace = false,
  running,
  threadId,
  models,
  activeModelId,
  approval,
  policy,
  meta,
  context = null,
  onContextOpen,
  onSend,
  onQueue,
  onStop,
  onApprove,
  onAllowAlways,
  onPolicy,
  onSelectModel,
  onUpdateModel,
  onOpenFiles,
  onWorkspaceClick,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const [policyOpen, setPolicyOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelView, setModelView] = useState<'root' | 'models' | 'reasoning' | 'context' | 'output'>('root');
  const [plusOpen, setPlusOpen] = useState(false);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [fileQuery, setFileQuery] = useState('');
  const [modelQuery, setModelQuery] = useState('');
  const [dragging, setDragging] = useState(false);
  const reference = useRef<HTMLTextAreaElement>(null);
  const availableModels = models.filter((profile) => profile.enabled !== false);
  const activeModel = models.find((profile) => profile.id === activeModelId) ?? availableModels[0] ?? models[0];
  const reasoningLabel =
    REASONING_LEVELS.find((level) => level.value === (activeModel?.reasoningEffort ?? 'default'))?.label ?? '默认';
  const contextWindows = activeModel && activeModel.contextWindow > 0
    ? [...new Set([...CONTEXT_WINDOWS, activeModel.contextWindow])].sort((left, right) => left - right)
    : [];
  const outputLimits = activeModel && activeModel.maxOutputTokens > 0
    ? [...new Set([
        ...(activeModel.contextWindow > 0
          ? OUTPUT_LIMITS.filter((value) => value < activeModel.contextWindow)
          : OUTPUT_LIMITS),
        activeModel.maxOutputTokens,
      ])].sort((left, right) => left - right)
    : [];

  useEffect(() => {
    const node = reference.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(200, node.scrollHeight)}px`;
  }, [value]);

  useEffect(() => {
    if (!modelOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (modelView === 'root') setModelOpen(false);
      else setModelView('root');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modelOpen, modelView]);

  const insertReference = (path: string): void => {
    const node = reference.current;
    const token = `@${path} `;
    if (!node) {
      setValue((current) => `${current}${token}`);
      return;
    }
    const start = node.selectionStart ?? value.length;
    const end = node.selectionEnd ?? value.length;
    setValue(`${value.slice(0, start)}${token}${value.slice(end)}`);
    requestAnimationFrame(() => {
      const caret = start + token.length;
      node.focus();
      node.setSelectionRange(caret, caret);
    });
  };

  const loadFiles = async (): Promise<void> => {
    if (!threadId) return;
    const list = await call('fs/files', { threadId }).catch(() => []);
    setFiles(list);
  };

  /** Copy dropped / pasted files into uploads/ and reference them. */
  const attachFiles = async (filesToAttach: FileList): Promise<void> => {
    if (!threadId) return;
    for (const file of Array.from(filesToAttach).slice(0, 5)) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let index = 0; index < bytes.length; index += 8192) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
        }
        const saved = await call('fs/attach', { threadId, name: file.name || 'pasted-file', data: btoa(binary) });
        insertReference(saved.path);
      } catch {
        // skip a file that cannot be stored; the text box still works
      }
    }
    setFiles(null);
  };

  const openReference = async (): Promise<void> => {
    setPlusOpen(false);
    setReferenceOpen(true);
    setFileQuery('');
    if (!files) await loadFiles();
  };

  const filteredFiles = useMemo(() => {
    const list = files ?? [];
    const query = fileQuery.trim().toLowerCase();
    if (!query) return list.slice(0, 60);
    return list.filter((entry) => entry.path.toLowerCase().includes(query)).slice(0, 60);
  }, [files, fileQuery]);

  const hostLabel = (baseUrl: string): string => {
    try {
      const host = new URL(baseUrl).hostname;
      const parts = host.split('.').filter((part) => part && !['api', 'www', 'openapi', 'v1', 'com', 'cn', 'net', 'org'].includes(part));
      const guess = parts[0] || host;
      return guess.charAt(0).toUpperCase() + guess.slice(1);
    } catch {
      return '自定义';
    }
  };

  const providerLabel = (profile: ModelProfile): string => {
    if (profile.provider && profile.provider !== 'custom') return providerById(profile.provider).name;
    const base = profile.baseUrl.replace(/\/+$/, '');
    const known = PROVIDERS.find((entry) => {
      if (!entry.baseUrl) return false;
      const prefix = entry.baseUrl.replace(/\/v1$/, '').replace(/\/+$/, '');
      return base.startsWith(prefix);
    });
    if (known) return known.name;
    return hostLabel(profile.baseUrl);
  };

  const modelGroups = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    const map = new Map<string, ModelProfile[]>();
    for (const profile of availableModels) {
      const label = providerLabel(profile);
      if (query && !`${profile.model} ${profile.name} ${label}`.toLowerCase().includes(query)) continue;
      const list = map.get(label) ?? [];
      list.push(profile);
      map.set(label, list);
    }
    return [...map.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([label, items]) => ({ label, items: items.slice().sort((a, b) => a.model.localeCompare(b.model)) }));
  }, [availableModels, modelQuery]);

  const submit = async (): Promise<void> => {
    const text = value.trim();
    if (!text) return;
    const accepted = running ? await onQueue(text) : await onSend(text);
    if (accepted !== false) setValue('');
  };

  return (
    <div className="composer-wrap">
      {approval ? (
        <div className="approval-card">
          <div className="approval-head">
            <span className="label">需要你的许可</span>
            <span className="mono dim">
              {approval.risk === 'exec' ? '命令' : '写入'}
              {approval.tier ? ` · ${approval.tier === 'high' ? '高风险' : approval.tier === 'medium' ? '中风险' : '低风险'}` : ''}
            </span>
          </div>
          <pre className="approval-command">
            {approval.risk === 'exec' ? '$ ' : ''}
            {approval.command}
          </pre>
          <p className="approval-reason">{approval.reason}</p>
          <div className="approval-actions">
            <button type="button" className="primary small" onClick={() => onApprove(approval.id, 'allow_once')}>
              允许一次
            </button>
            <button type="button" className="mini" onClick={() => onApprove(approval.id, 'allow_always')}>
              本会话允许
            </button>
            <button
              type="button"
              className="mini"
              onClick={() => onAllowAlways(approval)}
              title={approval.risk === 'exec' ? '以后这条命令不再询问' : '以后写入这个文件不再询问'}
            >
              {approval.risk === 'exec' ? '总是允许这条命令' : '总是允许写这个文件'}
            </button>
            <button type="button" className="mini danger" onClick={() => onApprove(approval.id, 'deny')}>
              拒绝
            </button>
          </div>
        </div>
      ) : null}

      <div
        className={`composer ${blocked ? 'composer-idle' : ''} ${dragging ? 'composer-drag' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const path = event.dataTransfer.getData('text/x-xiaohey-path');
          if (path) {
            insertReference(path);
            return;
          }
          if (event.dataTransfer.files?.length) void attachFiles(event.dataTransfer.files);
        }}
      >
        <textarea
          ref={reference}
          value={value}
          rows={1}
          placeholder={blocked ? '先在设置里添加一个模型' : needsWorkspace ? '请选择工作区…' : running ? '回车加入排队，或点右侧停止键中止' : '继续当前会话… 输入 @ 可引用工作区文件'}
          onChange={(event) => setValue(event.target.value)}
          onPaste={(event) => {
            const filesToAttach = event.clipboardData?.files;
            if (filesToAttach && filesToAttach.length > 0) {
              event.preventDefault();
              void attachFiles(filesToAttach);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
            if (event.key === '@' && event.nativeEvent.isComposing === false) {
              void openReference();
            }
          }}
        />
        <div className="composer-toolbar">
          <div className="tb-left">
            <div className="plus-wrap">
              <button
                type="button"
                className="composer-add"
                onClick={() => setPlusOpen((open) => !open)}
                title="添加上下文"
                aria-label="添加上下文"
                aria-expanded={plusOpen}
              >
                <Plus size={15} strokeWidth={1.8} />
              </button>
              {plusOpen ? (
                <>
                  <div className="policy-backdrop" onClick={() => setPlusOpen(false)} />
                  <div className="plus-menu" role="menu">
                    <button type="button" role="menuitem" onClick={() => void openReference()}>
                      <AtSign size={13} strokeWidth={1.7} />
                      引用工作区文件…
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setPlusOpen(false);
                        onOpenFiles();
                      }}
                    >
                      <Folder size={13} strokeWidth={1.7} />
                      打开文件面板
                    </button>
                  </div>
                </>
              ) : null}
            </div>
            <div className="policy-wrap">
              <button
                type="button"
                className="tb-chip"
                onClick={() => setPolicyOpen((open) => !open)}
                aria-haspopup="listbox"
                aria-expanded={policyOpen}
                title="批准方式"
              >
                {policy === 'full' ? (
                  <Unlock size={13} strokeWidth={1.7} />
                ) : policy === 'auto' ? (
                  <Shield size={13} strokeWidth={1.7} />
                ) : (
                  <ShieldCheck size={13} strokeWidth={1.7} />
                )}
                {POLICY_LABEL[policy]}
                <ChevronDown size={13} strokeWidth={1.6} />
              </button>
              {policyOpen ? (
                <>
                  <div className="policy-backdrop" onClick={() => setPolicyOpen(false)} />
                  <div className="policy-menu" role="listbox" aria-label="批准方式">
                    {POLICY_OPTIONS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        role="option"
                        aria-selected={policy === option.id}
                        className="policy-item"
                        onClick={() => {
                          onPolicy(option.id);
                          setPolicyOpen(false);
                        }}
                      >
                        <span className="policy-icon">{option.icon}</span>
                        <span className="policy-text">
                          <strong>{option.title}</strong>
                          <em>{option.description}</em>
                        </span>
                        {policy === option.id ? <Check size={14} strokeWidth={1.8} className="policy-check" /> : null}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          </div>
          <div className="tb-right">
            <div className="model-wrap">
              <button
                type="button"
                className="tb-chip model"
                onClick={() => {
                  if (availableModels.length === 0) return;
                  if (!modelOpen) setModelView('root');
                  setModelOpen((open) => !open);
                }}
                aria-haspopup="listbox"
                aria-expanded={modelOpen}
                disabled={models.length === 0}
                title={models.length === 0 ? '还没有配置模型，去设置里添加' : activeModel ? `${activeModel.name} · ${activeModel.baseUrl}` : '切换模型'}
              >
                {activeModel?.model ?? '未配置模型'}
                <ChevronDown size={13} strokeWidth={1.6} />
              </button>
              {modelOpen && availableModels.length > 0 ? (
                <>
                  <div className="policy-backdrop" onClick={() => setModelOpen(false)} />
                  <div
                    className={`model-menu ${modelView === 'root' ? 'model-menu-root' : 'model-menu-sub'}`}
                    role="dialog"
                    aria-label="模型设置"
                  >
                    {modelView === 'root' ? (
                      <>
                        <button
                          type="button"
                          className="model-setting"
                          onClick={() => {
                            setModelView('models');
                            setModelQuery('');
                          }}
                        >
                          <span className="model-setting-label">模型</span>
                          <span className="model-setting-value">{activeModel?.model ?? '未配置模型'}</span>
                          <ChevronRight size={13} strokeWidth={1.7} />
                        </button>
                        {activeModel ? (
                          <button type="button" className="model-setting" onClick={() => setModelView('reasoning')}>
                            <span className="model-setting-label">推理等级</span>
                            <span className="model-setting-value">{reasoningLabel}</span>
                            <ChevronRight size={13} strokeWidth={1.7} />
                          </button>
                        ) : null}
                        {activeModel && activeModel.contextWindow > 0 && activeModel.contextWindowSource ? (
                          <button type="button" className="model-setting" onClick={() => setModelView('context')}>
                            <span className="model-setting-label">上下文窗口</span>
                            <span className="model-setting-value">{contextWindowLabel(activeModel.contextWindow)}</span>
                            <ChevronRight size={13} strokeWidth={1.7} />
                          </button>
                        ) : null}
                        {activeModel && activeModel.maxOutputTokens > 0 && activeModel.maxOutputTokensSource ? (
                          <button type="button" className="model-setting" onClick={() => setModelView('output')}>
                            <span className="model-setting-label">输出上限</span>
                            <span className="model-setting-value">{contextWindowLabel(activeModel.maxOutputTokens)}</span>
                            <ChevronRight size={13} strokeWidth={1.7} />
                          </button>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <div className="model-sub-head">
                          <button
                            type="button"
                            className="model-back"
                            onClick={() => setModelView('root')}
                            aria-label="返回"
                          >
                            <ChevronLeft size={14} strokeWidth={1.7} />
                          </button>
                          <span>
                            {modelView === 'models'
                              ? '选择模型'
                              : modelView === 'reasoning'
                                ? '推理等级'
                                : modelView === 'context'
                                  ? '上下文窗口'
                                  : '输出上限'}
                          </span>
                        </div>
                        {modelView === 'models' ? (
                          <>
                            <div className="model-search">
                              <Search size={12} strokeWidth={1.7} />
                              <input
                                autoFocus
                                value={modelQuery}
                                onChange={(event) => setModelQuery(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Escape') setModelView('root');
                                }}
                                placeholder="搜索模型…"
                                aria-label="搜索模型"
                              />
                            </div>
                            <div className="model-groups" role="listbox" aria-label="模型">
                              {modelGroups.map((group) => (
                                <div className="model-group" key={group.label}>
                                  <div className="model-group-label">{group.label}</div>
                                  {group.items.map((profile) => (
                                    <button
                                      key={profile.id}
                                      type="button"
                                      role="option"
                                      aria-selected={profile.id === activeModelId}
                                      className={`model-item ${profile.id === activeModelId ? 'active' : ''}`}
                                      onClick={() => {
                                        onSelectModel(profile.id);
                                        setModelView('root');
                                        setModelQuery('');
                                      }}
                                    >
                                      <span className="model-text">
                                        <strong>{profile.model}</strong>
                                        {profile.name && profile.name !== profile.model && profile.name.toLowerCase() !== group.label.toLowerCase() ? <em>{profile.name}</em> : null}
                                      </span>
                                      {profile.id === activeModelId ? <Check size={14} strokeWidth={1.8} className="policy-check" /> : null}
                                    </button>
                                  ))}
                                </div>
                              ))}
                              {modelGroups.length === 0 ? <div className="model-empty">没有匹配的模型</div> : null}
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="model-options" role="listbox" aria-label="模型设置">
                              {(modelView === 'reasoning'
                                ? REASONING_LEVELS.map((level) => ({
                                    key: level.value,
                                    label: level.label,
                                    active: (activeModel?.reasoningEffort ?? 'default') === level.value,
                                    run: () => {
                                      if (activeModel) onUpdateModel(activeModel.id, { reasoningEffort: level.value });
                                    },
                                  }))
                                : (modelView === 'context' ? contextWindows : outputLimits).map((value) => ({
                                    key: String(value),
                                    label: contextWindowLabel(value),
                                    active:
                                      modelView === 'context'
                                        ? value === activeModel?.contextWindow
                                        : value === activeModel?.maxOutputTokens,
                                    run: () => {
                                      if (!activeModel) return;
                                      if (modelView === 'context') {
                                        onUpdateModel(activeModel.id, {
                                          contextWindow: value,
                                          contextWindowSource: 'user',
                                        });
                                      } else {
                                        onUpdateModel(activeModel.id, {
                                          maxOutputTokens: value,
                                          maxOutputTokensSource: 'user',
                                        });
                                      }
                                    },
                                  }))
                              ).map((option) => (
                                <button
                                  key={option.key}
                                  type="button"
                                  role="option"
                                  aria-selected={option.active}
                                  className={`model-option ${option.active ? 'active' : ''}`}
                                  onClick={() => {
                                    option.run();
                                    setModelView('root');
                                  }}
                                >
                                  <span>{option.label}</span>
                                  {option.active ? <Check size={13} strokeWidth={1.9} /> : null}
                                </button>
                              ))}
                            </div>
                            {modelView === 'output' ? (
                              <p className="model-sub-note">
                                输出上限是本次请求的 max_tokens，包含思考、计入上下文窗口；4K–64K 只是常用预设，不是从模型查询到的最大值，具体以供应商文档为准。
                              </p>
                            ) : null}
                          </>
                        )}
                      </>
                    )}
                  </div>
                </>
              ) : null}
            </div>
            {running ? (
              <button type="button" className="send stop-mode" onClick={onStop} aria-label="停止生成" title="停止生成">
                <span className="stop-square" />
              </button>
            ) : (
              <button
                type="button"
                className="send"
                onClick={submit}
                disabled={blocked || value.trim().length === 0}
                aria-label="发送"
              >
                <ArrowUp size={16} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>
      </div>

      {referenceOpen ? (
        <>
          <div className="policy-backdrop" onClick={() => setReferenceOpen(false)} />
          <div className="reference-panel" role="dialog" aria-label="引用工作区文件">
            <div className="reference-head">
              <AtSign size={13} strokeWidth={1.7} />
              <input
                autoFocus
                value={fileQuery}
                onChange={(event) => setFileQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setReferenceOpen(false);
                  if (event.key === 'Enter' && filteredFiles[0]) {
                    event.preventDefault();
                    insertReference(filteredFiles[0].path);
                    setReferenceOpen(false);
                  }
                }}
                placeholder="搜索文件，回车引用"
                aria-label="搜索文件"
              />
            </div>
            <ul className="reference-list">
              {filteredFiles.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    onClick={() => {
                      insertReference(entry.path);
                      setReferenceOpen(false);
                    }}
                  >
                    <span className="mono">{entry.path}</span>
                  </button>
                </li>
              ))}
              {files && filteredFiles.length === 0 ? <li className="reference-empty">没有匹配的文件</li> : null}
              {!files ? <li className="reference-empty">读取文件列表…</li> : null}
            </ul>
          </div>
        </>
      ) : null}

      <div className="composer-meta">
        <button
          type="button"
          className="cm-item cm-workspace"
          title={`${meta.workspace} · 点击切换工作区`}
          onClick={(event) => onWorkspaceClick?.(event.currentTarget.getBoundingClientRect())}
        >
          <Folder size={11} strokeWidth={1.7} />
          {meta.workspace}
        </button>
        {meta.branch ? (
          <span className="cm-item" title="当前 git 分支">
            <GitBranch size={11} strokeWidth={1.7} />
            {meta.branch}
          </span>
        ) : null}
        <span className="cm-right">
          <span className="cm-item" title="会话轮次与执行步数">
            <RotateCw size={11} strokeWidth={1.7} />
            {meta.turns} 轮 {meta.steps} 步
          </span>
          <span className="cm-item" title="本会话累计 prompt + completion tokens">
            <Database size={11} strokeWidth={1.7} />
            {tokens(meta.tokens)} tok
          </span>
          {meta.cache && meta.cache.prompt > 0 ? (
            <span
              className="cm-item"
              title={`本会话 prompt 共 ${meta.cache.prompt.toLocaleString('en-US')} tokens，其中 ${meta.cache.cached.toLocaleString('en-US')} 由上游缓存命中（按量计费时这部分更便宜）`}
            >
              <Layers size={11} strokeWidth={1.7} />
              缓存命中 {((meta.cache.cached / meta.cache.prompt) * 100).toFixed(1)}%
            </span>
          ) : null}
          <ContextMeter gauge={context ?? null} percent={meta.percent} onOpen={onContextOpen} />
        </span>
      </div>
    </div>
  );
}
