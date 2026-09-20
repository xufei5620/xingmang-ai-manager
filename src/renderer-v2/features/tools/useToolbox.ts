import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DesktopAppStatus, ExternalClientStatus, InstallCancelResult, InstallProgress, XingmangApi } from '../../../../electron/ipc-contract'
import { createToolsApi, type ToolboxPartitionFailure } from './api'
import type { ToolboxSnapshot } from './model'
import { platformApi } from '../../platform-api'
import { errorMessage } from '../../business-common'

export interface ToolJob {
  label: string
  percent?: number
  log: string[]
  /** 这一步能不能中途取消；缺省 = 不能（旧行为）。 */
  cancellable?: boolean
  /** 取消已经发出去，还在等主进程收尾。 */
  cancelling?: boolean
}

export interface ToolJobOptions {
  /** 提供后工具行会出现「取消」；返回主进程是否真的接受了这次取消。 */
  cancel?: () => Promise<InstallCancelResult>
}

/** 让长任务在运行途中改写工具行上那句话（安装完成后还要同步 Key、重新检测）。 */
export type ToolJobReport = (label: string, percent?: number) => void

/** 安装命令已经返回、但同步 Key 与重新检测还没跑完时，工具行显示的那句话。 */
export const installedToolSyncLabel = '安装完成，正在同步账号 Key 并刷新状态'

