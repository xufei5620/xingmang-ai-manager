import { useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { isMacosDesktopAppManagementBlocked } from '../../../../electron/macos-desktop-install-failure'
import { operationFailureFrom } from '../../business-common'
import type { LatestRequest } from '../../latest-request'
import type { OperationFailure } from '../app/OperationErrorDialog'
import type { AppToast, PendingConfirmation, Toolbox, ToolsApi } from '../app/runtime-context'
import { offlineActionMessage } from '../shell/online-status'
import {
  desktopUpdateBlockedPrompt,
  desktopUpdatedMessage,
  desktopUpdateRunningPrompt,
  withoutDesktopTool,
  type DesktopUpdateTool,
} from './desktop-update'

interface DesktopAppUpdateOptions {
  toolsApi: ToolsApi
  toolbox: Toolbox
  toast: AppToast
  offline: boolean
  mounted: RefObject<boolean>
  accountEpoch: LatestRequest
  setConfirmation: Dispatch<SetStateAction<PendingConfirmation | null>>
  setOperationError: Dispatch<SetStateAction<OperationFailure | null>>
  /** 星芒关掉的那一份帮它重新打开：走首页同一个「打开」。 */
  reopen(tool: DesktopUpdateTool): void
}

/**
 * Mac 上首页「可更新到 v…」那一下（Codex 桌面端、Claude Desktop、OpenCode，yoyo 2026-10-27「桌面端更新改」）：
 * 开着先问一句，点了「关掉并更新」主进程才请它退出；进度挂在工具卡上（toolbox.run）。Mac 的「App 管理」
 * 拦住时弹「去打开」那个框，别的原因没更新成时卡片上留一句和「看原因」。星芒关掉的那一份，更新完、
 * 或者没更新成而旧版关着，都帮它重新打开。
 */
export function useDesktopAppUpdate(options: DesktopAppUpdateOptions) {
  const { toolsApi, toolbox, toast, offline, mounted, accountEpoch, setConfirmation, setOperationError, reopen } = options
  // 正在更新的那一次要更到哪一版：进度那一行开头写「更新到 v…」。
  const [targets, setTargets] = useState<Partial<Record<DesktopUpdateTool, string>>>({})
  // 没更新成的那几个：卡片写「没更新成，旧版还在，照常能用」，「看原因」再弹一次同一个错误框。
  const [failures, setFailures] = useState<Partial<Record<DesktopUpdateTool, OperationFailure>>>({})
  // 现看它开没开着那一两秒里再点一下，不再问第二遍。
  const checking = useRef(new Set<DesktopUpdateTool>())

  function knownRunning(tool: DesktopUpdateTool): boolean {
    if (tool === 'codexDesktop') return toolbox.snapshot?.system.desktopApps.codex.running ?? false
    return toolbox.externalClients.find((status) => status.tool === tool)?.running ?? false
  }

  async function runningNow(tool: DesktopUpdateTool, fallback: boolean): Promise<boolean> {
    try { return await toolsApi.readMacDesktopRunning(tool) } catch { return fallback }
  }

  async function request(tool: DesktopUpdateTool, version: string) {
    if (offline) { toast.show(offlineActionMessage, 'warn'); return }
    if (toolbox.jobs[tool] || checking.current.has(tool)) return
    const target = version.replace(/^v/, '')
    checking.current.add(tool)
    let running: boolean
    // 首页那份「运行中」可能是几分钟前的，问之前现看一眼；看不了就照首页那份。主进程换之前还会再看一次。
    try { running = await runningNow(tool, knownRunning(tool)) } finally { checking.current.delete(tool) }
    if (!mounted.current) return
    if (!running) { void run(tool, target, false); return }
    // 确认框马上关掉，进度交给工具卡片，同「退回」。
    setConfirmation({ ...desktopUpdateRunningPrompt(tool), work: async () => { void run(tool, target, true) } })
  }

  async function refresh(tool: DesktopUpdateTool) {
    await (tool === 'codexDesktop' ? toolbox.refresh(true) : toolbox.refreshExternal(true))
  }

  async function run(tool: DesktopUpdateTool, target: string, closeRunning: boolean) {
    const epoch = accountEpoch.capture()
    const before = tool === 'codexDesktop' ? null : toolbox.externalClients.find((status) => status.tool === tool)?.version ?? null
    setFailures((current) => withoutDesktopTool(current, tool))
    setOperationError(null)
    setTargets((current) => ({ ...current, [tool]: target }))
    let updatedTo: string | null = null
    try {
      const completed = await toolbox.run(tool, `正在安装 ${target}`, async () => {
        const outcome = await toolsApi.updateMacDesktopApp(tool, { update: true, closeRunning })
        updatedTo = outcome.kind === 'codexDesktop'
          ? outcome.result.action === 'updated' ? outcome.result.installedVersion : null
          : outcome.status.version && outcome.status.version !== before ? outcome.status.version : null
        // 重新检测也留在同一个任务里：任务一结束卡片就回落到更新前的快照，版本号会先退回旧的（同 install）。
        await refresh(tool).catch(() => undefined)
      }, {
        cancel: () => tool === 'codexDesktop' ? toolsApi.cancelInstall(tool) : toolsApi.cancelExternalInstall(tool),
        notice: { updating: true },
      })
      if (completed && updatedTo && mounted.current && epoch()) toast.show(desktopUpdatedMessage(tool, updatedTo), 'ok')
    } catch (cause) {
      if (!mounted.current) return
      await refresh(tool).catch(() => undefined)
      const action = '更新工具'
      const failure: OperationFailure = { ...operationFailureFrom(cause, action), action, retry: () => void request(tool, target), ...(tool === 'codexDesktop' ? { tool } : {}) }
      if (!mounted.current) return
      if (isMacosDesktopAppManagementBlocked(failure.message) || isMacosDesktopAppManagementBlocked(failure.detail ?? '')) {
        setConfirmation({ ...desktopUpdateBlockedPrompt(target), work: async () => { await toolsApi.openAppManagementSettings() } })
      } else setFailures((current) => ({ ...current, [tool]: failure }))
    } finally {
      if (mounted.current) setTargets((current) => withoutDesktopTool(current, tool))
    }
    // 星芒关掉的才帮它开；没更新成、旧版还开着的不用开。
    if (closeRunning && mounted.current && !await runningNow(tool, true)) reopen(tool)
  }

  /** 卡片上的「看原因」：把那次的错误框再打开。 */
  function showFailure(tool: DesktopUpdateTool) {
    const failure = failures[tool]
    if (failure) setOperationError(failure)
  }

  return { desktopUpdateTargets: targets, desktopUpdateFailures: failures, requestDesktopUpdate: request, showDesktopUpdateFailure: showFailure }
}
