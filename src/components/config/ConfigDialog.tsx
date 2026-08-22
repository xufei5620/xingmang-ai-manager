import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Terminal,
  X,
} from 'lucide-react'
import { maskedApiKey } from '../../app-shared'
import { resolveConfigModelDetectionSource } from '../../config-model-detection'
import { errorMessage } from '../../error-message'
import { localPathForDisplay } from '../../local-path-display'
import { configProvider, configTabMeta, type ConfigTabId } from '../../provider-meta'
import type {
  AccountBalance,
  AccountKey,
  AccountKeyCreateInput,
  AccountUsableGroup,
  AppConfigSummary,
  ConfigSaveMode,
  PlatformCapabilities,
  RelaySite,
  SystemSnapshot,
} from '../../types'
import { DialogBackdrop } from '../Dialog'
import { KeyEditorDialog } from '../account/KeyEditorDialog'
import { resolveAccountErrorMessage } from '../account/account-errors'
import { accountKeyStatusLabel } from '../account/account-center'
import { DiscardConfigChangesDialog } from './DiscardConfigChangesDialog'
import { OfficialAccountDialog } from './OfficialAccountDialog'
import { SaveModeDialog } from './SaveModeDialog'
import {
  officialAccountLabel,
  providerAccountSource,
  providerAccountSourceLabel,
} from '../../account-source'

