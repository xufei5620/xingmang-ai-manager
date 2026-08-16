import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  CircleDot,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  LoaderCircle,
  MonitorDown,
  RefreshCw,
  ShieldCheck,
  Store,
} from 'lucide-react'
import logoUrl from '../../../assets/icon.png'
import logoWhiteUrl from '../../../assets/icon-white.png'
import chatGptIconUrl from '../../../assets/brands/chatgpt.svg'
import { codexDesktopInstallLabel, isDetectionFailed, maskedApiKey, type ThemeMode } from '../../app-shared'
import { errorMessage } from '../../error-message'
import { ThemeToggle } from '../Sidebar'
import {
  createManagedBootstrapProgress,
  updateManagedBootstrapProgress,
  type ManagedBootstrapProgressUpdate,
  type ManagedBootstrapStepId,
} from '../../managed-bootstrap-progress'
import {
  authorizeCodex,
  authorizeManagedCodex,
  DEFAULT_CODEX_MODEL,
  installNodeAndPrepareCodexEnvironment,
  prepareCodexEnvironmentAutomatically,
  type CodexAutomaticSetupResult,
  type OnboardingSetupAction,
} from '../../onboarding-flow'
import { nodeRuntimeSupported } from '../../onboarding-runtime'
import { CODEX_DESKTOP_STORE_URI } from '../../pages/MaintenancePage'
import { performNodeRuntimeAction, platformPresentation } from '../../platform-presentation'
import type {
  AppConfigSummary,
  CodexDesktopInstallProgress,
  CodexSetupStatus,
  InstallProgress,
  NodeRuntimeInstallProgress,
  PlatformCapabilities,
  RelaySite,
} from '../../types'
import { NodeInstallGuide } from './NodeInstallGuide'
import { ManagedBootstrapPanel } from './ManagedBootstrapPanel'
import { OnboardingStep } from './OnboardingStep'
import { SetupCheckItem } from './SetupCheckItem'

type SetupAction = OnboardingSetupAction

