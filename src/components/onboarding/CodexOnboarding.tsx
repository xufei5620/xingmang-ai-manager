import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleDot,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Store,
} from 'lucide-react'
import logoUrl from '../../../assets/icon.png'
import logoWhiteUrl from '../../../assets/icon-white.png'
import chatGptIconUrl from '../../../assets/brands/chatgpt.svg'
import { codexDesktopInstallLabel, isDetectionFailed, type ThemeMode } from '../../app-shared'
import { errorMessage } from '../../error-message'
import { ThemeToggle } from '../Sidebar'
import {
  createManagedBootstrapProgress,
  updateManagedBootstrapProgress,
  type ManagedBootstrapProgressUpdate,
  type ManagedBootstrapStepId,
} from '../../managed-bootstrap-progress'
import {
  authorizeManagedCodex,
  DEFAULT_CODEX_MODEL,
  prepareCodexEnvironmentAutomatically,
  type CodexAutomaticSetupResult,
  type OnboardingSetupAction,
} from '../../onboarding-flow'
import { CODEX_DESKTOP_STORE_URI } from '../../pages/MaintenancePage'
import { platformPresentation } from '../../platform-presentation'
import type {
  AppConfigSummary,
  CodexDesktopInstallProgress,
  CodexSetupStatus,
  InstallProgress,
  PlatformCapabilities,
} from '../../types'
import { ManagedBootstrapPanel } from './ManagedBootstrapPanel'
import { OnboardingStep } from './OnboardingStep'
import { SetupCheckItem } from './SetupCheckItem'

type SetupAction = OnboardingSetupAction

