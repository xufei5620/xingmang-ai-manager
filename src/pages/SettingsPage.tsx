import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AlertCircle, ArrowUpRight, Bell, Check, Compass, FolderOpen, Globe2, Info, LoaderCircle, Moon, Palette, Power, Save, ShieldCheck, Sun, UserRound, Wrench } from 'lucide-react'
import { errorMessage } from '../error-message'
import { relaySites, resolveRelaySite, type AppSettingsV2, type AppSettingsV2Update } from '../types'
import brandSymbol from '../../assets/brand/v3/symbol-standard.svg'
import { useNavigationState } from '../components/shell/NavigationState'
import './settings-page.css'

export type SettingsTheme = 'light' | 'dark'
export type SettingsV2 = Pick<AppSettingsV2,
  'version' | 'workspace' | 'theme' | 'checkUpdatesOnStartup' | 'runDiagnosticsOnStartup'
  | 'relaySiteId' | 'mirrorPolicy' | 'uiSkin' | 'reducedMotion' | 'uiScale' | 'closeBehavior' | 'desktopNotifications'>
export type SettingsAppearance = Pick<SettingsV2, 'uiSkin' | 'reducedMotion'>
export type SettingsNavigationTarget = 'account' | 'backups' | 'feedback' | 'update' | 'health'

export interface SettingsPageProps {
  value: SettingsV2
  onSave(settings: SettingsV2): Promise<void>
  onSavePatch?(update: AppSettingsV2Update): Promise<void>
  onThemePreview?(theme: SettingsTheme): void
  onAppearancePreview?(appearance: SettingsAppearance): void
  onChooseWorkspace?(): Promise<string | null>
  onNavigate?(target: SettingsNavigationTarget): void
  onReplayOnboarding(): void
  appVersion?: string
  trayAvailable?: boolean
  desktopNotificationsSupported?: boolean
  initialSection?: SettingsSectionId
}

export interface SettingsDraftState { saved: SettingsV2; draft: SettingsV2 }

const settingsFields = [
  'workspace', 'theme', 'checkUpdatesOnStartup', 'runDiagnosticsOnStartup', 'relaySiteId',
  'mirrorPolicy', 'uiSkin', 'reducedMotion', 'uiScale', 'closeBehavior', 'desktopNotifications',
] as const
export type SettingsField = typeof settingsFields[number]

export function settingsEqual(left: SettingsV2, right: SettingsV2): boolean {
  return left.version === right.version && settingsFields.every((key) => left[key] === right[key])
}

export function reconcileSettingsDraft(current: SettingsDraftState, persisted: SettingsV2, pendingFields: ReadonlySet<SettingsField> = new Set()): SettingsDraftState {
  if (settingsEqual(current.saved, persisted)) return current
  const draft = { ...persisted }
  const carryUnsavedField = <Key extends SettingsField>(key: Key) => {
    if ((key !== 'theme' || pendingFields.has(key)) && current.draft[key] !== current.saved[key]) draft[key] = current.draft[key]
  }
  settingsFields.forEach(carryUnsavedField)
  return { saved: persisted, draft }
}

export function settingsFieldPatch<Key extends SettingsField>(key: Key, value: SettingsV2[Key]): AppSettingsV2Update {
  const next = value === undefined && (key === 'uiSkin' || key === 'uiScale' || key === 'mirrorPolicy')
    ? 'auto'
    : value === undefined && key === 'closeBehavior' ? 'ask' : value
  return { version: 2, [key]: next }
}

export interface SettingsFieldSaverOptions {
  usesPatches(): boolean
  readConfirmed(): SettingsV2
  write(patch: AppSettingsV2Update, full: SettingsV2): Promise<void>
  onCommit<Key extends SettingsField>(key: Key, value: SettingsV2[Key]): void
  onSuccess(key: SettingsField): void
  onFailure(key: SettingsField, message: string): void
}

