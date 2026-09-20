import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DesktopAppStatus, ExternalClientStatus, InstallProgress, XingmangApi } from '../../../../electron/ipc-contract'
import { createToolsApi, type ToolboxPartitionFailure } from './api'
import type { ToolboxSnapshot } from './model'
import { platformApi } from '../../platform-api'
import { errorMessage } from '../../business-common'

export interface ToolJob { label: string; percent?: number; log: string[] }

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
      if (!current[key]) return current
      return { ...current, [key]: { label, percent, log: [...current[key].log, label].slice(-200) } }
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
  const run = useCallback(async (key: string, label: string, operation: (report: ToolJobReport) => Promise<unknown>) => {
    if (locks.current.has(key)) return false
    locks.current.add(key)
    setJobs((current) => ({ ...current, [key]: { label, log: [label] } }))
    const report: ToolJobReport = (next, percent) => {
      if (!active.current) return
      setJobs((current) => {
        if (!current[key]) return current
        return { ...current, [key]: { label: next, percent, log: [...current[key].log, next].slice(-200) } }
      })
    }
    try {
      await operation(report)
      if (!key.startsWith('launch:') && /安装|更新|准备运行环境/.test(label)) {
        void platformApi()?.notifyActivity('install', `install:${key}:${Date.now()}`).catch(() => undefined)
      }
      return true
    } finally {
      locks.current.delete(key)
      if (active.current) setJobs((current) => { const next = { ...current }; delete next[key]; return next })
    }
  }, [])
  return { snapshot, loading, error, failures, refresh, externalClients, externalLoading, externalError, refreshExternal, jobs, run, setSnapshot }
}
