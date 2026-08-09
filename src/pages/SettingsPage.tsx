import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Check, Compass, Globe2, LoaderCircle, Moon, Save, Settings, Sun } from 'lucide-react'
import { errorMessage } from '../error-message'
import { relaySites, resolveRelaySite } from '../types'

export type SettingsTheme = 'light' | 'dark'

export interface SettingsV2 {
  version: 2
  workspace: string
  theme: SettingsTheme
  checkUpdatesOnStartup: boolean
  runDiagnosticsOnStartup: boolean
  /**
   * Which relay-sites.ts RelaySite the CLIs should be configured against
   * (W3b). Absent = the default site, same "缺省 = 旧行为" contract as
   * AppSettings.relaySiteId itself (electron/app-settings.ts) -- this page
   * always resolves it through resolveRelaySite() for display, never reads
   * it raw, so a stale/unknown id degrades to the default option instead of
   * rendering a blank <select>.
   */
  relaySiteId?: string
}

export interface SettingsPageProps {
  value: SettingsV2
  onSave(settings: SettingsV2): Promise<void>
  onThemePreview?(theme: SettingsTheme): void
  /** Switches the app back to the onboarding flow (`appView = 'onboarding'`). In-memory only — see App.tsx. */
  onReplayOnboarding(): void
}

export interface SettingsDraftState {
  saved: SettingsV2
  draft: SettingsV2
}

export function settingsEqual(left: SettingsV2, right: SettingsV2): boolean {
  return left.version === right.version
    && left.workspace === right.workspace
    && left.theme === right.theme
    && left.checkUpdatesOnStartup === right.checkUpdatesOnStartup
    && left.runDiagnosticsOnStartup === right.runDiagnosticsOnStartup
    && left.relaySiteId === right.relaySiteId
}

export function reconcileSettingsDraft(
  current: SettingsDraftState,
  persisted: SettingsV2,
): SettingsDraftState {
  if (settingsEqual(current.saved, persisted)) return current
  // theme 与 version 始终跟随 persisted（侧边栏是主题的权威通道），
  // 其余字段的未保存草稿不能因外部变更被静默丢弃。
  const draft = { ...persisted }
  const carryUnsavedField = <Key extends 'workspace' | 'checkUpdatesOnStartup' | 'runDiagnosticsOnStartup' | 'relaySiteId'>(
    key: Key,
  ) => {
    if (current.draft[key] !== current.saved[key]) draft[key] = current.draft[key]
  }
  for (const key of ['workspace', 'checkUpdatesOnStartup', 'runDiagnosticsOnStartup', 'relaySiteId'] as const) {
    carryUnsavedField(key)
  }
  return { saved: persisted, draft }
}

function SettingSwitch({
  checked,
  title,
  description,
  disabled,
  onChange,
}: {
  checked: boolean
  title: string
  description: string
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="operation-row setting-switch-row">
      <span className="operation-row-copy">
        <strong>{title}</strong>
        <p>{description}</p>
      </span>
      <span className="setting-switch-control">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
        <span aria-hidden="true"><Check size={12} /></span>
      </span>
    </label>
  )
}

