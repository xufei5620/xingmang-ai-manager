import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AppWindow,
  ChevronRight,
  Eye,
  EyeOff,
  ExternalLink,
  FileCheck2,
  FileWarning,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  Save,
  ShieldCheck,
  Terminal,
  X,
} from 'lucide-react'
import { maskedApiKey } from '../../app-shared'
import { errorMessage } from '../../error-message'
import { localPathForDisplay } from '../../local-path-display'
import { configProvider, configTabMeta, type ConfigTabId } from '../../provider-meta'
import type {
  AppConfigSummary,
  ConfigSaveMode,
  PlatformCapabilities,
  RelaySite,
  SystemSnapshot,
} from '../../types'
import { DialogBackdrop } from '../Dialog'
import { DiscardConfigChangesDialog } from './DiscardConfigChangesDialog'
import { SaveModeDialog } from './SaveModeDialog'

export function ConfigDialog({
  platform,
  activeTab,
  config,
  snapshot,
  relaySite,
  onConfigChange,
  onClose,
  notify,
  awaitCliReady,
}: {
  platform: PlatformCapabilities
  activeTab: ConfigTabId
  config: AppConfigSummary | null
  snapshot: SystemSnapshot
  relaySite: RelaySite
  onConfigChange: (config: AppConfigSummary) => void
  onClose: () => void
  notify: (toast: { type: 'success' | 'error'; message: string }) => void
  /** Resolves once the app's first environment scan has settled; see startup-gate.ts. */
  awaitCliReady: () => Promise<void>
}) {
  const activeProvider = configProvider(activeTab)
  const summary = config?.providers[activeProvider]
  // Empty input is an explicit sentinel: the main process reuses the existing key.
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [validatedApiKey, setValidatedApiKey] = useState<string | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [revealedApiKey, setRevealedApiKey] = useState('')
  const [apiKeyEdited, setApiKeyEdited] = useState(false)
  const [revealingKey, setRevealingKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveModeOpen, setSaveModeOpen] = useState(false)
  const [discardChangesOpen, setDiscardChangesOpen] = useState(false)

  // 只跟随标签页重置：config 引用会被后台扫描等操作频繁刷新，
  // 若一并作为依赖会清空用户正在输入的 API Key 和已检测的模型列表。
  useEffect(() => {
    setApiKey('')
    setModel(config?.providers[activeProvider].model ?? '')
    setAvailableModels([])
    setValidatedApiKey(null)
    setShowKey(false)
    setRevealedApiKey('')
    setApiKeyEdited(false)
    setRevealingKey(false)
    setDiscardChangesOpen(false)
  }, [activeProvider])

  const modelOptions = useMemo(() => {
    if (model && !availableModels.includes(model)) return [model, ...availableModels]
    return availableModels
  }, [availableModels, model])

  // config 晚于弹窗打开才就绪时补同步 model 显示值；一旦开始输入或已检测模型就不再覆盖。
  useEffect(() => {
    if (apiKey.trim() || availableModels.length) return
    const nextModel = config?.providers[activeProvider].model ?? ''
    setModel((current) => current === nextModel ? current : nextModel)
  }, [activeProvider, apiKey, availableModels, config])

  const configured = Boolean(summary?.hasApiKey && summary.matchesRelay)
  const isDirty = summary ? (
    Boolean(apiKey.trim())
    || model !== summary.model
  ) : false
  const normalizedApiKey = apiKey.trim()
  const keyVerified = normalizedApiKey
    ? validatedApiKey === normalizedApiKey
    : Boolean(summary?.hasApiKey)
  const modelVerified = keyVerified && (
    availableModels.length > 0
      ? availableModels.includes(model)
      : !normalizedApiKey && Boolean(summary?.hasApiKey) && model === summary?.model
  )
  const toolStatus = activeTab === 'codexDesktop'
    ? snapshot.desktopApps.codex
    : snapshot.clis[activeProvider]
  const installed = toolStatus.installed
  const installDirectory = toolStatus.installDirectory
  const meta = configTabMeta(activeTab, platform)

  const toggleApiKeyVisibility = async () => {
    if (showKey) {
      setShowKey(false)
      setRevealedApiKey('')
      return
    }
    if (apiKeyEdited || apiKey || !summary?.hasApiKey) {
      setShowKey(true)
      return
    }
    setRevealingKey(true)
    try {
      const savedApiKey = await window.xingmang.revealApiKey(activeProvider)
      if (!savedApiKey) throw new Error('未读取到已保存的 API Key')
      setRevealedApiKey(savedApiKey)
      setShowKey(true)
    } catch (error) {
      notify({ type: 'error', message: errorMessage(error) })
    } finally {
      setRevealingKey(false)
    }
  }

  const requestClose = useCallback(() => {
    if (saveModeOpen) {
      setSaveModeOpen(false)
      return
    }
    if (discardChangesOpen) {
      setDiscardChangesOpen(false)
      return
    }
    if (isDirty) {
      setDiscardChangesOpen(true)
      return
    }
    onClose()
  }, [discardChangesOpen, isDirty, onClose, saveModeOpen])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [requestClose])

  const detectModels = async () => {
    if (!apiKey.trim()) {
      notify({ type: 'error', message: '请先填写 API Key' })
      return
    }
    setModelsLoading(true)
    try {
      // Codex CLI resolution is real filesystem/subprocess work; wait for the
      // first environment scan to settle so detecting models moments after
      // startup doesn't race it and see a spuriously cold "not installed".
      await awaitCliReady()
      const models = await window.xingmang.listModels(apiKey)
      setAvailableModels(models)
      setValidatedApiKey(apiKey.trim())
      if (!models.includes(model) && models[0]) setModel(models[0])
      notify({ type: 'success', message: `检测到 ${models.length} 个可用模型` })
    } catch (error) {
      notify({ type: 'error', message: errorMessage(error) })
    } finally {
      setModelsLoading(false)
    }
  }

  const persistConfig = async (mode: ConfigSaveMode) => {
    if (!modelVerified) {
      notify({ type: 'error', message: '请先检测当前 API Key，并选择该 Key 可用的模型' })
      return
    }
    setSaveModeOpen(false)
    setSaving(true)
    try {
      const result = await window.xingmang.saveConfig({
        provider: activeProvider,
        apiKey,
        model,
        mode,
      })
      const next = await window.xingmang.getConfig()
      onConfigChange(next)
      // 保存成功后回到「无未保存修改」状态，避免关闭弹窗时误弹放弃确认。
      setApiKey('')
      setAvailableModels([])
      setValidatedApiKey(null)
      setShowKey(false)
      setRevealedApiKey('')
      setApiKeyEdited(false)
      notify({
        type: 'success',
        message: result.backups.length
          ? mode === 'merge'
            ? `${meta.name} 已备份 ${result.backups.length} 个文件并更新 API Key 和模型`
            : `${meta.name} 已备份 ${result.backups.length} 个文件并恢复初始配置`
          : `${meta.name} 配置文件已创建`,
      })
    } catch (error) {
      notify({ type: 'error', message: errorMessage(error) })
    } finally {
      setSaving(false)
    }
  }

  const save = async () => {
    try {
      const latestConfig = await window.xingmang.getConfig()
      if (latestConfig.providers[activeProvider].exists) {
        setSaveModeOpen(true)
        return
      }
      await persistConfig('reset')
    } catch (error) {
      notify({ type: 'error', message: errorMessage(error) })
    }
  }

  return (
    <DialogBackdrop className="config-modal-backdrop" onDismiss={requestClose}>
      <section className="config-dialog" role="dialog" aria-modal="true" aria-labelledby="config-dialog-title">
        <header className="config-dialog-head">
          <div className="config-dialog-identity">
            <div className="provider-icon large" style={{ color: meta.color, backgroundColor: meta.tint }}>
              <img src={meta.icon} alt="" aria-hidden="true" />
            </div>
          <div>
              <h2 id="config-dialog-title">{meta.name} 配置</h2>
            <div className="command-line">
              {activeTab === 'codexDesktop' ? <AppWindow size={14} /> : <Terminal size={14} />}
              <code>{meta.command}</code>
              <span>·</span>
              <span>{installed ? `${activeTab === 'codexDesktop' ? '桌面端' : 'CLI'} 已安装` : `${activeTab === 'codexDesktop' ? '桌面端' : 'CLI'} 未安装`}</span>
              {activeTab === 'codexDesktop' && <><span>·</span><span>与 Codex CLI 共用配置</span></>}
            </div>
          </div>
          </div>
          <div className="config-dialog-head-actions">
            <div className={configured ? 'readiness ready' : 'readiness blocked'}>
              <span />
              {configured ? '星芒 AI 已配置' : summary?.exists ? '需要重新配置' : '尚未创建配置'}
            </div>
            <button className="icon-button" type="button" title="关闭配置" aria-label="关闭配置" onClick={requestClose}>
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="form-grid">
          <div className="field full-field">
            <div className="field-label-row">
              <label htmlFor="api-key-input">API Key</label>
              <button
                type="button"
                className="key-link-button"
                onClick={() => void window.xingmang.openExternal(relaySite.keysPageUrl)}
              >
                没有 Key？前往生成
                <ExternalLink size={13} />
              </button>
            </div>
            <div className="input-with-action">
              <input
                id="api-key-input"
                type="text"
                value={showKey
                  ? apiKeyEdited ? apiKey : apiKey || revealedApiKey
                  : maskedApiKey(apiKey || summary?.apiKeyPreview || '')}
                onChange={(event) => {
                  setApiKey(event.target.value)
                  setApiKeyEdited(true)
                  setAvailableModels([])
                  setValidatedApiKey(null)
                }}
                onFocus={() => {
                  if (!summary?.hasApiKey && !showKey) setShowKey(true)
                }}
                onBlur={() => {
                  // 未输入新 Key 时失焦恢复掩码，保留已保存 Key 的预览。
                  if (!apiKeyEdited || !apiKey) {
                    setShowKey(false)
                    setRevealedApiKey('')
                  }
                }}
                placeholder="sk-..."
                spellCheck={false}
                autoComplete="off"
                readOnly={!showKey}
              />
              <button
                type="button"
                title={revealingKey ? '正在读取 API Key' : showKey ? '隐藏 API Key' : '显示 API Key'}
                onClick={() => void toggleApiKeyVisibility()}
                disabled={revealingKey}
              >
                {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
          </div>

          <div className="field full-field">
            <div className="field-label-row">
              <label htmlFor="model-select">使用模型</label>
              <span className="model-count">
                {modelsLoading
                  ? '正在查询可用模型'
                  : availableModels.length
                    ? `已检测 ${availableModels.length} 个模型`
                    : keyVerified ? '当前配置已验证' : '请检测当前 API Key'}
              </span>
            </div>
            <div className="model-picker">
              <select
                id="model-select"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={modelsLoading || modelOptions.length === 0}
              >
                {modelOptions.length === 0 && <option value="">请先检测可用模型</option>}
                {modelOptions.map((modelId) => <option value={modelId} key={modelId}>{modelId}</option>)}
              </select>
              <button
                type="button"
                className="secondary-button detect-models-button"
                disabled={modelsLoading || !apiKey.trim()}
                onClick={() => void detectModels()}
              >
                <RefreshCw size={16} className={modelsLoading ? 'spin' : ''} />
                {modelsLoading ? '检测中' : '检测模型'}
              </button>
            </div>
          </div>

        </div>

        <div className="native-file-list installation-directory-list">
          <div className="native-file-label">安装目录</div>
          <div className="native-files">
            <div className="native-file installation-directory">
              <FolderOpen size={15} />
              <code title={localPathForDisplay(installDirectory) || undefined}>
                {localPathForDisplay(installDirectory) || '未识别到安装目录'}
              </code>
              <span className={installDirectory ? 'file-state exists' : 'file-state'}>
                {installDirectory ? '已识别' : '未识别'}
              </span>
            </div>
          </div>
        </div>

        <div className="native-file-list data-directory-list">
          <div className="native-file-label">数据目录</div>
          <div className="native-files">
            <div className="native-file data-directory">
              <FolderOpen size={15} />
              <code title={localPathForDisplay(summary?.dataDirectory) || undefined}>
                {localPathForDisplay(summary?.dataDirectory) || '未识别到数据目录'}
              </code>
              <span className={summary?.dataDirectoryExists ? 'file-state exists' : 'file-state'}>
                {summary?.dataDirectoryExists ? '已识别' : '未创建'}
              </span>
            </div>
          </div>
        </div>

        <div className="native-file-list config-file-list">
          <div className="native-file-label">配置文件</div>
          <div className="native-files">
            {summary?.files.map((file) => (
              <div className="native-file" key={file.path}>
                {file.exists ? <FileCheck2 size={15} /> : <FileWarning size={15} />}
                <code title={localPathForDisplay(file.path)}>{localPathForDisplay(file.path)}</code>
                <span className={file.exists ? 'file-state exists' : 'file-state'}>
                  {file.exists ? '已存在' : '未创建'}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="config-actions">
          <button className="primary-button" onClick={() => void save()} disabled={saving || !isDirty || !modelVerified}>
            {saving ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}
            保存配置
          </button>
        </div>

        <div className="config-summary-bar">
          <div><ShieldCheck size={16} />API Key 写入 CLI 原生配置</div>
          <ChevronRight size={16} />
          <div>覆盖前自动创建时间戳备份</div>
        </div>
      </section>
      {saveModeOpen && (
        <SaveModeDialog
          onSelect={(mode) => void persistConfig(mode)}
          onCancel={() => setSaveModeOpen(false)}
        />
      )}
      {discardChangesOpen && (
        <DiscardConfigChangesDialog
          onDiscard={onClose}
          onCancel={() => setDiscardChangesOpen(false)}
        />
      )}
    </DialogBackdrop>
  )
}