export function ConfigDialog({
  platform,
  activeTab,
  config,
  snapshot,
  relaySite,
  accountAuthenticated,
  onConfigChange,
  onSettingsChange,
  onClose,
  notify,
  awaitCliReady,
}: {
  platform: PlatformCapabilities
  activeTab: ConfigTabId
  config: AppConfigSummary | null
  snapshot: SystemSnapshot
  relaySite: RelaySite
  accountAuthenticated: boolean
  onConfigChange: (config: AppConfigSummary) => void
  onSettingsChange: (settings: import('../../types').AppSettingsV2) => void
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
  const [modelsLoading, setModelsLoading] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [revealedApiKey, setRevealedApiKey] = useState('')
  const [apiKeyEdited, setApiKeyEdited] = useState(false)
  const [revealingKey, setRevealingKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveModeOpen, setSaveModeOpen] = useState(false)
  const [discardChangesOpen, setDiscardChangesOpen] = useState(false)
  const [keySource, setKeySource] = useState<'none' | 'configured' | 'manual' | `account:${number}`>('none')
  const [validatedKeySource, setValidatedKeySource] = useState<string | null>(null)
  const [accountKeys, setAccountKeys] = useState<AccountKey[]>([])
  const [accountKeysLoading, setAccountKeysLoading] = useState(false)
  const [accountKeysError, setAccountKeysError] = useState<string | null>(null)
  const [accountKeyGroups, setAccountKeyGroups] = useState<AccountUsableGroup[]>([])
  const [accountKeyGroupsLoading, setAccountKeyGroupsLoading] = useState(false)
  const [accountKeyGroupsError, setAccountKeyGroupsError] = useState<string | null>(null)
  const [accountBalance, setAccountBalance] = useState<AccountBalance | null>(null)
  const [keyEditorOpen, setKeyEditorOpen] = useState(false)
  const [keyEditorBusy, setKeyEditorBusy] = useState(false)
  const [officialAccountOpen, setOfficialAccountOpen] = useState(false)
  const [switchingAccount, setSwitchingAccount] = useState(false)
  const accountKeyRequestId = useRef(0)
  const accountGroupRequestId = useRef(0)

  // 只跟随标签页重置：config 引用会被后台扫描等操作频繁刷新，
  // 若一并作为依赖会清空用户正在输入的 API Key 和已检测的模型列表。
  useEffect(() => {
    setApiKey('')
    setModel(config?.providers[activeProvider].model ?? '')
    setAvailableModels([])
    setKeySource(config?.providers[activeProvider].hasApiKey ? 'configured' : accountAuthenticated ? 'none' : 'manual')
    setValidatedKeySource(null)
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

  useEffect(() => {
    if (keySource === 'none' && summary?.hasApiKey) setKeySource('configured')
  }, [keySource, summary?.hasApiKey])

  const configured = Boolean(summary?.hasApiKey && summary.matchesRelay)
  const selectedAccountKeyId = keySource.startsWith('account:')
    ? Number(keySource.slice('account:'.length))
    : null
  const selectedAccountKey = selectedAccountKeyId === null
    ? null
    : accountKeys.find((entry) => entry.id === selectedAccountKeyId) ?? null
  const modelDetectionSource = selectedAccountKeyId !== null
    ? selectedAccountKey?.status === 1
      ? { kind: 'account' as const, keyId: selectedAccountKeyId }
      : null
    : keySource === 'configured'
      ? resolveConfigModelDetectionSource('', Boolean(summary?.hasApiKey))
      : keySource === 'manual'
        ? resolveConfigModelDetectionSource(apiKey, false)
        : null
  const isDirty = summary ? (
    keySource.startsWith('account:')
    || (keySource === 'manual' && Boolean(apiKey.trim()))
    || model !== summary.model
  ) : false
  const normalizedApiKey = apiKey.trim()
  const keyAvailable = keySource === 'configured'
    ? Boolean(summary?.hasApiKey)
    : keySource.startsWith('account:')
      ? selectedAccountKey?.status === 1
      : keySource === 'manual' && Boolean(normalizedApiKey)
  const modelVerified = keyAvailable && (
    availableModels.length > 0
      ? validatedKeySource === keySource && availableModels.includes(model)
      : keySource === 'configured' && model === summary?.model
  )
  const toolStatus = activeTab === 'codexDesktop'
    ? snapshot.desktopApps.codex
    : snapshot.clis[activeProvider]
  const installed = toolStatus.installed
  const installDirectory = toolStatus.installDirectory
  const meta = configTabMeta(activeTab, platform)

  const loadAccountKeys = useCallback(async (): Promise<AccountKey[]> => {
    if (!accountAuthenticated) {
      setAccountKeys([])
      return []
    }
    const requestId = ++accountKeyRequestId.current
    setAccountKeysLoading(true)
    setAccountKeysError(null)
    try {
      const page = await window.xingmang.getAccountKeys({ page: 1, pageSize: 100 })
      if (accountKeyRequestId.current !== requestId) return []
      setAccountKeys(page.keys)
      return page.keys
    } catch (error) {
      if (accountKeyRequestId.current === requestId) {
        setAccountKeysError(resolveAccountErrorMessage(errorMessage(error)))
      }
      return []
    } finally {
      if (accountKeyRequestId.current === requestId) setAccountKeysLoading(false)
    }
  }, [accountAuthenticated])

  const loadAccountKeyGroups = useCallback(async () => {
    if (!accountAuthenticated) {
      setAccountKeyGroups([])
      return
    }
    const requestId = ++accountGroupRequestId.current
    setAccountKeyGroupsLoading(true)
    setAccountKeyGroupsError(null)
    try {
      const groups = await window.xingmang.getAccountUsableGroups()
      if (accountGroupRequestId.current === requestId) setAccountKeyGroups(groups)
    } catch (error) {
      if (accountGroupRequestId.current === requestId) {
        setAccountKeyGroupsError(resolveAccountErrorMessage(errorMessage(error)))
      }
    } finally {
      if (accountGroupRequestId.current === requestId) setAccountKeyGroupsLoading(false)
    }
  }, [accountAuthenticated])

  useEffect(() => {
    if (!accountAuthenticated) return undefined
    void loadAccountKeys()
    void loadAccountKeyGroups()
    let active = true
    void window.xingmang.getAccountBalance()
      .then((balance) => { if (active) setAccountBalance(balance) })
      .catch(() => undefined)
    return () => {
      active = false
      accountKeyRequestId.current += 1
      accountGroupRequestId.current += 1
    }
  }, [accountAuthenticated, loadAccountKeyGroups, loadAccountKeys])

  const selectKeySource = (source: typeof keySource) => {
    setKeySource(source)
    setAvailableModels([])
    setValidatedKeySource(null)
    setShowKey(source === 'manual')
    setRevealedApiKey('')
    if (source !== 'manual') {
      setApiKey('')
      setApiKeyEdited(false)
    }
  }

  const submitKeyEditor = async (values: AccountKeyCreateInput) => {
    if (keyEditorBusy) return
    setKeyEditorBusy(true)
    try {
      await window.xingmang.createAccountKey(values)
      const refreshed = await loadAccountKeys()
      const created = refreshed
        .filter((entry) => entry.name === values.name)
        .sort((left, right) => right.id - left.id)[0]
      if (created) selectKeySource(`account:${created.id}`)
      setKeyEditorOpen(false)
      notify({
        type: 'success',
        message: created
          ? `API Key「${values.name}」已创建并选中`
          : `API Key「${values.name}」已创建，请在列表中选择`,
      })
    } catch (error) {
      notify({ type: 'error', message: resolveAccountErrorMessage(errorMessage(error)) })
    } finally {
      setKeyEditorBusy(false)
    }
  }

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
    if (keyEditorOpen) {
      if (!keyEditorBusy) setKeyEditorOpen(false)
      return
    }
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
  }, [discardChangesOpen, isDirty, keyEditorBusy, keyEditorOpen, onClose, saveModeOpen])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [requestClose])

  const detectModels = async () => {
    const source = modelDetectionSource
    if (!source) {
      notify({ type: 'error', message: '请先选择或填写可用的 API Key' })
      return
    }
    setModelsLoading(true)
    try {
      // Codex CLI resolution is real filesystem/subprocess work; wait for the
      // first environment scan to settle so detecting models moments after
      // startup doesn't race it and see a spuriously cold "not installed".
      await awaitCliReady()
      const models = source.kind === 'typed'
        ? await window.xingmang.listModels(source.apiKey)
        : source.kind === 'configured'
          ? await window.xingmang.listConfiguredModels(activeProvider)
          : await window.xingmang.listAccountKeyModels(source.keyId)
      if (models.length === 0) throw new Error('所选 API Key 没有返回可用模型')
      setAvailableModels(models)
      setValidatedKeySource(keySource)
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
      const result = selectedAccountKeyId === null
        ? await window.xingmang.saveConfig({
            provider: activeProvider,
            apiKey: keySource === 'manual' ? apiKey : '',
            model,
            mode,
          })
        : await window.xingmang.saveConfigWithAccountKey({
            provider: activeProvider,
            keyId: selectedAccountKeyId,
            model,
            mode,
          })
      const next = await window.xingmang.getConfig()
      onConfigChange(next)
      onSettingsChange(await window.xingmang.getSettings())
      // 保存成功后回到「无未保存修改」状态，避免关闭弹窗时误弹放弃确认。
      setApiKey('')
      setAvailableModels([])
      setValidatedKeySource(null)
      setKeySource('configured')
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

  // 账号来源:星芒中转 ⇄ 用户自己的官方订阅。切回星芒不另做入口 ——
  // 就是上面那条既有的保存链路(填 Key + 检测模型 + 保存配置)。
  const accountSourceLabel = officialAccountLabel(activeProvider)
  const accountSource = providerAccountSource(summary)
  const switchToOfficialAccount = async () => {
    setSwitchingAccount(true)
    try {
      await window.xingmang.switchToOfficialAccount(activeProvider)
      onConfigChange(await window.xingmang.getConfig())
      onSettingsChange(await window.xingmang.getSettings())
      setOfficialAccountOpen(false)
      notify({ type: 'success', message: `已切换为你自己的${accountSourceLabel ?? '官方账号'}` })
    } catch (error) {
      notify({ type: 'error', message: errorMessage(error) })
    } finally {
      setSwitchingAccount(false)
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
              <label htmlFor={accountAuthenticated ? 'api-key-source' : 'api-key-input'}>
                {accountAuthenticated ? 'API Key 来源' : 'API Key'}
              </label>
              {accountAuthenticated ? (
                <span className="model-count">与账号 Key 管理实时同步</span>
              ) : (
                <button
                  type="button"
                  className="key-link-button"
                  onClick={() => void window.xingmang.openExternal(relaySite.keysPageUrl)}
                >
                  没有 Key？前往生成
                  <ExternalLink size={13} />
                </button>
              )}
            </div>
            {accountAuthenticated && (
              <div className="config-key-source-picker">
                <select
                  id="api-key-source"
                  value={keySource}
                  onChange={(event) => selectKeySource(event.target.value as typeof keySource)}
                >
                  {!summary?.hasApiKey && <option value="none">请选择 API Key</option>}
                  {summary?.hasApiKey && (
                    <option value="configured">当前 CLI 配置 · {summary.apiKeyPreview ?? '已保存'}</option>
                  )}
                  {accountKeys.length > 0 && (
                    <optgroup label="账号 API Key">
                      {accountKeys.map((entry) => (
                        <option key={entry.id} value={`account:${entry.id}`} disabled={entry.status !== 1}>
                          {entry.name} · {entry.group || '默认分组'} · {entry.maskedKey || accountKeyStatusLabel(entry.status)}
                          {entry.status === 1 ? '' : ` · ${accountKeyStatusLabel(entry.status)}`}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <option value="manual">手动输入其他 Key</option>
                </select>
                <button
                  type="button"
                  className="secondary-button config-create-key-button"
                  onClick={() => setKeyEditorOpen(true)}
                >
                  <Plus size={15} /> 新建 Key
                </button>
              </div>
            )}
            {accountKeysLoading && accountAuthenticated && (
              <small className="field-hint"><LoaderCircle size={13} className="spin" /> 正在读取账号 Key</small>
            )}
            {accountKeysError && accountAuthenticated && (
              <small className="field-error config-key-source-error" role="alert">
                {accountKeysError}
                <button type="button" onClick={() => void loadAccountKeys()}><RefreshCw size={13} /> 重试</button>
              </small>
            )}
            {(!accountAuthenticated || keySource === 'manual') && (
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
                    setKeySource('manual')
                    setAvailableModels([])
                    setValidatedKeySource(null)
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
            )}
          </div>

          <div className="field full-field">
            <div className="field-label-row">
              <label htmlFor="model-select">使用模型</label>
              <span className="model-count">
                {modelsLoading
                  ? '正在查询可用模型'
                  : availableModels.length
                    ? `已检测 ${availableModels.length} 个模型`
                    : keyAvailable ? '点击检测后可切换模型' : '请先选择 API Key'}
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
                disabled={modelsLoading || !modelDetectionSource}
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

        {accountSourceLabel && (
          <div className="account-source">
            <div className="account-source-text">
              <strong>
                账号来源：<span className="account-source-current">{providerAccountSourceLabel(accountSource, activeProvider)}</span>
              </strong>
              <p>
                {accountSource === 'relay'
                  ? `也可以切回你自己的${accountSourceLabel}，用你自己的订阅额度；你的登录状态不受影响，随时能切回星芒。`
                  : accountSource === 'unknown'
                    ? '当前指向的不是星芒中转地址，为避免改坏你自己的配置，这里不提供一键切换。'
                    : `当前用的是你自己的${accountSourceLabel}。想用星芒额度，在上方填好 Key 并保存配置即可切回。`}
              </p>
            </div>
            {accountSource === 'relay' && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => setOfficialAccountOpen(true)}
              >切换为我的{accountSourceLabel}</button>
            )}
          </div>
        )}

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
      {officialAccountOpen && accountSourceLabel && (
        <OfficialAccountDialog
          provider={activeProvider}
          label={accountSourceLabel}
          busy={switchingAccount}
          onConfirm={() => void switchToOfficialAccount()}
          onCancel={() => setOfficialAccountOpen(false)}
        />
      )}
      {keyEditorOpen && (
        <KeyEditorDialog
          mode="create"
          groups={accountKeyGroups}
          groupsLoading={accountKeyGroupsLoading}
          groupsError={accountKeyGroupsError}
          onRetryGroups={() => void loadAccountKeyGroups()}
          quotaPerUnit={accountBalance?.quotaPerUnit}
          onClose={() => { if (!keyEditorBusy) setKeyEditorOpen(false) }}
          onSubmit={(values) => void submitKeyEditor(values)}
          isSubmitting={keyEditorBusy}
        />
      )}
    </DialogBackdrop>
  )
}