export function CodexOnboarding({
  initialConfig,
  theme,
  onToggleTheme,
  onConfigChange,
  onComplete,
  onCancel,
  codexOfficial,
  codexDesktopInstallDisabled,
  onLogout,
  autoStart,
  desktopInstallProgress,
  platform,
}: {
  initialConfig: AppConfigSummary | null
  theme: ThemeMode
  onToggleTheme: () => void
  onConfigChange: (config: AppConfigSummary) => void
  onComplete: (onProgress?: (update: ManagedBootstrapProgressUpdate) => void) => Promise<void>
  /** Escape hatch for replaying onboarding from Settings without changing configuration. */
  onCancel?: () => void
  /** The user explicitly chose the native Codex subscription; keep it intact. */
  codexOfficial: boolean
  codexDesktopInstallDisabled: boolean
  onLogout?: () => void
  /** Settings replay opens a preview state; the user must explicitly start. */
  autoStart: boolean
  desktopInstallProgress: CodexDesktopInstallProgress | null
  platform: PlatformCapabilities
}) {
  const existingCodex = initialConfig?.providers.codex
  const [stage, setStage] = useState<'authorize' | 'setup' | 'ready'>('authorize')
  const [status, setStatus] = useState<CodexSetupStatus | null>(null)
  const [action, setAction] = useState<SetupAction>('idle')
  const [logs, setLogs] = useState<string[]>([])
  const [error, setError] = useState('')
  const [managedWarning, setManagedWarning] = useState('')
  const [finishing, setFinishing] = useState(false)
  const [desktopInstallRecovery, setDesktopInstallRecovery] = useState(false)
  const [managedProgress, setManagedProgress] = useState(createManagedBootstrapProgress)
  const [managedFlowLocked, setManagedFlowLocked] = useState(autoStart)
  const [flowStarted, setFlowStarted] = useState(autoStart)
  const managedStepRef = useRef<ManagedBootstrapStepId>('sync-keys')
  const initializationBusyRef = useRef(false)
  const autoInitializationStartedRef = useRef(false)
  const autoCompletionStartedRef = useRef(false)
  const completionBusyRef = useRef(false)

  useEffect(() => {
    return window.xingmang.onInstallProgress((event: InstallProgress) => {
      if (event.provider !== 'codex') return
      setLogs((current) => [...current.slice(-20), event.message])
    })
  }, [])

  useEffect(() => {
    if (!desktopInstallProgress) return
    setLogs((current) => [...current.slice(-20), desktopInstallProgress.message])
  }, [desktopInstallProgress])

  const reportManagedProgress = (update: ManagedBootstrapProgressUpdate) => {
    managedStepRef.current = update.id
    setManagedProgress((current) => updateManagedBootstrapProgress(current, update))
  }

  const setupCallbacks = {
    onAction: (nextAction: SetupAction) => {
      setAction(nextAction)
      if (nextAction === 'scanning' && ['sync-keys', 'authorize-codex', 'inspect-environment'].includes(managedStepRef.current)) {
        reportManagedProgress({ id: 'inspect-environment', status: 'active', message: '正在检测 Codex Desktop' })
      } else if (nextAction === 'installing-desktop') {
        reportManagedProgress({ id: 'prepare-codex-desktop', status: 'active', message: '正在安装并验证 Codex Desktop' })
      }
    },
    onStatus: (nextStatus: CodexSetupStatus) => {
      setStatus(nextStatus)
      if (isDetectionFailed(nextStatus.desktop)) {
        reportManagedProgress({ id: 'inspect-environment', status: 'failed', message: 'Codex Desktop 暂时无法确认状态' })
      } else {
        reportManagedProgress({ id: 'inspect-environment', status: 'completed', message: 'Codex Desktop 状态检测完成' })
      }
      if (!isDetectionFailed(nextStatus.desktop)
        && (nextStatus.desktop.installed || platform.codexDesktop.install === 'external')) {
        reportManagedProgress({
          id: 'prepare-codex-desktop',
          status: 'completed',
          message: nextStatus.desktop.installed ? 'Codex Desktop 已就绪' : '当前平台使用外部桌面端安装',
        })
      }
    },
    onLog: (message: string, mode: 'replace' | 'append') => {
      setLogs((current) => mode === 'replace' ? [message] : [...current, message])
    },
  }

  const applySetupResult = (result: CodexAutomaticSetupResult) => {
    if (result.outcome === 'ready') {
      reportManagedProgress({ id: 'prepare-codex-desktop', status: 'completed', message: 'Codex Desktop 准备完成' })
      setStage('ready')
      return
    }
    if (result.outcome === 'detection-failed') {
      reportManagedProgress({ id: 'inspect-environment', status: 'failed', message: result.message })
      setManagedFlowLocked(false)
      // Detection could not confirm any state either way — surface the
      // retry message without opening the install guide or the desktop
      // recovery panel, both of which presume a confirmed absence.
      setError(result.message)
      return
    }
    if (result.outcome === 'desktop-recovery') {
      reportManagedProgress({ id: 'prepare-codex-desktop', status: 'failed', message: errorMessage(result.error) })
      setManagedFlowLocked(false)
      setDesktopInstallRecovery(true)
      setError(errorMessage(result.error))
      setStage('setup')
      return
    }
    setDesktopInstallRecovery(result.phase === 'desktop')
    const failedStep: ManagedBootstrapStepId = result.phase === 'environment'
      ? 'inspect-environment'
      : 'prepare-codex-desktop'
    reportManagedProgress({ id: failedStep, status: 'failed', message: errorMessage(result.error) })
    setManagedFlowLocked(false)
    setError(errorMessage(result.error))
  }

  const runSetup = async () => {
    setManagedFlowLocked(true)
    setError('')
    setDesktopInstallRecovery(false)
    applySetupResult(await prepareCodexEnvironmentAutomatically(
      window.xingmang,
      setupCallbacks,
      platform,
      { skipDesktopInstall: codexDesktopInstallDisabled },
    ))
  }

  const openDesktopStore = async () => {
    try {
      await window.xingmang.openExternal(CODEX_DESKTOP_STORE_URI)
      setError('已打开微软商店。安装完成后点击“我已安装，重新检测”。')
    } catch (storeError) {
      setError(`无法打开微软商店：${errorMessage(storeError)}`)
    }
  }

  const recheckDesktop = async () => {
    setManagedFlowLocked(true)
    reportManagedProgress({ id: 'prepare-codex-desktop', status: 'active', message: '正在重新检测 Codex Desktop' })
    setDesktopInstallRecovery(false)
    setError('')
    setAction('scanning')
    try {
      const next = await window.xingmang.getCodexSetupStatus()
      setStatus(next)
      if (isDetectionFailed(next.desktop)) {
        throw new Error('暂时无法确认 Codex 桌面端安装状态，请重试检测')
      }
      if (!next.desktop.installed) throw new Error('仍未检测到 Codex 桌面端，请先完成微软商店安装')
      setAction('idle')
      reportManagedProgress({ id: 'prepare-codex-desktop', status: 'completed', message: 'Codex Desktop 已就绪' })
      setStage('ready')
    } catch (recheckError) {
      setAction('idle')
      setDesktopInstallRecovery(true)
      setError(errorMessage(recheckError))
      reportManagedProgress({ id: 'prepare-codex-desktop', status: 'failed', message: errorMessage(recheckError) })
      setManagedFlowLocked(false)
    }
  }

  const startInitialization = async () => {
    if (initializationBusyRef.current) return
    initializationBusyRef.current = true
    setFlowStarted(true)
    setError('')
    setManagedWarning('')
    setAction('scanning')
    setManagedProgress(createManagedBootstrapProgress())
    setManagedFlowLocked(true)
    try {
      reportManagedProgress({ id: 'sync-keys', status: 'active', message: '正在创建或同步账号专属分组 Key' })
      const synchronized = await window.xingmang.syncManagedCliKeys()
      const codexFailure = synchronized.failed.find((entry) => entry.provider === 'codex')
      if (codexFailure && !codexOfficial) throw new Error(codexFailure.message)
      const warnings = synchronized.failed
        .filter((entry) => entry.provider !== 'codex' || codexOfficial)
        .map((entry) => `${entry.provider}：${entry.message}`)
      if (synchronized.storageWarning) warnings.push(synchronized.storageWarning)
      if (synchronized.imageSkillWarning) warnings.push(synchronized.imageSkillWarning)
      if (warnings.length) setManagedWarning(warnings.join('；'))
      reportManagedProgress({
        id: 'sync-keys',
        status: 'completed',
        message: warnings.length ? `Key 同步完成，但有警告：${warnings.join('；')}` : '账号专属 Key 已加密保存',
      })
      if (!codexOfficial) {
        reportManagedProgress({ id: 'authorize-codex', status: 'active', message: '正在写入 GPT-中转/订阅 Key 与默认模型' })
      }
      const nextConfig = !codexOfficial
        ? await authorizeManagedCodex(window.xingmang)
        : await window.xingmang.getConfig()
      reportManagedProgress({
        id: 'authorize-codex',
        status: 'completed',
        message: codexOfficial ? '保留 Codex 官方账号配置' : 'Codex 授权配置已写入',
      })
      onConfigChange(nextConfig)
      setStage('setup')
      await runSetup()
    } catch (initializeError) {
      setAction('idle')
      setError(errorMessage(initializeError))
      reportManagedProgress({ id: managedStepRef.current, status: 'failed', message: errorMessage(initializeError) })
      setManagedFlowLocked(false)
    } finally {
      initializationBusyRef.current = false
    }
  }

  useEffect(() => {
    if (!autoStart || autoInitializationStartedRef.current) return
    autoInitializationStartedRef.current = true
    void startInitialization()
  }, [autoStart])

  const enterDashboard = async () => {
    if (completionBusyRef.current) return
    completionBusyRef.current = true
    setFinishing(true)
    setManagedFlowLocked(true)
    setError('')
    try {
      await onComplete(reportManagedProgress)
    } catch (completeError) {
      completionBusyRef.current = false
      setFinishing(false)
      setError(errorMessage(completeError))
      reportManagedProgress({ id: managedStepRef.current, status: 'failed', message: errorMessage(completeError) })
      setManagedFlowLocked(false)
    }
  }

  useEffect(() => {
    if (
      stage !== 'ready'
      || !flowStarted
      || autoCompletionStartedRef.current
    ) return
    autoCompletionStartedRef.current = true
    void enterDashboard()
  }, [flowStarted, stage])

  const installedCount = status?.desktop.installed ? 1 : 0
  const busy = action !== 'idle'
  const flowLocked = managedFlowLocked
  // A detection failure must not be steered toward "install this", since the
  // tool it names may already be present — only a retry can tell.
  const anyDetectionFailed = Boolean(status && isDetectionFailed(status.desktop))

  return (
    <div className="onboarding-shell">
      <aside className="onboarding-rail">
        <div className="onboarding-brand">
          <img src={theme === 'dark' ? logoWhiteUrl : logoUrl} alt="星芒AI" />
          <div>
            <strong><span>星芒</span> AI</strong>
            <small>Codex 快速配置</small>
          </div>
        </div>

        <div className="onboarding-steps" aria-label="初始化进度">
          <OnboardingStep
            index={1}
            label="账号配置"
            detail="同步账号专属 Key"
            active={stage === 'authorize'}
            complete={stage !== 'authorize'}
          />
          <OnboardingStep
            index={2}
            label="桌面端初始化"
            detail="安装或验证 Codex Desktop"
            active={stage === 'setup'}
            complete={stage === 'ready'}
          />
          <OnboardingStep
            index={3}
            label="准备完成"
            detail="进入首页"
            active={stage === 'ready'}
            complete={false}
          />
        </div>

        <div className="onboarding-rail-bottom">
          {onCancel && (!flowLocked && (existingCodex?.exists || Boolean(error))) && (
            <button
              type="button"
              className="sidebar-control-button"
              title="返回首页，不会改现有配置"
              disabled={flowLocked}
              onClick={onCancel}
            >
              <ArrowLeft size={15} />
              <span>返回首页</span>
            </button>
          )}
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <div className="onboarding-rail-note">
            <ShieldCheck size={16} />
            <span>修改配置前自动备份</span>
          </div>
        </div>
      </aside>

      <main className="onboarding-main">
        <div className="onboarding-content">
          {stage === 'authorize' ? (
            <>
              <div className="onboarding-heading">
                <div className="onboarding-heading-icon onboarding-codex-icon">
                  <img src={chatGptIconUrl} alt="" />
                </div>
                <div>
                  <span>快速准备</span>
                  <h1>准备 Codex</h1>
                  <p>已登录，正在自动配好并准备桌面端。</p>
                </div>
              </div>

              <ManagedBootstrapPanel progress={managedProgress} locked={flowLocked} />

              {managedWarning && (
                <div className="onboarding-notice" role="status">
                  <AlertCircle size={17} />
                  <span>{managedWarning}</span>
                </div>
              )}

              {!flowStarted && (
                <div className="onboarding-notice" role="status">
                  <AlertCircle size={17} />
                  <span>已打开初始化预览。点击下方“开始初始化”后才会写入配置或安装环境。</span>
                </div>
              )}

              {existingCodex?.exists && (
                <div className="onboarding-notice">
                  <AlertCircle size={17} />
                  <span>检测到现有 Codex 配置不是星芒 AI，初始化前会创建时间戳备份。</span>
                </div>
              )}

              <div className="onboarding-form">
                <div className="onboarding-managed-authorization" role="status" aria-live="polite">
                  <div className="onboarding-managed-authorization-icon">
                    {busy ? <LoaderCircle size={19} className="spin" /> : <ShieldCheck size={19} />}
                  </div>
                  <div>
                    <strong>{busy ? '正在自动配置账号 Key' : error ? '自动配置未完成' : '账号 Key 已就绪'}</strong>
                    <span>使用本地保存的 GPT-中转/订阅专属 Key，无需手动填写。</span>
                  </div>
                </div>

                <div className="onboarding-defaults">
                  <div>
                    <span>服务</span>
                    <strong><i />星芒 AI</strong>
                  </div>
                  <div>
                    <span>模型</span>
                    <code>{DEFAULT_CODEX_MODEL}</code>
                  </div>
                </div>

                {error && <div className="onboarding-error"><AlertCircle size={16} />{error}</div>}

                <button
                  type="button"
                  className="primary-button onboarding-primary"
                  disabled={flowLocked || busy}
                  onClick={() => void startInitialization()}
                >
                  {busy
                    ? <LoaderCircle size={18} className="spin" />
                    : <RefreshCw size={18} />}
                  {busy
                    ? '正在读取本地 Key 并写入配置'
                    : error ? '重新初始化' : '开始初始化'}
                  {!busy && <ArrowRight size={17} />}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="onboarding-heading setup-heading">
                <div className="onboarding-heading-icon onboarding-codex-icon">
                  <img src={chatGptIconUrl} alt="" />
                </div>
                <div>
                  <span>{stage === 'ready' ? 'SETUP COMPLETE' : 'ENVIRONMENT SETUP'}</span>
                  <h1>{stage === 'ready' ? 'Codex Desktop 已准备就绪' : '正在准备 Codex Desktop'}</h1>
                  <p>{stage === 'ready'
                    ? status?.desktop.installed
                      ? '配置已完成，Codex Desktop 可以使用。'
                      : '桌面端尚未安装，正在准备安装。'
                    : '只安装或验证 Codex Desktop，并自动应用本地简体中文界面；Node.js、npm 和 Codex CLI 可稍后按需安装。'}</p>
                </div>
              </div>

              <ManagedBootstrapPanel progress={managedProgress} locked={flowLocked} />

              <div className="setup-progress-row">
                <span>Codex Desktop 初始化进度</span>
                <strong>{installedCount}/1</strong>
              </div>
              <div className="setup-progress"><span style={{ width: `${installedCount * 100}%` }} /></div>

              <div className="setup-check-list">
                <SetupCheckItem
                  label="Codex 桌面端"
                  detail={action === 'installing-desktop' ? codexDesktopInstallLabel(desktopInstallProgress) : status?.desktop.installed ? platformPresentation(platform).codexDesktopClient : platform.isMac ? '由 Codex Desktop 官方安装器管理' : '等待安装最新版'}
                  status={status?.desktop ?? null}
                  loading={action === 'installing-desktop'}
                />
              </div>
              <div className="setup-optional-note" role="note">
                Node.js、npm 和 Codex 命令行是可选的，不影响桌面端。以后要用命令行，去「更多 → 安装卸载」再装。
              </div>
              <div className="setup-check-list setup-check-list-optional">
                <SetupCheckItem label="Node.js（可选）" detail={status?.runtime.node.version ?? '未安装不影响桌面端'} status={status?.runtime.node ?? null} loading={action === 'scanning' && !status} optional />
                <SetupCheckItem label="npm（可选）" detail={status?.runtime.npm.version ?? '未安装不影响桌面端'} status={status?.runtime.npm ?? null} loading={action === 'scanning' && !status} optional />
                <SetupCheckItem label="Codex CLI（可选）" detail={status?.cli.version ?? '未安装不影响桌面端'} status={status?.cli ?? null} loading={action === 'scanning' && !status} optional />
              </div>

              {desktopInstallProgress && action === 'installing-desktop' && (
                <div className={`desktop-install-progress onboarding-desktop-progress phase-${desktopInstallProgress.phase}`} role="status" aria-live="polite">
                  <div>
                    <span>{codexDesktopInstallLabel(desktopInstallProgress)}</span>
                    {desktopInstallProgress.percent !== null && <strong>{Math.round(desktopInstallProgress.percent)}%</strong>}
                  </div>
                  {desktopInstallProgress.percent !== null && <progress max="100" value={desktopInstallProgress.percent} />}
                </div>
              )}

              {logs.length > 0 && stage !== 'ready' && (
                <div className="onboarding-log" aria-live="polite">
                  <div><CircleDot size={13} /> 安装进度</div>
                  <pre>{logs.slice(-6).join('\n')}</pre>
                </div>
              )}

              {error && <div className="onboarding-error"><AlertCircle size={16} />{error}</div>}

              {error && !flowLocked && (
                <div className="onboarding-recovery-actions" role="group" aria-label="初始化恢复操作">
                  {onLogout && (
                    <button type="button" className="secondary-button" onClick={onLogout}>
                      <ArrowLeft size={16} /> 退出登录
                    </button>
                  )}
                  {onCancel && (
                    <button type="button" className="secondary-button" onClick={onCancel}>
                      <ArrowLeft size={16} /> 返回首页
                    </button>
                  )}
                </div>
              )}

              {desktopInstallRecovery && (
                <div className="setup-recovery" role="group" aria-label="Codex 桌面端安装选项">
                  <div className="setup-recovery-copy">
                    <strong>桌面端安装未完成</strong>
                    <span>自动安装未完成，可以直接重试；仍失败时可使用微软商店安装后重新检测。</span>
                  </div>
                  <div className="setup-recovery-actions">
                    <button type="button" className="secondary-button" disabled={flowLocked} onClick={() => void openDesktopStore()}>
                      <Store size={16} /> 打开微软商店
                    </button>
                    <button type="button" className="secondary-button" disabled={flowLocked} onClick={() => void recheckDesktop()}>
                      <RefreshCw size={16} /> 我已安装，重新检测
                    </button>
                    <button type="button" className="primary-button" disabled={flowLocked} onClick={() => void runSetup()}>
                      <RefreshCw size={16} /> 重试自动安装
                    </button>
                  </div>
                </div>
              )}

              <div className="onboarding-actions">
                {stage === 'ready' ? (
                  <button type="button" className="primary-button onboarding-primary" disabled={flowLocked || finishing} onClick={() => void enterDashboard()}>
                    {finishing ? <LoaderCircle size={18} className="spin" /> : <CheckCircle2 size={18} />}
                    {finishing ? '正在打开首页' : '进入首页'}
                    {!finishing && <ArrowRight size={17} />}
                  </button>
                ) : desktopInstallRecovery ? null : anyDetectionFailed ? (
                  // At least one probe could not confirm its result — offering an
                  // install action here could reinstall over an already-working
                  // setup, so the only safe move is to let the user retry detection.
                  <button type="button" className="secondary-button" disabled={flowLocked || busy} onClick={() => void runSetup()}>
                    <RefreshCw size={16} className={action === 'scanning' ? 'spin' : ''} /> 重新检测
                  </button>
                ) : error && !desktopInstallRecovery ? (
                  <button type="button" className="secondary-button" disabled={flowLocked} onClick={() => void runSetup()}>
                    <RefreshCw size={16} /> 重试安装
                  </button>
                ) : (
                  <div className="setup-working"><LoaderCircle size={17} className="spin" />正在处理，请稍候</div>
                )}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  )
}
