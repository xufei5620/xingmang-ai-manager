import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopAppStatus, InstallProgress, XingmangApi } from '../../../../electron/ipc-contract'
import { createToolsApi } from './api'
import type { ToolboxSnapshot } from './model'
import { platformApi } from '../../platform-api'

export interface ToolJob { label: string; percent?: number; log: string[] }

export function useToolbox(bridge: XingmangApi | null, enabled: boolean) {
  const [snapshot, setSnapshot] = useState<ToolboxSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [jobs, setJobs] = useState<Record<string, ToolJob>>({})
  const request = useRef(0)
  const active = useRef(true)
  const locks = useRef(new Set<string>())
  const desktopRevision = useRef(0)
  const latestDesktop = useRef<DesktopAppStatus | null>(null)
  const refresh = useCallback(async (force = false) => {
    if (!bridge) return
    const id = ++request.current
    const desktopAtStart = desktopRevision.current
    setLoading(true)
    setError('')
    try {
      const next = await createToolsApi(bridge).read(force)
      if (desktopRevision.current !== desktopAtStart && latestDesktop.current) next.system.desktopApps.codex = latestDesktop.current
      if (active.current && id === request.current) setSnapshot(next)
    } catch (cause) {
      if (active.current && id === request.current) setError(cause instanceof Error ? cause.message : '检测没有完成，请重试。')
      throw cause
    } finally {
      if (active.current && id === request.current) setLoading(false)
    }
  }, [bridge])
  useEffect(() => {
    active.current = true
    if (enabled) void refresh().catch(() => undefined)
    return () => { active.current = false; request.current++ }
  }, [enabled, refresh])
  useEffect(() => {
    if (!bridge) return
    const update = (key: string, label: string, percent?: number) => setJobs((current) => {
      if (!current[key]) return current
      return { ...current, [key]: { label, percent, log: [...current[key].log, label].slice(-200) } }
    })
    const callbacks = [
      bridge.onInstallProgress((event: InstallProgress) => update(event.provider, event.message)),
      bridge.onNodeRuntimeInstallProgress((event) => update('node', event.message, event.percent ?? undefined)),
      bridge.onPythonRuntimeInstallProgress((event) => update('python', event.message, event.percent ?? undefined)),
      bridge.onCodexDesktopInstallProgress((event) => update('codexDesktop', event.message, event.percent ?? undefined)),
      bridge.onCodexDesktopStatus((event) => {
        desktopRevision.current++
        latestDesktop.current = event.status
        setSnapshot((current) => current ? { ...current, system: { ...current.system, desktopApps: { codex: event.status } } } : current)
      }),
    ]
    return () => callbacks.forEach((unsubscribe) => unsubscribe())
  }, [bridge])
  const run = useCallback(async (key: string, label: string, operation: () => Promise<unknown>) => {
    if (locks.current.has(key)) return false
    locks.current.add(key)
    setJobs((current) => ({ ...current, [key]: { label, log: [label] } }))
    try {
      await operation()
      if (!key.startsWith('launch:') && /安装|更新|准备运行环境/.test(label)) {
        void platformApi()?.notifyActivity('install', `install:${key}:${Date.now()}`).catch(() => undefined)
      }
      return true
    } finally {
      locks.current.delete(key)
      if (active.current) setJobs((current) => { const next = { ...current }; delete next[key]; return next })
    }
  }, [])
  return { snapshot, loading, error, refresh, jobs, run, setSnapshot }
}
