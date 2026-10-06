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
// 环境被改过几次（markDiagnosticsStale）。一轮检查开跑时记下它、跑完对一下：中间改过的话，
// 查到的可能是改之前的样子。
let revision = 0
const listeners = new Set<() => void>()

/** 一轮检查开跑之前记下它，跑完连同结果交给 publishDiagnosticsCounts。 */
export function diagnosticsRevision(): number {
  return revision
}

/** startedAt 缺省 = 不核对开跑以后环境改没改过（旧行为）。 */
export function publishDiagnosticsCounts(counts: StartupDiagnosticsCounts, startedAt = revision): void {
  // 查到一半，首页那边装完、改完了：这份数可能是改之前的，状态栏照旧摆灰点，等下一轮。
  if (startedAt !== revision) return
  latestCounts = { warn: counts.warn, fail: counts.fail, error: counts.error }
  notify()
}

/**
 * 首页装完、卸完、改完设置以后，上一次检查的结论就说不准了：状态栏退回灰点「环境待检测」（已知6）。
 * 不在后台替客户重查，那要多起一轮探测（好几个子进程加一趟联网）；点进检查页，它自己会查。
 */
export function markDiagnosticsStale(): void {
  revision++
  latestCounts = null
  notify()
}

/**
 * 工具行上的任务收尾了没有。装、卸、换来源、修提醒设置、装运行环境，做完了（不管成没成）环境都可能
 * 变了；「打开」（launch:）只是把工具开起来，不改环境，不算。
 */
export function environmentJobsFinished(previous: readonly string[], current: readonly string[]): boolean {
  return previous.some((key) => !key.startsWith('launch:') && !current.includes(key))
}

function notify() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function readCounts() {
  return latestCounts
}

function readRevision() {
  return revision
}

export function useDiagnosticsCounts(): StartupDiagnosticsCounts | null {
  return useSyncExternalStore(subscribe, readCounts, readCounts)
}

/** 检查页开着的时候环境变了，它拿这个认出来、跟着重查。 */
export function useDiagnosticsRevision(): number {
  return useSyncExternalStore(subscribe, readRevision, readRevision)
}