export function createSettingsFieldSaver(options: SettingsFieldSaverOptions) {
  const sequences = new Map<SettingsField, number>()
  const queues = new Map<string, Promise<void>>()
  let active = true
  let detachedConfirmed: SettingsV2 | undefined
  return {
    save<Key extends SettingsField>(key: Key, next: SettingsV2[Key]): Promise<void> {
      const sequence = (sequences.get(key) ?? 0) + 1
      sequences.set(key, sequence)
      // Full-record callbacks merge at execution time in one shared queue;
      // patch-capable hosts can save unrelated fields independently.
      const queueKey = options.usesPatches() ? key : '*'
      const result = (queues.get(queueKey) ?? Promise.resolve()).then(async () => {
        try {
          const confirmed = active ? options.readConfirmed() : detachedConfirmed!
          await options.write(settingsFieldPatch(key, next), { ...confirmed, [key]: next })
          if (!active) detachedConfirmed = { ...detachedConfirmed!, [key]: next }
          if (!active) return
          options.onCommit(key, next)
          if (sequences.get(key) === sequence) options.onSuccess(key)
        } catch (cause) {
          if (active && sequences.get(key) === sequence) options.onFailure(key, errorMessage(cause))
        }
      })
      queues.set(queueKey, result)
      void result.then(() => { if (queues.get(queueKey) === result) queues.delete(queueKey) })
      return result
    },
    dispose() { detachedConfirmed = options.readConfirmed(); active = false },
  }
}

const sections = [
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'startup', label: '启动与关闭', icon: Power },
  { id: 'tools', label: '工具', icon: Wrench },
  { id: 'network', label: '网络', icon: Globe2 },
  { id: 'notifications', label: '通知', icon: Bell },
  { id: 'account', label: '账号', icon: UserRound },
  { id: 'privacy', label: '隐私与数据', icon: ShieldCheck },
  { id: 'about', label: '关于', icon: Info },
] as const
export type SettingsSectionId = typeof sections[number]['id']
type FieldStatus = { state: 'saving' | 'saved' | 'failed'; message?: string }

function FieldFeedback({ field, status }: { field: SettingsField; status?: FieldStatus }) {
  return (
    <div id={`settings-${field}-feedback`} className={`settings-v3-feedback ${status?.state ?? ''}`} role={status?.state === 'failed' ? 'alert' : 'status'} aria-live="polite">
      {status?.state === 'saving' && <><LoaderCircle size={13} className="spin" aria-hidden="true" />保存中</>}
      {status?.state === 'saved' && <><Check size={13} aria-hidden="true" />已保存</>}
      {status?.state === 'failed' && <><AlertCircle size={13} aria-hidden="true" />{status.message}</>}
    </div>
  )
}

function SettingRow({ title, description, children, feedback }: {
  title: string; description?: string; children: ReactNode; feedback?: ReactNode
}) {
  return <div className="settings-v3-row"><div className="settings-v3-row-body"><div className="settings-v3-copy"><strong>{title}</strong>{description && <p>{description}</p>}</div><div className="settings-v3-control">{children}</div></div>{feedback}</div>
}

const skins = [
  { id: 'dawn', label: '晨曦金', color: 'var(--skin-dawn)' },
  { id: 'obsidian', label: '极夜黑金', color: 'var(--skin-obsidian)' },
  { id: 'mist', label: '雾青', color: 'var(--skin-mist)' },
  { id: 'aurora', label: '极光紫', color: 'var(--skin-aurora)' },
] as const

