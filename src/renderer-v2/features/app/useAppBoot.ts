import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { AccountSessionState, AppSettingsV2, PlatformCapabilities, UpdateSnapshot, XingmangApi } from '../../../../electron/ipc-contract'
import { useLatestRequest } from '../../latest-request'
import { errorMessage } from '../../business-common'
import { onboardingPreviewEnabled } from './dev-preview'
import { claudeDesktopRepairedNotice, displayCompatNotice, settingsSaveNotice, startupCheckFailure, unexpectedExitNotice, updatedNotice, type StartupNotice } from './startup-notice'
import type { SupportFailure } from './SupportIdentity'
import type { AppApi } from './runtime-context'

interface AppBootOptions {
  native: XingmangApi
  app: AppApi
  noteStartupCheck(notice: StartupNotice): void
  showRouteRestartHint(settings: AppSettingsV2): void
  setLastFailure: Dispatch<SetStateAction<SupportFailure | null>>
  setGuide: Dispatch<SetStateAction<boolean>>
}

/**
 * 开机那一趟：设置、平台能力、会话、更新状态一起读回来，读完才放出主界面（之前只摆启动页）；
 * 读完顺带把这次开机要说的几句挂到角落，按设置决定要不要马上查一次更新。
 */
export function useAppBoot({ native, app, noteStartupCheck, showRouteRestartHint, setLastFailure, setGuide }: AppBootOptions) {
  const [boot, setBoot] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [bootError, setBootError] = useState('')
  const [bootAttempt, setBootAttempt] = useState(0)
  const [settings, setSettings] = useState<AppSettingsV2 | null>(null)
  const [platform, setPlatform] = useState<PlatformCapabilities | null>(null)
  const [systemLabel, setSystemLabel] = useState<string | undefined>(undefined)
  const [session, setSession] = useState<AccountSessionState>({ authenticated: false, account: null })
  const [update, setUpdate] = useState<UpdateSnapshot | null>(null)
  // 缩到托盘关掉界面以后重新加载的这一次（electron/renderer-release.ts）：开机那几句、检查更新这次运行里已经做过。
  const [restoredBoot, setRestoredBoot] = useState(false)
  // 会话变化事件一来就作废开机读到的那份会话。启动那次读取可能在事件之后才落地（账号恢复超时先放行
  // 时两者会赛跑），那时手上的会话已经比它新，不能再拿它盖回去。
  const sessionEvents = useLatestRequest()
  useEffect(() => {
    let current = true
    const noSessionEventSince = sessionEvents.capture()
    setBoot('loading'); setBootError('')
    void app.bootstrap().then((result) => {
      if (!current) return
      setSettings(result.settings); setPlatform(result.platform); setUpdate(result.update); setSystemLabel(result.capabilities.systemLabel)
      if (noSessionEventSince()) setSession(result.session)
      // 低配电脑只由主进程判断一次；这里只把结论挂到根节点上，星空背景据此只画静态一帧。
      document.documentElement.dataset.lowEnd = String(result.capabilities.lowEndDevice === true)
      // 预览开关要等主进程说清这是不是打包版才生效，所以放在 bootstrap 里而不是
      // 初始 state；`boot !== 'ready'` 期间只渲染 Splash，用户看不到中间态。
      if (onboardingPreviewEnabled(window.location.search, result.update.development)) setGuide(true)
      // 本机工具里已经有 Key 也不再绕过欢迎页直接进首页：那样进来的人看不到登录按钮，
      // 退出登录后再开软件也找不回账号。没登录就先到欢迎页，登录或看使用步骤由用户点。
      // 工具配置文件原样保留，终端里照常能用。
      setBoot('ready')
      if (result.capabilities.rendererRestored) {
        setRestoredBoot(true)
        // 换线路的提示是运行中来的，关着的那会儿也可能来了新的；它自己记着哪条说过（useStartupNotices）。
        showRouteRestartHint(result.settings)
        return
      }
      const updated = updatedNotice(result.update.currentVersion, result.update.installedRelease)
      if (updated) noteStartupCheck(updated)
      const settingsSave = settingsSaveNotice(result.capabilities.settingsSaveIssue)
      if (settingsSave) noteStartupCheck(settingsSave)
      const displayCompat = displayCompatNotice(result.capabilities)
      if (displayCompat) noteStartupCheck(displayCompat)
      const unexpectedExit = unexpectedExitNotice(result.capabilities)
      if (unexpectedExit) {
        noteStartupCheck(unexpectedExit)
        // 帮助框的「最近一次出错」也记上这一次：他没点卡片、直接去找客服时同样带得上。
        if (unexpectedExit.action && 'supportFailure' in unexpectedExit.action) setLastFailure(unexpectedExit.action.supportFailure)
      }
      const claudeDesktopRepaired = claudeDesktopRepairedNotice(result.capabilities, result.platform.platform)
      if (claudeDesktopRepaired) noteStartupCheck(claudeDesktopRepaired)
      showRouteRestartHint(result.settings)
      if (result.settings.checkUpdatesOnStartup && result.update.phase !== 'disabled') {
        void app.startupUpdate().then((checked) => { if (current) setUpdate(checked) }).catch((cause) => {
          if (current) noteStartupCheck(startupCheckFailure('update', errorMessage(cause, '更新检查没有完成')))
        })
      }
    }).catch((cause) => {
      if (current) { setBootError(errorMessage(cause, '启动检查没有完成')); setBoot('failed') }
    })
    return () => { current = false }
  }, [app, bootAttempt, noteStartupCheck, showRouteRestartHint, sessionEvents, setGuide, setLastFailure])
  useEffect(() => native.onUpdateState(setUpdate), [native])
  const retryBoot = useCallback(() => setBootAttempt((value) => value + 1), [])
  return { boot, bootError, retryBoot, settings, setSettings, platform, systemLabel, session, setSession, update, setUpdate, sessionEvents, restoredBoot }
}