export function CodexOnboarding({
  initialConfig,
  relaySite,
  theme,
  onToggleTheme,
  onConfigChange,
  onComplete,
  onCancel,
  authorizationMode,
  desktopInstallProgress,
  platform,
}: {
  initialConfig: AppConfigSummary | null
  relaySite: RelaySite
  theme: ThemeMode
  onToggleTheme: () => void
  onConfigChange: (config: AppConfigSummary) => void
  onComplete: (onProgress?: (update: ManagedBootstrapProgressUpdate) => void) => Promise<void>
  /**
   * Escape hatch for a user who is replaying onboarding from Settings with
   * an already-working config (see `existingCodex?.exists` below) — a brand
   * new install has no config to fall back to, so it never gets this button.
   * Must stay a pure navigation callback: nothing in this component may call
   * it alongside `authorizeCodex`/`onConfigChange`/any config write, or
   * "cancel" would silently mutate the very config it's meant to protect.
   */
  onCancel?: () => void
  authorizationMode: 'managed' | 'manual'
  desktopInstallProgress: CodexDesktopInstallProgress | null
  platform: PlatformCapabilities
}) {
  const existingCodex = initialConfig?.providers.codex
  const [stage, setStage] = useState<'authorize' | 'setup' | 'ready'>('authorize')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(true)
  const [status, setStatus] = useState<CodexSetupStatus | null>(null)
  const [action, setAction] = useState<SetupAction>('idle')
  const [logs, setLogs] = useState<string[]>([])
  const [error, setError] = useState('')
  const [finishing, setFinishing] = useState(false)
  const [nodeGuideOpen, setNodeGuideOpen] = useState(false)
  const [nodeInstallProgress, setNodeInstallProgress] = useState<NodeRuntimeInstallProgress | null>(null)
  const [desktopInstallRecovery, setDesktopInstallRecovery] = useState(false)
  const [managedProgress, setManagedProgress] = useState(createManagedBootstrapProgress)
  const [managedFlowLocked, setManagedFlowLocked] = useState(authorizationMode === 'managed')
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
    return window.xingmang.onNodeRuntimeInstallProgress((progress) => {
      setNodeInstallProgress(progress)
      setLogs((current) => [...current.slice(-20), progress.message])
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
      if (authorizationMode !== 'managed') return
      if (nextAction === 'scanning' && ['sync-keys', 'authorize-codex', 'inspect-environment'].includes(managedStepRef.current)) {
        reportManagedProgress({ id: 'inspect-environment', status: 'active', message: '正在检测本机运行环境' })
      } else if (nextAction === 'installing-node') {
        reportManagedProgress({ id: 'prepare-node', status: 'active', message: '正在安装并验证 Node.js 和 npm' })
      } else if (nextAction === 'installing-cli') {
        reportManagedProgress({ id: 'prepare-codex-cli', status: 'active', message: '正在安装并验证 Codex CLI' })
      } else if (nextAction === 'installing-desktop') {
        reportManagedProgress({ id: 'prepare-codex-desktop', status: 'active', message: '正在安装并验证 Codex Desktop' })
      }
    },
    onStatus: (nextStatus: CodexSetupStatus) => {
      setStatus(nextStatus)
      if (authorizationMode !== 'managed') return
      const runtimeReady = nodeRuntimeSupported(nextStatus.runtime) && nextStatus.runtime.npm.installed
      reportManagedProgress({ id: 'inspect-environment', status: 'completed', message: '本机环境检测完成' })
      if (runtimeReady) {
        reportManagedProgress({ id: 'prepare-node', status: 'completed', message: 'Node.js 和 npm 已就绪' })
      }
      if (runtimeReady && nextStatus.cli.installed) {
        reportManagedProgress({ id: 'prepare-codex-cli', status: 'completed', message: 'Codex CLI 已就绪' })
      }
      if (runtimeReady && nextStatus.cli.installed
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
    if (result.outcome === 'node-failed') {
      if (authorizationMode === 'managed') {
        reportManagedProgress({ id: 'prepare-node', status: 'failed', message: errorMessage(result.error) })
        setManagedFlowLocked(false)
      }
      setError(errorMessage(result.error))
      setNodeGuideOpen(true)
      return
    }
    if (result.outcome === 'ready') {
      if (authorizationMode === 'managed') {
        reportManagedProgress({ id: 'prepare-codex-desktop', status: 'completed', message: 'Codex 运行环境准备完成' })
      }
      setStage('ready')
      return
    }
    if (result.outcome === 'runtime-required') {
      if (authorizationMode === 'managed') {
        reportManagedProgress({ id: 'prepare-node', status: 'failed', message: result.message })
        setManagedFlowLocked(false)
      }
      setError(result.message)
      setNodeGuideOpen(true)
      return
    }
    if (result.outcome === 'detection-failed') {
      if (authorizationMode === 'managed') {
        reportManagedProgress({ id: 'inspect-environment', status: 'failed', message: result.message })
        setManagedFlowLocked(false)
      }
      // Detection could not confirm any state either way — surface the
      // retry message without opening the install guide or the desktop
      // recovery panel, both of which presume a confirmed absence.
      setError(result.message)
      return
    }
    if (result.outcome === 'desktop-recovery') {
      if (authorizationMode === 'managed') {
        reportManagedProgress({ id: 'prepare-codex-desktop', status: 'failed', message: errorMessage(result.error) })
        setManagedFlowLocked(false)
      }
      setDesktopInstallRecovery(true)
      setError(errorMessage(result.error))
      setStage('setup')
      return
    }
    setDesktopInstallRecovery(result.phase === 'desktop')
    if (authorizationMode === 'managed') {
      const failedStep: ManagedBootstrapStepId = result.phase === 'environment'
        ? 'inspect-environment'
        : result.phase === 'cli' ? 'prepare-codex-cli' : 'prepare-codex-desktop'
      reportManagedProgress({ id: failedStep, status: 'failed', message: errorMessage(result.error) })
      setManagedFlowLocked(false)
    }
    setError(errorMessage(result.error))
  }

  const runSetup = async () => {
    if (authorizationMode === 'managed') setManagedFlowLocked(true)
    setError('')
    setDesktopInstallRecovery(false)
    applySetupResult(await prepareCodexEnvironmentAutomatically(window.xingmang, setupCallbacks, platform))
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
    if (authorizationMode === 'managed') {
      setManagedFlowLocked(true)
      reportManagedProgress({ id: 'prepare-codex-desktop', status: 'active', message: '正在重新检测 Codex Desktop' })
    }
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
      if (authorizationMode === 'managed') {
        reportManagedProgress({ id: 'prepare-codex-desktop', status: 'completed', message: 'Codex Desktop 已就绪' })
      }
      setStage('ready')
    } catch (recheckError) {
      setAction('idle')
      setDesktopInstallRecovery(true)
      setError(errorMessage(recheckError))
      if (authorizationMode === 'managed') {
        reportManagedProgress({ id: 'prepare-codex-desktop', status: 'failed', message: errorMessage(recheckError) })
        setManagedFlowLocked(false)
      }
    }
  }

  const installNodeAndContinue = async () => {
    if (action !== 'idle') return
    if (authorizationMode === 'managed') setManagedFlowLocked(true)
    if (platform.nodeRuntimeInstall === 'external') {
      try {
        await performNodeRuntimeAction(platform, window.xingmang)
        setError('请从 Node.js 官网完成安装，然后返回重新检测。')
      } catch (installError) {
        setError(errorMessage(installError))
      }
      if (authorizationMode === 'managed') setManagedFlowLocked(false)
      return
    }
    setError('')
    setNodeInstallProgress({
      phase: 'checking',
      source: null,
      percent: null,
      message: '正在准备 Node.js LTS 安装',
    })
    const result = await installNodeAndPrepareCodexEnvironment(window.xingmang, setupCallbacks, platform)
    if (result.outcome === 'node-failed') {
      applySetupResult(result)
      return
    }
    setNodeGuideOpen(false)
    applySetupResult(result.setup)
  }

  const startInitialization = async (mode: 'managed' | 'manual') => {
    if (initializationBusyRef.current) return
    initializationBusyRef.current = true
    setError('')
    setAction('scanning')
    if (mode === 'managed') {
      setManagedProgress(createManagedBootstrapProgress())
      setManagedFlowLocked(true)
    }
    try {
      if (mode === 'managed') {
        reportManagedProgress({ id: 'sync-keys', status: 'active', message: '正在创建或同步账号专属分组 Key' })
        const synchronized = await window.xingmang.syncManagedCliKeys()
        if (synchronized.failed.length > 0) {
          throw new Error(synchronized.failed.map((entry) => entry.message).join('；'))
        }
        if (synchronized.storageWarning) throw new Error(synchronized.storageWarning)
        reportManagedProgress({ id: 'sync-keys', status: 'completed', message: '账号专属 Key 已加密保存' })
        reportManagedProgress({ id: 'authorize-codex', status: 'active', message: '正在写入 codex-pro Key 与默认模型' })
      }
      const nextConfig = mode === 'managed'
        ? await authorizeManagedCodex(window.xingmang)
        : await authorizeCodex(apiKey, window.xingmang)
      if (mode === 'managed') {
        reportManagedProgress({ id: 'authorize-codex', status: 'completed', message: 'Codex 授权配置已写入' })
      }
      onConfigChange(nextConfig)
      setStage('setup')
      await runSetup()
    } catch (initializeError) {
      setAction('idle')
      setError(errorMessage(initializeError))
      if (mode === 'managed') {
        reportManagedProgress({ id: managedStepRef.current, status: 'failed', message: errorMessage(initializeError) })
        setManagedFlowLocked(false)
      }
    } finally {
      initializationBusyRef.current = false
    }
  }

  useEffect(() => {
    if (authorizationMode !== 'managed' || autoInitializationStartedRef.current) return
    autoInitializationStartedRef.current = true
    void startInitialization('managed')
  }, [authorizationMode])

  const enterDashboard = async () => {
    if (completionBusyRef.current) return
    completionBusyRef.current = true
    setFinishing(true)
    if (authorizationMode === 'managed') setManagedFlowLocked(true)
    setError('')
    try {
      await onComplete(authorizationMode === 'managed' ? reportManagedProgress : undefined)
    } catch (completeError) {
      completionBusyRef.current = false
      setFinishing(false)
      setError(errorMessage(completeError))
      if (authorizationMode === 'managed') {
        reportManagedProgress({ id: managedStepRef.current, status: 'failed', message: errorMessage(completeError) })
        setManagedFlowLocked(false)
      }
    }
  }

  useEffect(() => {
    if (
      authorizationMode !== 'managed'
      || stage !== 'ready'
      || autoCompletionStartedRef.current
    ) return
    autoCompletionStartedRef.current = true
    void enterDashboard()
  }, [authorizationMode, stage])

  const installedCount = status
    ? [status.runtime.node, status.runtime.npm, status.cli, status.desktop]
        .filter((item) => item.installed).length
    : 0
  const busy = action !== 'idle'
  const flowLocked = authorizationMode === 'managed' && managedFlowLocked
  // A detection failure must not be steered toward "install this", since the
  // tool it names may already be present — only a retry can tell.
  const anyDetectionFailed = Boolean(status && [
    status.runtime.node,
    status.runtime.npm,
    status.cli,
    status.desktop,
  ].some((item) => isDetectionFailed(item)))

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
            label="授权配置"
            detail={authorizationMode === 'managed' ? '读取账号专属 Key' : '验证 API 授权码'}
            active={stage === 'authorize'}
            complete={stage !== 'authorize'}
          />
          <OnboardingStep
            index={2}
            label="环境安装"
            detail="安装运行组件"
            active={stage === 'setup'}
            complete={stage === 'ready'}
          />
          <OnboardingStep
            index={3}
            label="准备完成"
            detail="进入工具概览"
            active={stage === 'ready'}
            complete={false}
          />
        </div>

        <div className="onboarding-rail-bottom">
          {existingCodex?.exists && onCancel && (
            <button
              type="button"
              className="sidebar-control-button"
              title="返回工作台，不会修改现有配置"
              disabled={flowLocked}
              onClick={onCancel}
            >
              <ArrowLeft size={15} />
              <span>返回工作台</span>
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
                  <span>CODEX QUICK SETUP</span>
                  <h1>初始化 Codex 配置</h1>
                  <p>{authorizationMode === 'managed'
                    ? '已登录星芒账号，正在自动完成配置与运行环境准备。'
                    : '验证授权码后，自动完成配置与运行环境准备。'}</p>
                </div>
              </div>

              {authorizationMode === 'managed' && (
                <ManagedBootstrapPanel progress={managedProgress} locked={flowLocked} />
              )}

              {existingCodex?.exists && (
                <div className="onboarding-notice">
                  <AlertCircle size={17} />
                  <span>检测到现有 Codex 配置不是星芒 AI，初始化前会创建时间戳备份。</span>
                </div>
              )}

              <div className="onboarding-form">
                {authorizationMode === 'managed' ? (
                  <div className="onboarding-managed-authorization" role="status" aria-live="polite">
                    <div className="onboarding-managed-authorization-icon">
                      {busy ? <LoaderCircle size={19} className="spin" /> : <ShieldCheck size={19} />}
                    </div>
                    <div>
                      <strong>{busy ? '正在自动配置账号授权' : error ? '自动配置未完成' : '账号授权已就绪'}</strong>
                      <span>使用本地保存的 codex-pro 专属 Key，无需手动填写。</span>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="field-label-row">
                      <label htmlFor="onboarding-api-key">安装授权码</label>
                      <button
                        type="button"
                        className="key-link-button"
                        onClick={() => void window.xingmang.openExternal(relaySite.keysPageUrl)}
                      >
                        没有授权码？前往获取
                        <ExternalLink size={13} />
                      </button>
                    </div>
                    <div className="input-with-action onboarding-key-input">
                      <input
                        id="onboarding-api-key"
                        type="text"
                        value={showKey ? apiKey : maskedApiKey(apiKey || existingCodex?.apiKeyPreview || '')}
                        onChange={(event) => setApiKey(event.target.value)}
                        onFocus={() => {
                          if (!showKey) setShowKey(true)
                        }}
                        onBlur={() => {
                          // 未输入新 Key 时失焦恢复掩码，保留已保存 Key 的预览。
                          if (!apiKey) setShowKey(false)
                        }}
                        placeholder="请输入 API Key"
                        spellCheck={false}
                        autoComplete="off"
                        readOnly={!showKey}
                      />
                      <button
                        type="button"
                        title={!apiKey && existingCodex?.apiKeyPreview
                          ? '已保存的 Key 不可查看，输入新 Key 可替换'
                          : showKey ? '隐藏授权码' : '显示授权码'}
                        onClick={() => setShowKey((value) => !value)}
                      >
                        {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
                      </button>
                    </div>
                  </>
                )}

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
                  disabled={flowLocked || busy || (authorizationMode === 'manual' && !apiKey.trim())}
                  onClick={() => void startInitialization(authorizationMode)}
                >
                  {busy
                    ? <LoaderCircle size={18} className="spin" />
                    : authorizationMode === 'managed' ? <RefreshCw size={18} /> : <MonitorDown size={18} />}
                  {busy
                    ? authorizationMode === 'managed' ? '正在读取本地 Key 并写入配置' : '正在验证并写入配置'
                    : authorizationMode === 'managed' && error ? '重新初始化' : '开始初始化'}
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
                  <h1>{stage === 'ready' ? (status?.desktop.installed ? 'Codex 已准备就绪' : 'Codex CLI 已准备就绪') : '正在准备 Codex 环境'}</h1>
                  <p>{stage === 'ready'
                    ? status?.desktop.installed
                      ? '配置与运行环境均已完成，可以进入工具概览。'
                      : '桌面端尚未安装，可以先进入工具概览，稍后继续安装。'
                    : '正在依次检测并安装 Codex 所需组件。'}</p>
                </div>
              </div>

              {authorizationMode === 'managed' && (
                <ManagedBootstrapPanel progress={managedProgress} locked={flowLocked} />
              )}

              {authorizationMode === 'manual' && (
                <>
                  <div className="setup-progress-row">
                    <span>初始化进度</span>
                    <strong>{installedCount}/4</strong>
                  </div>
                  <div className="setup-progress"><span style={{ width: `${installedCount * 25}%` }} /></div>

                  <div className="setup-check-list">
                    <SetupCheckItem label="Node.js" detail={status?.runtime.node.version ?? 'Codex CLI 前置环境'} status={status?.runtime.node ?? null} loading={(action === 'scanning' && !status) || action === 'installing-node'} />
                    <SetupCheckItem label="npm" detail={status?.runtime.npm.version ?? 'Node.js 包管理器'} status={status?.runtime.npm ?? null} loading={(action === 'scanning' && !status) || action === 'installing-node'} />
                    <SetupCheckItem label="Codex CLI" detail={status?.cli.version ?? '@openai/codex'} status={status?.cli ?? null} loading={action === 'installing-cli'} />
                    <SetupCheckItem
                      label="Codex 桌面端"
                      detail={action === 'installing-desktop' ? codexDesktopInstallLabel(desktopInstallProgress) : status?.desktop.installed ? platformPresentation(platform).codexDesktopClient : platform.isMac ? '可通过 Codex CLI 打开' : '等待安装最新版'}
                      status={status?.desktop ?? null}
                      loading={action === 'installing-desktop'}
                    />
                  </div>
                </>
              )}

              {nodeInstallProgress && action === 'installing-node' && (
                <div className={`node-runtime-progress phase-${nodeInstallProgress.phase}`} role="status" aria-live="polite">
                  <div>
                    <span>{nodeInstallProgress.message}</span>
                    {nodeInstallProgress.percent !== null && <strong>{Math.round(nodeInstallProgress.percent)}%</strong>}
                  </div>
                  <progress max="100" value={nodeInstallProgress.percent ?? undefined} />
                </div>
              )}

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
                    {finishing ? '正在载入工具概览' : '进入工具概览'}
                    {!finishing && <ArrowRight size={17} />}
                  </button>
                ) : desktopInstallRecovery ? null : anyDetectionFailed ? (
                  // At least one probe could not confirm its result — offering an
                  // install action here could reinstall over an already-working
                  // setup, so the only safe move is to let the user retry detection.
                  <button type="button" className="secondary-button" disabled={flowLocked || busy} onClick={() => void runSetup()}>
                    <RefreshCw size={16} className={action === 'scanning' ? 'spin' : ''} /> 重新检测
                  </button>
                ) : !status || !nodeRuntimeSupported(status.runtime) || !status.runtime.npm.installed ? (
                  <>
                    <button type="button" className="primary-button" disabled={flowLocked || busy} onClick={() => void installNodeAndContinue()}>
                      {action === 'installing-node' ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
                      {action === 'installing-node' ? '正在安装 Node.js' : platformPresentation(platform).nodeActionLabel}
                    </button>
                    <button type="button" className="secondary-button" disabled={flowLocked || busy} onClick={() => setNodeGuideOpen(true)}>
                      <BookOpen size={16} /> 安装教程
                    </button>
                    <button type="button" className="secondary-button" disabled={flowLocked || busy} onClick={() => void runSetup()}>
                      <RefreshCw size={16} className={action === 'scanning' ? 'spin' : ''} /> 重新检测
                    </button>
                  </>
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
      {nodeGuideOpen && (
        <NodeInstallGuide
          runtime={status?.runtime ?? null}
          platform={platform}
          busy={busy || flowLocked}
          installProgress={nodeInstallProgress}
          onClose={() => setNodeGuideOpen(false)}
          onInstall={() => void installNodeAndContinue()}
          onRecheck={() => {
            setNodeGuideOpen(false)
            void runSetup()
          }}
        />
      )}
    </div>
  )
}