export function SettingsPage(props: SettingsPageProps) {
  const { value, onReplayOnboarding, onChooseWorkspace, onNavigate, appVersion, trayAvailable = false } = props
  const [section, setSection] = useNavigationState<SettingsSectionId>('settings.section', props.initialSection ?? 'appearance')
  const [settingsState, setSettingsState] = useNavigationState<SettingsDraftState>('settings.draft', () => ({ saved: value, draft: value }))
  const stateRef = useRef(settingsState)
  const propsRef = useRef(props)
  propsRef.current = props
  const [statuses, setStatuses] = useState<Partial<Record<SettingsField, FieldStatus>>>({})
  const [choosingWorkspace, setChoosingWorkspace] = useState(false)
  const mounted = useRef(true)
  const saverRef = useRef<ReturnType<typeof createSettingsFieldSaver> | null>(null)
  const pendingFields = useRef(new Set<SettingsField>())
  const changeState = (update: (current: SettingsDraftState) => SettingsDraftState) => {
    stateRef.current = update(stateRef.current)
    setSettingsState(stateRef.current)
  }
  const preview = <Key extends SettingsField>(key: Key, next: SettingsV2[Key]) => {
    if (key === 'theme') propsRef.current.onThemePreview?.(next as SettingsTheme)
    if (key === 'uiSkin') propsRef.current.onAppearancePreview?.({ uiSkin: next as SettingsV2['uiSkin'] })
    if (key === 'reducedMotion') propsRef.current.onAppearancePreview?.({ reducedMotion: next as boolean })
  }
  const makeSaver = () => createSettingsFieldSaver({
    usesPatches: () => Boolean(propsRef.current.onSavePatch),
    readConfirmed: () => stateRef.current.saved,
    write: (patch, full) => propsRef.current.onSavePatch?.(patch) ?? propsRef.current.onSave(full),
    onCommit: (key, next) => changeState((current) => ({ ...current, saved: { ...current.saved, [key]: next } })),
    onSuccess: (key) => {
      pendingFields.current.delete(key)
      setStatuses((current) => ({ ...current, [key]: { state: 'saved' } }))
    },
    onFailure: (key, message) => {
      pendingFields.current.delete(key)
      if (key !== 'workspace') {
        const confirmed = stateRef.current.saved[key]
        changeState((current) => ({ ...current, draft: { ...current.draft, [key]: confirmed } }))
        preview(key, confirmed)
      }
      setStatuses((current) => ({ ...current, [key]: { state: 'failed', message } }))
    },
  })
  if (!saverRef.current) saverRef.current = makeSaver()
  useEffect(() => {
    mounted.current = true
    saverRef.current = makeSaver()
    return () => { mounted.current = false; saverRef.current?.dispose() }
  }, [])
  useEffect(() => { changeState((current) => reconcileSettingsDraft(current, value, pendingFields.current)) }, [value])
  useEffect(() => { if (props.initialSection) setSection(props.initialSection) }, [props.initialSection, setSection])

  const { saved, draft } = settingsState
  const feedback = (field: SettingsField) => <FieldFeedback field={field} status={statuses[field]} />
  const commit = <Key extends SettingsField>(key: Key, next: SettingsV2[Key]) => {
    pendingFields.current.add(key)
    changeState((current) => ({ ...current, draft: { ...current.draft, [key]: next } }))
    preview(key, next)
    setStatuses((current) => ({ ...current, [key]: { state: 'saving' } }))
    void saverRef.current!.save(key, next)
  }
  const saveWorkspace = () => {
    const workspace = stateRef.current.draft.workspace
    if (!workspace.trim() || workspace.length > 32_767) {
      setStatuses((current) => ({ ...current, workspace: { state: 'failed', message: '请输入有效的工作目录路径' } }))
      return
    }
    commit('workspace', workspace)
  }
  const chooseWorkspace = async () => {
    if (!onChooseWorkspace || choosingWorkspace) return
    setChoosingWorkspace(true)
    try {
      const workspace = await onChooseWorkspace()
      if (mounted.current && workspace !== null) commit('workspace', workspace)
    } catch (cause) {
      if (mounted.current) setStatuses((current) => ({ ...current, workspace: { state: 'failed', message: errorMessage(cause) } }))
    } finally { if (mounted.current) setChoosingWorkspace(false) }
  }
  const switchControl = (field: 'checkUpdatesOnStartup' | 'runDiagnosticsOnStartup' | 'reducedMotion' | 'desktopNotifications', title: string, disabled = false) => (
    <input className="settings-v3-switch" type="checkbox" role="switch" aria-label={title} aria-describedby={`settings-${field}-feedback`} checked={Boolean(draft[field])} disabled={disabled} onChange={(event) => commit(field, event.target.checked)} />
  )
  const navigation = (target: SettingsNavigationTarget, label: string) => <button className="settings-v3-command" type="button" disabled={!onNavigate} onClick={() => onNavigate?.(target)}>{label}<ArrowUpRight size={14} aria-hidden="true" /></button>

  return (
    <div className="page workspace-page settings-v3" data-page-id="settings" data-unsaved={draft.workspace !== saved.workspace ? 'true' : undefined}>
      <header className="page-header workspace-page-header"><h1>设置</h1></header>
      <div className="settings-v3-layout">
        <nav className="settings-v3-nav" aria-label="设置分组">
          {sections.map(({ id, label, icon: Icon }) => <button id={`settings-nav-${id}`} key={id} className={section === id ? 'is-active' : ''} type="button" aria-current={section === id ? 'page' : undefined} aria-controls="settings-panel" onClick={() => setSection(id)}><Icon size={17} aria-hidden="true" /><span>{label}</span></button>)}
        </nav>
        <section className="settings-v3-panel" id="settings-panel" aria-labelledby={`settings-nav-${section}`}>
          <h2>{sections.find((entry) => entry.id === section)!.label}</h2>
          {section === 'appearance' && <>
            <SettingRow title="主题" feedback={feedback('theme')}><div className="settings-v3-segmented" role="group" aria-label="主题"><button type="button" aria-pressed={draft.theme === 'light'} onClick={() => commit('theme', 'light')}><Sun size={16} aria-hidden="true" />浅色</button><button type="button" aria-pressed={draft.theme === 'dark'} onClick={() => commit('theme', 'dark')}><Moon size={16} aria-hidden="true" />深色</button></div></SettingRow>
            <SettingRow title="界面皮肤" feedback={feedback('uiSkin')}><div className="settings-v3-skins" role="group" aria-label="界面皮肤"><button type="button" className="settings-v3-skin" aria-pressed={draft.uiSkin === undefined} onClick={() => commit('uiSkin', undefined)}><span className="settings-v3-swatch automatic" aria-hidden="true" /><span>随主题</span></button>{skins.map((skin) => <button key={skin.id} className="settings-v3-skin" style={{ '--skin-chip-color': skin.color } as CSSProperties} type="button" aria-pressed={draft.uiSkin === skin.id} onClick={() => commit('uiSkin', skin.id)}><span className="settings-v3-swatch" aria-hidden="true" /><span>{skin.label}</span></button>)}</div></SettingRow>
            <SettingRow title="减少动画" feedback={feedback('reducedMotion')}>{switchControl('reducedMotion', '减少动画')}</SettingRow>
            <SettingRow title="界面大小" description="百分比相对于当前窗口的自动倍率。" feedback={feedback('uiScale')}><select aria-label="界面大小" aria-describedby="settings-uiScale-feedback" value={draft.uiScale ?? 'auto'} onChange={(event) => commit('uiScale', event.target.value === 'auto' ? undefined : event.target.value as SettingsV2['uiScale'])}><option value="auto">自动</option><option value="90">90%</option><option value="100">100%</option><option value="110">110%</option></select></SettingRow>
          </>}
          {section === 'startup' && <>
            <SettingRow title="启动时检查更新" feedback={feedback('checkUpdatesOnStartup')}>{switchControl('checkUpdatesOnStartup', '启动时检查更新')}</SettingRow>
            <SettingRow title="启动时检查环境" feedback={feedback('runDiagnosticsOnStartup')}>{switchControl('runDiagnosticsOnStartup', '启动时检查环境')}</SettingRow>
            <SettingRow title="关闭主窗口" description={trayAvailable ? undefined : '当前托盘不可用；选择缩到托盘时仍保留窗口和任务栏入口。'} feedback={feedback('closeBehavior')}><select aria-label="关闭主窗口" aria-describedby="settings-closeBehavior-feedback" value={draft.closeBehavior ?? 'ask'} onChange={(event) => commit('closeBehavior', event.target.value === 'ask' ? undefined : event.target.value as SettingsV2['closeBehavior'])}><option value="ask">每次询问</option><option value="tray" disabled={!trayAvailable}>缩到托盘</option><option value="quit">直接退出</option></select></SettingRow>
            <SettingRow title="开机自启" description="当前版本未注册系统开机启动项。"><span className="settings-v3-availability">未启用</span></SettingRow>
          </>}
          {section === 'tools' && <>
            <div className="settings-v3-row settings-v3-workspace"><label htmlFor="settings-workspace">默认工作目录</label><div className="settings-v3-directory"><input id="settings-workspace" value={draft.workspace} aria-invalid={statuses.workspace?.state === 'failed'} aria-describedby="settings-workspace-feedback" onChange={(event) => changeState((current) => ({ ...current, draft: { ...current.draft, workspace: event.target.value } }))} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) saveWorkspace() }} /><button className="settings-v3-icon-button" type="button" aria-label="选择工作目录" title="选择工作目录" disabled={!onChooseWorkspace || choosingWorkspace} onClick={() => void chooseWorkspace()}>{choosingWorkspace ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <FolderOpen size={17} aria-hidden="true" />}</button><button className="settings-v3-icon-button" type="button" aria-label="保存工作目录" title="保存工作目录" disabled={draft.workspace === saved.workspace && statuses.workspace?.state !== 'failed'} onClick={saveWorkspace}><Save size={17} aria-hidden="true" /></button></div>{feedback('workspace')}</div>
            <SettingRow title="工具准备" description="已保存的配置和授权会继续保留。"><button className="settings-v3-command" type="button" onClick={onReplayOnboarding}><Compass size={15} aria-hidden="true" />重新打开引导</button></SettingRow>
            <SettingRow title="环境状态">{navigation('health', '查看检查结果')}</SettingRow>
          </>}
          {section === 'network' && <>
            <SettingRow title="服务站点" description="切换后需重新保存各工具配置。" feedback={feedback('relaySiteId')}><select aria-label="服务站点" aria-describedby="settings-relaySiteId-feedback" value={resolveRelaySite(draft.relaySiteId).id} onChange={(event) => commit('relaySiteId', event.target.value)}>{relaySites.map((site) => <option key={site.id} value={site.id}>{site.label}</option>)}</select></SettingRow>
            <SettingRow title="下载顺序" feedback={feedback('mirrorPolicy')}><select aria-label="镜像策略" aria-describedby="settings-mirrorPolicy-feedback" value={draft.mirrorPolicy ?? 'auto'} onChange={(event) => commit('mirrorPolicy', event.target.value === 'auto' ? undefined : event.target.value as SettingsV2['mirrorPolicy'])}><option value="auto">自动（推荐）</option><option value="mirror-first">国内源优先</option><option value="official-first">官方源优先</option></select></SettingRow>
            <SettingRow title="代理与企业证书" description="暂不提供应用内覆盖配置。连接失败时可先查看环境检查。">{navigation('health', '检查连接')}</SettingRow>
          </>}
          {section === 'notifications' && <>
            <SettingRow title="更新提醒" description="启动时检查新版本。" feedback={feedback('checkUpdatesOnStartup')}>{switchControl('checkUpdatesOnStartup', '更新提醒')}</SettingRow>
            <SettingRow title="系统桌面通知" description={props.desktopNotificationsSupported === undefined ? '正在读取系统通知支持状态。' : props.desktopNotificationsSupported ? '提醒新版本和下载完成，显示由系统通知设置控制。' : '当前系统不支持桌面通知，应用内提醒仍可用。'} feedback={feedback('desktopNotifications')}>
              {switchControl('desktopNotifications', '系统桌面通知', props.desktopNotificationsSupported !== true && !draft.desktopNotifications)}
            </SettingRow>
            <SettingRow title="版本更新">{navigation('update', '打开更新')}</SettingRow>
          </>}
          {section === 'account' && <>
            <SettingRow title="账号与授权">{navigation('account', '打开个人中心')}</SettingRow>
            <SettingRow title="密钥、订阅与登录设备">{navigation('account', '管理账号')}</SettingRow>
          </>}
          {section === 'privacy' && <>
            <SettingRow title="配置备份与恢复">{navigation('backups', '打开备份')}</SettingRow>
            <SettingRow title="诊断报告" description="提交前可检查报告内容。">{navigation('feedback', '预览反馈报告')}</SettingRow>
            <SettingRow title="工具与画布数据"><span className="settings-v3-availability">保存在本机</span></SettingRow>
          </>}
          {section === 'about' && <>
            <div className="settings-v3-brand"><img src={brandSymbol} width="56" height="56" alt="" /><div><strong>星芒AI管理工具</strong><p>{appVersion ? `版本 ${appVersion}` : '版本信息未提供'}</p></div></div>
            <SettingRow title="软件更新">{navigation('update', '检查更新')}</SettingRow>
            <SettingRow title="问题与建议">{navigation('feedback', '打开反馈')}</SettingRow>
          </>}
        </section>
      </div>
    </div>
  )
}
