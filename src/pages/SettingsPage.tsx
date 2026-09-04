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
  /**
   * Pinned download-source order（IMPROVEMENT-PLAN 2.4）。Absent = 自动
   * （探测网络区域），与 AppSettings.mirrorPolicy 同一份"缺省 = 旧行为"
   * 契约；本页用 'auto' 字面量表达缺省态，保存时归一回 absent。
   */
  mirrorPolicy?: 'mirror-first' | 'official-first'
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
    && left.mirrorPolicy === right.mirrorPolicy
}

export function reconcileSettingsDraft(
  current: SettingsDraftState,
  persisted: SettingsV2,
): SettingsDraftState {
  if (settingsEqual(current.saved, persisted)) return current
  // theme 与 version 始终跟随 persisted（侧边栏是主题的权威通道），
  // 其余字段的未保存草稿不能因外部变更被静默丢弃。
  const draft = { ...persisted }
  const carryUnsavedField = <Key extends 'workspace' | 'checkUpdatesOnStartup' | 'runDiagnosticsOnStartup' | 'relaySiteId' | 'mirrorPolicy'>(
    key: Key,
  ) => {
    if (current.draft[key] !== current.saved[key]) draft[key] = current.draft[key]
  }
  for (const key of ['workspace', 'checkUpdatesOnStartup', 'runDiagnosticsOnStartup', 'relaySiteId', 'mirrorPolicy'] as const) {
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
          <h1>设置</h1>
          <p className="page-lead">改主题、工作目录和启动项。</p>
        </div>
        <div className="header-actions page-toolbar" role="toolbar" aria-label="设置工具栏">
          <button className="primary-button" type="button" onClick={save} disabled={!dirty || saving}>
            {saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
            {saving ? '保存中' : '保存'}
          </button>
        </div>
      </header>

      {error && <div className="operation-error" role="alert"><AlertCircle size={16} />{error}</div>}

      <section className="environment-section settings-section" aria-labelledby="appearance-title">
        <div className="section-heading">
          <div>
            <h2 id="appearance-title">外观</h2>
            <span>窗口用深色还是浅色</span>
          </div>
        </div>
        <div className="setting-theme-control" role="group" aria-label="主题">
          <button className={`setting-theme-option ${draft.theme === 'dark' ? 'is-active' : ''}`} type="button" onClick={() => selectTheme('dark')} disabled={saving} aria-pressed={draft.theme === 'dark'}>
            <Moon size={18} />
            <span><strong>深色</strong><small>暗一点，晚上更好看</small></span>
          </button>
          <button className={`setting-theme-option ${draft.theme === 'light' ? 'is-active' : ''}`} type="button" onClick={() => selectTheme('light')} disabled={saving} aria-pressed={draft.theme === 'light'}>
            <Sun size={18} />
            <span><strong>浅色</strong><small>亮一点，白天更好看</small></span>
          </button>
        </div>
      </section>

      <section className="environment-section settings-section" aria-labelledby="startup-title">
        <div className="section-heading">
          <div>
            <h2 id="startup-title">开机时做什么</h2>
            <span>打开软件时自动做这些事</span>
          </div>
        </div>
        <div className="operations-list">
          <SettingSwitch
            checked={draft.checkUpdatesOnStartup}
            title="开机检查更新"
            description="有新版本就提示下载"
            disabled={saving}
            onChange={(checked) => update('checkUpdatesOnStartup', checked)}
          />
          <SettingSwitch
            checked={draft.runDiagnosticsOnStartup}
            title="开机做一次检查"
            description="只看环境，不改你的电脑"
            disabled={saving}
            onChange={(checked) => update('runDiagnosticsOnStartup', checked)}
          />
        </div>
      </section>

      <section className="environment-section settings-section settings-storage" aria-labelledby="storage-title">
        <div className="section-heading">
          <div>
            <h2 id="storage-title">打开工具时的文件夹</h2>
            <span>命令行工具默认进这个目录</span>
          </div>
        </div>
        <div className="operation-row">
          <div className="operation-status-icon"><Settings size={17} /></div>
          <div className="operation-row-copy">
            <strong>默认文件夹</strong>
            <p>{draft.workspace}</p>
          </div>
        </div>
      </section>

      <section className="environment-section settings-section" aria-labelledby="relay-site-title">
        <div className="section-heading">
          <div>
            <h2 id="relay-site-title">连哪台服务器</h2>
            <span>一般不用改，用默认就行</span>
          </div>
        </div>
        <div className="operation-row settings-relay-site-row">
          <div className="operation-status-icon"><Globe2 size={17} /></div>
          <div className="operation-row-copy">
            <strong>服务站点</strong>
            <p>换站点后，已装好的工具要再保存一次配置才会生效</p>
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

      <section className="environment-section settings-section" aria-labelledby="mirror-policy-title">
        <div className="section-heading">
          <div>
            <h2 id="mirror-policy-title">从哪里下载</h2>
            <span>装工具慢或失败时再改这里</span>
          </div>
        </div>
        <div className="operation-row settings-relay-site-row">
          <div className="operation-status-icon"><Globe2 size={17} /></div>
          <div className="operation-row-copy">
            <strong>下载顺序</strong>
            <p>自动会按网络选；两个源都会试，这里只改谁先谁后</p>
          </div>
          <select
            className="settings-relay-site-select"
            value={draft.mirrorPolicy ?? 'auto'}
            disabled={saving}
            onChange={(event) => update(
              'mirrorPolicy',
              event.target.value === 'auto' ? undefined : event.target.value as 'mirror-first' | 'official-first',
            )}
            aria-label="镜像策略"
          >
            <option value="auto">自动（推荐）</option>
            <option value="mirror-first">国内源优先</option>
            <option value="official-first">官方源优先</option>
          </select>
        </div>
      </section>

      <section className="environment-section settings-section" aria-labelledby="onboarding-title">
        <div className="section-heading">
          <div>
            <h2 id="onboarding-title">新手引导</h2>
            <span>想再看一遍安装步骤，点这里</span>
          </div>
        </div>
        <div className="operation-row">
          <div className="operation-status-icon"><Compass size={17} /></div>
          <div className="operation-row-copy">
            <strong>再走一遍新手引导</strong>
            <p>从选工具、填授权到装环境，重新带你过一遍</p>
          </div>
          <button className="secondary-button" type="button" onClick={onReplayOnboarding}>
            <Compass size={15} />
            再走一遍
          </button>
        </div>
      </section>
    </div>
  )
}
