import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { AppSettingsV2, XingmangApi } from '../../../../electron/ipc-contract'
import { errorMessage } from '../../business-common'
import { diagnosticsRevision, publishDiagnosticsCounts } from './environment-status'
import { crashReportingNotice, displayRelaunchNotice, startupCheckFailure, startupCheckLogContext, startupDiagnosticsIssues, toolRouteRestartNotice, withStartupNotice, withoutStartupNotice, type StartupCheckId, type StartupNotice } from './startup-notice'
import type { AppApi, AppToast, Perform } from './runtime-context'

/** 角落那一摞启动提示（StartupNotices）：谁都能往里挂一条，用户随手能关。 */
export function useStartupNotices(native: XingmangApi, mounted: RefObject<boolean>) {
  const [startupNotices, setStartupNotices] = useState<readonly StartupNotice[]>([])
  // 启动时自动跑的检查不许弹模态框：用户什么都没点，却会被挡在欢迎页上点不动
  // 任何东西。坏消息改挂在角落、随手能关，检查本身照跑、失败照样进运行日志
  // ——主进程按通道记一条，这里再记一条写明是哪一次启动检查。
  const noteStartupCheck = useCallback((notice: StartupNotice) => {
    if (!mounted.current) return
    setStartupNotices((current) => withStartupNotice(current, notice))
    if (!notice.failure) return
    void native.reportRendererError({ message: `${notice.title}：${notice.body}`, context: startupCheckLogContext(notice.id), level: 'warn' }).catch(() => undefined)
  }, [native, mounted])
  // 换线路的重开提示每条只弹一次：窗口重载、同一条提示又被读到时不再弹。
  const shownRouteRestartHint = useRef<number | null>(null)
  const showRouteRestartHint = useCallback((next: AppSettingsV2) => {
    const hint = next.toolRouteRestartHint
    if (!hint || shownRouteRestartHint.current === hint.id) return
    shownRouteRestartHint.current = hint.id
    const notice = toolRouteRestartNotice(hint)
    if (notice) noteStartupCheck(notice)
  }, [noteStartupCheck])
  const dismissStartupNotice = useCallback((id: StartupCheckId) => {
    setStartupNotices((current) => withoutStartupNotice(current, id))
  }, [])
  return { startupNotices, noteStartupCheck, showRouteRestartHint, dismissStartupNotice }
}

interface StartupChecksOptions {
  native: XingmangApi
  app: AppApi
  boot: 'loading' | 'ready' | 'failed'
  settings: AppSettingsV2 | null
  setSettings: Dispatch<SetStateAction<AppSettingsV2 | null>>
  authenticated: boolean
  noteStartupCheck(notice: StartupNotice): void
  perform: Perform
  toast: AppToast
  mounted: RefObject<boolean>
}

/** 登录进来以后那几件只做一次的检查：开机环境检查、错误报告告知；外加角落里兼容显示、错误报告两张卡上的二选一。 */
export function useStartupChecks({ native, app, boot, settings, setSettings, authenticated, noteStartupCheck, perform, toast, mounted }: StartupChecksOptions) {
  const diagnosticsStarted = useRef(false)
  useEffect(() => {
    if (boot !== 'ready' || !authenticated || !settings?.runDiagnosticsOnStartup || diagnosticsStarted.current) return
    diagnosticsStarted.current = true
    // 开机这次紧跟着首页扫描，让主进程直接用那轮的探测结果，不再重跑一遍子进程。
    const started = diagnosticsRevision()
    void native.runDiagnostics({ reuseRecentScan: true }).then((report) => {
      if (!mounted.current) return
      publishDiagnosticsCounts(report.counts, started)
      const notice = startupDiagnosticsIssues(report.counts)
      if (notice) noteStartupCheck(notice)
    }).catch((cause) => { if (mounted.current) noteStartupCheck(startupCheckFailure('diagnostics', errorMessage(cause, '启动环境检查没有完成'))) })
  }, [boot, native, noteStartupCheck, authenticated, settings?.runDiagnosticsOnStartup, mounted])
  // 兼容显示提示里的二选一：两颗都写进设置，主进程据此清掉崩溃记录。「一直用」现在
  // 已经是兼容方式，不用重开；「恢复」要重开才生效，接着给一颗「现在重开」。
  const chooseDisplayCompat = useCallback((choice: 'keep' | 'restore') => perform('保存显示方式', async () => {
    setSettings(await app.savePreferences({ version: 2, hardwareAcceleration: choice === 'restore' }))
    if (choice === 'restore') noteStartupCheck(displayRelaunchNotice())
    else toast.show('以后都用兼容方式显示。想改回来，到「设置」的「外观显示」里打开「用显卡加速显示」。', 'ok')
  }), [app, noteStartupCheck, perform, setSettings, toast])
  // 错误报告告知：登录进来后说一次，这次运行里只出一回。两颗按钮都记下「已告知」，
  // 「不想发送」同时把上报关掉，和设置页那个开关是同一个设置。
  const crashNoticeOffered = useRef(false)
  useEffect(() => {
    if (boot !== 'ready' || crashNoticeOffered.current) return
    const notice = crashReportingNotice(settings, authenticated)
    if (!notice) return
    crashNoticeOffered.current = true
    noteStartupCheck(notice)
  }, [boot, noteStartupCheck, authenticated, settings])
  const chooseCrashReporting = useCallback((choice: 'keep' | 'off') => perform('保存错误报告设置', async () => {
    setSettings(await app.savePreferences({ version: 2, crashReportingNoticeShown: true, ...(choice === 'off' ? { crashReporting: false } : {}) }))
    if (choice === 'off') toast.show('已关掉，出错时不再发送错误报告。想重新打开，到「设置」的「隐私数据」里。', 'ok')
  }), [app, perform, setSettings, toast])
  return { chooseDisplayCompat, chooseCrashReporting }
}