export function SettingsPage({ value, onSave, onThemePreview, onReplayOnboarding }: SettingsPageProps) {
  const [settingsState, setSettingsState] = useState<SettingsDraftState>(() => ({
    saved: value,
    draft: value,
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { saved, draft } = settingsState

  useEffect(() => {
    setSettingsState((current) => reconcileSettingsDraft(current, value))
  }, [value])

  const dirty = useMemo(() => !settingsEqual(draft, saved), [draft, saved])
  const update = <Key extends keyof SettingsV2>(key: Key, next: SettingsV2[Key]) => {
    setSettingsState((current) => ({
      ...current,
      draft: { ...current.draft, [key]: next },
    }))
  }

  const selectTheme = (theme: SettingsTheme) => {
    update('theme', theme)
    onThemePreview?.(theme)
  }

  const save = async () => {
    const submitted = draft
    setSaving(true)
    setError(null)
    try {
      await onSave(submitted)
      setSettingsState((current) => ({ ...current, saved: submitted }))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page workspace-page operations-page" data-page-id="settings">
      <header className="page-header workspace-page-header">
        <div>
          <div className="eyebrow">PREFERENCES</div>
          <h1>设置</h1>
        </div>
        <div className="header-actions page-toolbar" role="toolbar" aria-label="设置工具栏">
          <button className="primary-button" type="button" onClick={save} disabled={!dirty || saving}>
            {saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
            {saving ? '保存中' : '保存设置'}
          </button>
        </div>
      </header>

      {error && <div className="operation-error" role="alert"><AlertCircle size={16} />{error}</div>}

      <section className="environment-section settings-section" aria-labelledby="appearance-title">
        <div className="section-heading">
          <div>
            <h2 id="appearance-title">外观</h2>
            <span>主窗口和标题栏使用同一套主题</span>
          </div>
        </div>
        <div className="setting-theme-control" role="group" aria-label="主题">
          <button className={`setting-theme-option ${draft.theme === 'dark' ? 'is-active' : ''}`} type="button" onClick={() => selectTheme('dark')} disabled={saving} aria-pressed={draft.theme === 'dark'}>
            <Moon size={18} />
            <span><strong>深色</strong><small>默认外观</small></span>
          </button>
          <button className={`setting-theme-option ${draft.theme === 'light' ? 'is-active' : ''}`} type="button" onClick={() => selectTheme('light')} disabled={saving} aria-pressed={draft.theme === 'light'}>
            <Sun size={18} />
            <span><strong>浅色</strong><small>明亮外观</small></span>
          </button>
        </div>
      </section>

      <section className="environment-section settings-section" aria-labelledby="startup-title">
        <div className="section-heading">
          <div>
            <h2 id="startup-title">启动与安全</h2>
            <span>v2 本机设置</span>
          </div>
        </div>
        <div className="operations-list">
          <SettingSwitch
            checked={draft.checkUpdatesOnStartup}
            title="启动时检查主程序更新"
            description="发现新版本后显示下载进度并自动完成更新"
            disabled={saving}
            onChange={(checked) => update('checkUpdatesOnStartup', checked)}
          />
          <SettingSwitch
            checked={draft.runDiagnosticsOnStartup}
            title="启动时运行健康诊断"
            description="读取本机环境与配置摘要，不修改系统状态"
            disabled={saving}
            onChange={(checked) => update('runDiagnosticsOnStartup', checked)}
          />
        </div>
      </section>

      <section className="environment-section settings-section settings-storage" aria-labelledby="storage-title">
        <div className="section-heading">
          <div>
            <h2 id="storage-title">本机设置</h2>
            <span>设置版本 {draft.version}</span>
          </div>
        </div>
        <div className="operation-row">
          <div className="operation-status-icon"><Settings size={17} /></div>
          <div className="operation-row-copy">
            <strong>CLI 默认工作目录</strong>
            <p>{draft.workspace}</p>
          </div>
        </div>
      </section>

      <section className="environment-section settings-section" aria-labelledby="relay-site-title">
        <div className="section-heading">
          <div>
            <h2 id="relay-site-title">服务站点</h2>
            <span>CLI 配置写入哪个中转站点</span>
          </div>
        </div>
        <div className="operation-row settings-relay-site-row">
          <div className="operation-status-icon"><Globe2 size={17} /></div>
          <div className="operation-row-copy">
            <strong>中转站点</strong>
            <p>切换后，新保存的 CLI 配置将指向该站点；已配置的 CLI 需重新保存一次配置生效</p>
          </div>
          <select
            className="settings-relay-site-select"
            value={resolveRelaySite(draft.relaySiteId).id}
            disabled={saving}
            onChange={(event) => update('relaySiteId', event.target.value)}
            aria-label="服务站点"
          >
            {relaySites.map((site) => (
              <option key={site.id} value={site.id}>{site.label}</option>
            ))}
          </select>
        </div>
      </section>

      <section className="environment-section settings-section" aria-labelledby="onboarding-title">
        <div className="section-heading">
          <div>
            <h2 id="onboarding-title">新手引导</h2>
            <span>随时重新走一遍工具选择与授权配置</span>
          </div>
        </div>
        <div className="operation-row">
          <div className="operation-status-icon"><Compass size={17} /></div>
          <div className="operation-row-copy">
            <strong>重新查看新手引导</strong>
            <p>重新走一遍工具选择、授权码填写与环境安装的引导流程</p>
          </div>
          <button className="secondary-button" type="button" onClick={onReplayOnboarding}>
            <Compass size={15} />
            重新查看
          </button>
        </div>
      </section>
    </div>
  )
}
