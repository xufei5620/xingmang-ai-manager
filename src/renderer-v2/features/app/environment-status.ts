import { useSyncExternalStore } from 'react'
import { diagnosticsIssueCount, type StartupDiagnosticsCounts } from './startup-notice'

/** 状态栏最左那一项：一个点加一句话，点了去检查页。 */
export interface EnvironmentStatus {
  tone: 'ok' | 'warn' | 'neutral'
  label: string
  /** 鼠标停上去写的各运行环境版本；扫描结果还没回来时不写。 */
  detail?: string
}

interface RuntimeProbe {
  installed: boolean
  version: string | null
  detectionFailed?: boolean
}

export interface EnvironmentRuntimes {
  node: RuntimeProbe
  python: RuntimeProbe
  git: RuntimeProbe
}

/**
 * 只认检查页的「待处理」：「需留意」多半是用不到的东西没装，数进去的话只用一家工具的
 * 客户永远看到橙点（同开机那条提示的口径）。没检查过就是灰点，不猜。
 */
export function buildEnvironmentStatus(counts: StartupDiagnosticsCounts | null, runtimes?: EnvironmentRuntimes): EnvironmentStatus {
  const detail = runtimes ? environmentRuntimeSummary(runtimes) : undefined
  if (!counts) return { tone: 'neutral', label: '环境待检测', detail }
  const issues = diagnosticsIssueCount(counts)
  return issues > 0
    ? { tone: 'warn', label: `环境有 ${issues} 项需要处理`, detail }
    : { tone: 'ok', label: '环境正常', detail }
}

function runtimeState(probe: RuntimeProbe): string {
  if (probe.detectionFailed) return '检测失败'
  if (!probe.installed) return '没装'
  return probe.version ?? '已装'
}

export function environmentRuntimeSummary(runtimes: EnvironmentRuntimes): string {
  return `Node.js ${runtimeState(runtimes.node)} · Python ${runtimeState(runtimes.python)} · Git ${runtimeState(runtimes.git)}`
}

// 开机那次检查和检查页自己跑的都往这里报，状态栏读同一份：两处各自记着的话，在检查页
// 处理完一项回到别的页，状态栏还写着旧的数。
let latestCounts: StartupDiagnosticsCounts | null = null
const listeners = new Set<() => void>()

export function publishDiagnosticsCounts(counts: StartupDiagnosticsCounts): void {
  latestCounts = { warn: counts.warn, fail: counts.fail, error: counts.error }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function readCounts() {
  return latestCounts
}

export function useDiagnosticsCounts(): StartupDiagnosticsCounts | null {
  return useSyncExternalStore(subscribe, readCounts, readCounts)
}