export function useToolbox(bridge: XingmangApi | null, enabled: boolean, scope: string) {
  const [snapshot, setSnapshot] = useState<ToolboxSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [failures, setFailures] = useState<ToolboxPartitionFailure[]>([])
  const [externalClients, setExternalClients] = useState<ExternalClientStatus[]>([])
  const [externalLoading, setExternalLoading] = useState(false)
  const [externalError, setExternalError] = useState('')
  const externalRequest = useRef(0)
  const [jobs, setJobs] = useState<Record<string, ToolJob>>({})
  const request = useRef(0)
  const active = useRef(true)
  const locks = useRef(new Set<string>())
  const cancellers = useRef(new Map<string, () => Promise<InstallCancelResult>>())
  const cancelRequests = useRef(new Set<string>())
  const desktopRevision = useRef(0)
  const latestDesktop = useRef<DesktopAppStatus | null>(null)
  const currentScope = useRef(scope)
  useLayoutEffect(() => {
    currentScope.current = scope
    request.current++
    setSnapshot(null); setError(''); setFailures([]); setLoading(false)
    externalRequest.current++
    setExternalClients([]); setExternalError(''); setExternalLoading(false)
  }, [scope])
  const refreshExternal = useCallback(async () => {
    if (!bridge || currentScope.current !== scope) return
    const id = ++externalRequest.current
    setExternalLoading(true); setExternalError('')
    try {
      const statuses = await createToolsApi(bridge).readExternal()
      if (active.current && currentScope.current === scope && id === externalRequest.current) setExternalClients(statuses)
    } catch (cause) {
      if (active.current && currentScope.current === scope && id === externalRequest.current) setExternalError(errorMessage(cause, '客户端检测没有完成，请重试。'))
      throw cause
    } finally { if (active.current && id === externalRequest.current) setExternalLoading(false) }
  }, [bridge, scope])
  const refresh = useCallback(async (force = false) => {
    if (!bridge) return
    // Login completion can retain this callback from the preceding render.
    // Bind each read to the current account at invocation, not closure creation.
    const requestScope = currentScope.current
    const id = ++request.current
    const desktopAtStart = desktopRevision.current
    setLoading(true)
    setError('')
    const isCurrent = () => active.current && currentScope.current === requestScope && id === request.current
    try {
      const { snapshot: next, failures: partitions } = await createToolsApi(bridge).read(force)
      if (isCurrent()) setFailures(partitions)
      // 工具列表整块没读到时仍然向调用方抛错：安装、保存配置等流程
      // 靠它提示「最新状态没有读到」。单块降级不算失败。
      if (!next) throw new Error(partitions[0]?.message ?? '检测没有完成，请重试。')
      if (desktopRevision.current !== desktopAtStart && latestDesktop.current) next.system.desktopApps.codex = latestDesktop.current
      if (isCurrent()) setSnapshot(next)
    } catch (cause) {
      if (isCurrent()) setError(errorMessage(cause, '检测没有完成，请重试。'))
      throw cause
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [bridge])
  useEffect(() => {
    active.current = true
    if (enabled) { void refresh().catch(() => undefined); void refreshExternal().catch(() => undefined) }
    return () => { active.current = false; request.current++; externalRequest.current++ }
  }, [enabled, refresh, refreshExternal])
  useEffect(() => {
    if (!bridge) return
    const update = (key: string, label: string, percent?: number) => setJobs((current) => {
      const job = current[key]
      // 展开原来的 job：进度事件不能把「能不能取消」「正在取消」这两个标记洗掉，
      // 否则安装一有输出，取消按钮就消失了。
      if (!job) return current
      return { ...current, [key]: { ...job, label, percent, log: [...job.log, label].slice(-200) } }
    })
    const callbacks = [
      bridge.onInstallProgress((event: InstallProgress) => update(event.provider, event.message, event.percent)),
      bridge.onNodeRuntimeInstallProgress((event) => update('node', event.message, event.percent ?? undefined)),
      bridge.onPythonRuntimeInstallProgress((event) => update('python', event.message, event.percent ?? undefined)),
      bridge.onCodexDesktopInstallProgress((event) => update('codexDesktop', event.message, event.percent ?? undefined)),
      bridge.onExternalClientInstallProgress((event) => update(event.tool, event.message, event.percent ?? undefined)),
      bridge.onCodexDesktopStatus((event) => {
        desktopRevision.current++
        latestDesktop.current = event.status
        setSnapshot((current) => current ? { ...current, system: { ...current.system, desktopApps: { codex: event.status } } } : current)
      }),
    ]
    return () => callbacks.forEach((unsubscribe) => unsubscribe())
  }, [bridge])
  const run = useCallback(async (key: string, label: string, operation: (report: ToolJobReport) => Promise<unknown>, options?: ToolJobOptions) => {
    if (locks.current.has(key)) return false
    locks.current.add(key)
    cancelRequests.current.delete(key)
    if (options?.cancel) cancellers.current.set(key, options.cancel)
    setJobs((current) => ({ ...current, [key]: { label, log: [label], cancellable: Boolean(options?.cancel) } }))
    const report: ToolJobReport = (next, percent) => {
      if (!active.current) return
      setJobs((current) => {
        const job = current[key]
        // 同 update：展开原来的 job，别把「能不能取消」「正在取消」洗掉。
        if (!job) return current
        return { ...current, [key]: { ...job, label: next, percent, log: [...job.log, next].slice(-200) } }
      })
    }
    try {
      await operation(report)
      if (!key.startsWith('launch:') && /安装|更新|准备运行环境/.test(label)) {
        void platformApi()?.notifyActivity('install', `install:${key}:${Date.now()}`).catch(() => undefined)
      }
      return true
    } catch (cause) {
      // 用户自己点的取消不是失败：吞掉这次拒绝，调用方按「没做完」处理，
      // 界面就不会再弹一条红色的「安装工具没有完成」。
      if (cancelRequests.current.has(key)) return false
      throw cause
    } finally {
      locks.current.delete(key)
      cancellers.current.delete(key)
      cancelRequests.current.delete(key)
      if (active.current) setJobs((current) => { const next = { ...current }; delete next[key]; return next })
    }
  }, [])
  const markCancelling = useCallback((key: string, cancelling: boolean) => {
    setJobs((current) => current[key] ? { ...current, [key]: { ...current[key], cancelling } } : current)
  }, [])
  const cancel = useCallback(async (key: string): Promise<InstallCancelResult> => {
    const requestCancel = cancellers.current.get(key)
    if (!requestCancel) return { cancelled: false, reason: '这一步已经不能取消了。' }
    cancelRequests.current.add(key)
    markCancelling(key, true)
    let outcome: InstallCancelResult
    try { outcome = await requestCancel() }
    catch (cause) {
      cancelRequests.current.delete(key)
      if (active.current) markCancelling(key, false)
      throw cause
    }
    // 主进程拒绝了（正在写入工具目录那一步），这次安装还会继续跑完，
    // 所以取消标记要撤掉，否则真失败时会被当成取消默默吞掉。
    if (!outcome.cancelled) {
      cancelRequests.current.delete(key)
      if (active.current) markCancelling(key, false)
    }
    return outcome
  }, [markCancelling])
  return { snapshot, loading, error, failures, refresh, externalClients, externalLoading, externalError, refreshExternal, jobs, run, cancel, setSnapshot }
}
