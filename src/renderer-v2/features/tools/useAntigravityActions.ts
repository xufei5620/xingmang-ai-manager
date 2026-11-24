import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { AccountSessionState, AntigravityDesktopLaunchResult, AntigravityInstallResult, AntigravityTarget } from '../../../../electron/ipc-contract'
import type { LatestRequest } from '../../latest-request'
import type { AuthMode } from '../auth'
import type { AppToast, Toolbox, ToolsApi } from '../app/runtime-context'
import { antigravityCloseFirstNotice, antigravityInstallNotice, antigravityJobKey, antigravityPreparingLabel } from './antigravity'
import { launchWaitLabel } from './launch-notice'
import { jobToolName } from './tool-jobs'

interface AntigravityActionsOptions {
  toolsApi: ToolsApi
  toolbox: Toolbox
  toast: AppToast
  session: AccountSessionState
  mounted: RefObject<boolean>
  accountEpoch: LatestRequest
  setAuth: Dispatch<SetStateAction<AuthMode | null>>
}

/**
 * 首页 Antigravity 两张卡上的「安装」「打开」。进度挂在卡片上（toolbox.run，编号同卡片）；
 * 安装、打开在主进程都排同一个队（I11），前面有人在装时「打开」那一行说在等谁。
 */
export function useAntigravityActions(options: AntigravityActionsOptions) {
  const { toolsApi, toolbox, toast, session, mounted, accountEpoch, setAuth } = options

  // 装好以后主进程接着按当前账号写设置；没写成（没登录、服务暂时不可用）也算装好了，那句原因随结果回来。
  async function install(target: AntigravityTarget) {
    const epoch = accountEpoch.capture()
    const outcome: { result?: AntigravityInstallResult } = {}
    try {
      const completed = await toolbox.run(antigravityJobKey(target), antigravityPreparingLabel, async () => { outcome.result = await toolsApi.installAntigravity(target) })
      const result = outcome.result
      if (!completed || !result || !mounted.current) return
      toolbox.noteAntigravityStatus(result.status)
      if (!epoch()) return
      const notice = antigravityInstallNotice(target, result)
      toast.show(notice.text, notice.tone)
    } catch (cause) { if (mounted.current && epoch()) throw cause }
  }

  /**
   * 打开前主进程现签密钥、现写设置，没登录写不了，先去登录。命令行在记住的那个项目文件夹里开，
   * 没记住过或客户点了「选择其他文件夹…」就先弹选择窗口。
   */
  async function open(target: AntigravityTarget, chooseFolder = false) {
    if (!session.authenticated || !session.account) { setAuth('login'); return }
    const epoch = accountEpoch.capture()
    const key = `launch:${antigravityJobKey(target)}`
    try {
      if (target === 'cli') {
        const remembered = chooseFolder ? undefined : toolbox.snapshot?.config.rememberedWorkspace
        const workspace = remembered ?? await toolsApi.chooseWorkspace()
        if (!workspace || !mounted.current || !epoch()) return
        const opened = await toolbox.run(key, launchWaitLabel(toolbox.jobs, jobToolName), () => toolsApi.openAntigravityCli(workspace))
        if (opened && mounted.current) void toolbox.refreshAntigravity()
        return
      }
      const outcome: { result?: AntigravityDesktopLaunchResult } = {}
      const opened = await toolbox.run(key, launchWaitLabel(toolbox.jobs, jobToolName), async () => { outcome.result = await toolsApi.openAntigravityDesktop() })
      if (!opened || !mounted.current) return
      void toolbox.refreshAntigravity()
      if (epoch() && outcome.result?.closeFirst) toast.show(antigravityCloseFirstNotice, 'warn')
    } catch (cause) { if (mounted.current && epoch()) throw cause }
  }

  return { installAntigravity: install, openAntigravity: open }
}
