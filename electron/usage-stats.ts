/**
 * 匿名使用统计（2026-10-26 yoyo 选了方案里的「推荐档」，方案全文在项目文件「遥测方案.md」）。
 *
 * 每台电脑每天最多发成一次，内容整个写在请求地址里，发到更新目录底下的 stats/：更新目录本来就挂在
 * Cloudflare 上，update-feed-stats 工作流拿现成的只读令牌按地址数。不带电脑编号：客户端自己保证一天
 * 只发成一次，所以「某天收到几条某版本」就是那天有几台电脑在用它。下好没装、试装没装上这种要把几天
 * 连起来看的事，客户端直接从本机的更新记录里带结论，不用服务器去拼。
 *
 * This module decides every byte that can leave the machine, so it stays free
 * of Electron and the disk and is pinned by tests. Each path segment comes from
 * a closed vocabulary or a strict version pattern, and anything else turns into
 * `x`. Free text never reaches the path: an error message (which may carry a
 * path, a user name or a key) is reduced in memory to one of five categories,
 * and only the category is counted.
 */
import { isInstallCancelledError } from './install-cancellation'
import { classifyNetworkFailure } from './network-failure'
import { npmFailureReasonFor, type NpmFailureKind } from './npm-failure-reasons'
import type { RelayEndpointRoutingSnapshot } from './relay-sites'

/**
 * 先发 Cloudflare 那份（Mac 每 15 分钟就读一次这里，国内连得上）；连不上再发洛杉矶那份，它把
 * /xingmang-manager/ 原样转给同一个地方。两处都是固定地址，不跟着账号或设置变。
 */
export const usageStatsOrigins = ['https://updatesnew.shenfengwl.fun', 'https://xm-direct.solov.cc'] as const
export const usageStatsPathPrefix = '/xingmang-manager/stats/'
const schemaVersion = 'v1'
export const usageStatsDisableEnvironmentKey = 'XINGMANG_DISABLE_USAGE_STATS'

export type UsageInstallTarget = 'claude' | 'codex' | 'grok' | 'codexDesktop' | 'claudeDesktop' | 'workbuddy' | 'opencode' | 'node' | 'git' | 'python'
export type UsageFailureCategory = NpmFailureKind
export type UsageUpdateStep = 'check' | 'download' | 'install'
export type UsageHangKind = 'unresponsive' | 'stall' | 'paymentSlow' | 'paymentFailed' | 'unexpectedExit'

export type UsageStatsEvent =
  | { kind: 'install'; target: UsageInstallTarget; category: UsageFailureCategory }
  | { kind: 'update'; step: UsageUpdateStep; category: UsageFailureCategory }
  | { kind: 'hang'; hang: UsageHangKind }

/** 键是 usageEventKey 给的那几种，值是 1 到 usageCounterCap 的整数。 */
export type UsageStatsCounters = Readonly<Record<string, number>>

// 地址里的缩写。改了任何一个，scripts/update-feed-stats.cjs 那边的解码表和
// scripts/fixtures/usage-stats-path.txt 要一起改（两边的测试都读那份样例）。
const targetCodes: Readonly<Record<UsageInstallTarget, string>> = {
  claude: 'cc', codex: 'cx', grok: 'gk', codexDesktop: 'cdx', claudeDesktop: 'cd', workbuddy: 'wb', opencode: 'oc', node: 'nd', git: 'gt', python: 'py',
}
const categoryCodes: Readonly<Record<UsageFailureCategory, string>> = { machine: 'mac', certificate: 'crt', network: 'net', source: 'src', other: 'oth' }
const stepCodes: Readonly<Record<UsageUpdateStep, string>> = { check: 'chk', download: 'dl', install: 'ins' }
const hangCodes: Readonly<Record<UsageHangKind, string>> = { unresponsive: 'w', stall: 's', paymentSlow: 'ps', paymentFailed: 'pf', unexpectedExit: 'e' }

/** 一种计数攒到这么多就不再往上加：够看出「很多」，也让地址长度有上限。 */
export const usageCounterCap = 99
/** 没发出去的计数最多留这么久，再旧的直接丢掉，不攒。 */
export const usageCounterMaxAgeMs = 7 * 24 * 60 * 60 * 1000
/** 付款页从点下去到打开超过这么久，算一次「打开慢」。 */
export const usagePaymentSlowMs = 10_000
/** 主进程一次没动弹超过这么久算卡住；再长的多半是电脑睡着了，不算。 */
export const usageStallThresholdMs = 2_000
const usageSleepGapMs = 30_000
const maxPathLength = 1_500

const installChannels: Readonly<Record<string, UsageInstallTarget>> = {
  'desktop:install-codex': 'codexDesktop',
  'runtime:install-node': 'node',
  'runtime:install-git': 'git',
  'runtime:install-python': 'python',
}
const cliTargets: ReadonlySet<string> = new Set(['claude', 'codex', 'grok'])
/**
 * 只有这两条通道的第一个参数（装哪个工具的代号）会交到这里来，别的通道一个参数都不给（ipc.ts）：
 * 登录、密钥、飞书凭据这些入参从构造上就碰不到统计。
 */
export const usageArgumentChannels: ReadonlySet<string> = new Set(['cli:install', 'external-clients:install'])
const externalTargets: ReadonlySet<string> = new Set(['claudeDesktop', 'workbuddy', 'opencode'])
const paymentChannels: ReadonlySet<string> = new Set(['account:create-topup-payment', 'account:create-subscription-payment'])

export function usageEventKey(event: UsageStatsEvent): string {
  if (event.kind === 'install') return `i~${targetCodes[event.target]}~${categoryCodes[event.category]}`
  if (event.kind === 'update') return `f~${stepCodes[event.step]}~${categoryCodes[event.category]}`
  return `h~${hangCodes[event.hang]}`
}

function buildAllowedCounterKeys(): ReadonlySet<string> {
  const keys = new Set<string>()
  const categories = Object.keys(categoryCodes) as UsageFailureCategory[]
  for (const target of Object.keys(targetCodes) as UsageInstallTarget[]) {
    for (const category of categories) keys.add(usageEventKey({ kind: 'install', target, category }))
  }
  for (const step of Object.keys(stepCodes) as UsageUpdateStep[]) {
    for (const category of categories) keys.add(usageEventKey({ kind: 'update', step, category }))
  }
  for (const hang of Object.keys(hangCodes) as UsageHangKind[]) keys.add(usageEventKey({ kind: 'hang', hang }))
  return keys
}

const allowedCounterKeys = buildAllowedCounterKeys()

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function addUsageEvent(counters: UsageStatsCounters, event: UsageStatsEvent): UsageStatsCounters {
  const key = usageEventKey(event)
  return { ...counters, [key]: Math.min(usageCounterCap, (counters[key] ?? 0) + 1) }
}

/** 发出去的那部分扣掉；发送路上新记的留着，下一次再发。 */
export function subtractUsageCounters(current: UsageStatsCounters, sent: UsageStatsCounters): UsageStatsCounters {
  const next: Record<string, number> = {}
  for (const [key, count] of Object.entries(current)) {
    const remaining = count - (sent[key] ?? 0)
    if (remaining > 0) next[key] = remaining
  }
  return next
}

/** 本机文件是用户可写的：认不出的键、不是正整数的值都丢掉，超过上限的压回上限。 */
export function parseUsageCounters(value: unknown): UsageStatsCounters {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const counters: Record<string, number> = {}
  for (const [key, count] of Object.entries(value)) {
    if (allowedCounterKeys.has(key) && validCount(count)) counters[key] = Math.min(usageCounterCap, count)
  }
  return counters
}

export interface UsageStatsState {
  /** 哪一天（UTC，YYYYMMDD）已经发成了。 */
  lastSentDay: string | null
  /** 当天试过几次；一天最多试 usageMaxAttemptsPerDay 次。 */
  attemptDay: string | null
  attempts: number
  counters: UsageStatsCounters
  /** 现在这批计数里最早那条是什么时候记的；超过 usageCounterMaxAgeMs 整批丢掉。 */
  countersSince: number | null
}

export const usageMaxAttemptsPerDay = 3
const dayPattern = /^\d{8}$/

export function emptyUsageStatsState(): UsageStatsState {
  return { lastSentDay: null, attemptDay: null, attempts: 0, counters: {}, countersSince: null }
}

export function parseUsageStatsState(content: string): UsageStatsState {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return emptyUsageStatsState()
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return emptyUsageStatsState()
  const record = value as Record<string, unknown>
  if (record.version !== 1) return emptyUsageStatsState()
  const day = (candidate: unknown): string | null => typeof candidate === 'string' && dayPattern.test(candidate) ? candidate : null
  const attempts = typeof record.attempts === 'number' && Number.isSafeInteger(record.attempts) && record.attempts >= 0
    ? Math.min(record.attempts, usageMaxAttemptsPerDay)
    : 0
  const since = typeof record.countersSince === 'number' && Number.isSafeInteger(record.countersSince) && record.countersSince > 0 ? record.countersSince : null
  const counters = parseUsageCounters(record.counters)
  return {
    lastSentDay: day(record.lastSentDay),
    attemptDay: day(record.attemptDay),
    attempts,
    counters,
    countersSince: Object.keys(counters).length ? since : null,
  }
}

export function serializeUsageStatsState(state: UsageStatsState): string {
  return `${JSON.stringify({ version: 1, ...state })}\n`
}

/** 计数攒得太久（一直连不上、一直没发成）就整批丢掉，不拿一周前的事算今天的。 */
export function withoutExpiredCounters(state: UsageStatsState, now: number): UsageStatsState {
  if (state.countersSince === null || now - state.countersSince <= usageCounterMaxAgeMs) return state
  return { ...state, counters: {}, countersSince: null }
}

/** 按 UTC 算哪一天：工作流按 Cloudflare 的时间分天，两边用同一个口径。 */
export function usageStatsDay(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '')
}

export function shouldSendUsageStats(input: {
  packaged: boolean
  localBuild: boolean
  env: NodeJS.ProcessEnv
  /** 设置里「匿名使用统计」本机存的值；没碰过是 undefined。 */
  preference: boolean | undefined
}): boolean {
  // 开发版、本机自己编的版本不是客户；GitHub Actions 里真装真开的打包版也不是。
  if (!input.packaged || input.localBuild) return false
  if (input.env[usageStatsDisableEnvironmentKey] === '1' || input.env.CI === 'true') return false
  // 没碰过 = 开（yoyo 10-26 选的默认）；以前亲手关过的，本机存着 false，照旧关。
  return input.preference !== false
}

const appVersionPattern = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.]{1,30})?$/
const toolVersionPattern = /^\d{1,6}(?:\.\d{1,6}){0,3}(?:-[0-9A-Za-z.]{1,30})?$/

function appVersionToken(version: string): string {
  return appVersionPattern.test(version) ? version : 'x'
}

/** Windows 10、11 共用 10.0 这个内核号，只能按版本号里的 build 分：22000 起是 11。 */
export function resolveUsageOs(input: { platform: string; release: string; systemVersion?: string | null }): string {
  if (input.platform === 'win32') {
    const build = /^10\.0\.(\d{4,6})(?:\.|$)/.exec(input.release)?.[1]
    if (!build) return 'wx'
    return Number(build) >= 22000 ? 'w11' : 'w10'
  }
  if (input.platform === 'darwin') {
    const major = /^(\d{1,2})(?:\.|$)/.exec(input.systemVersion ?? '')?.[1]
    return major ? `m${major}` : 'mx'
  }
  if (input.platform === 'linux') return 'lx'
  return 'x'
}

function archToken(arch: string): string {
  return arch === 'x64' || arch === 'arm64' || arch === 'ia32' ? arch : 'x'
}

export type UsageAccountKind = 'xm' | 'api' | 'none'

/** 只看登的是哪一类账号，不看是谁。 */
export function usageAccountKind(siteId: string, authenticated: boolean): UsageAccountKind {
  if (!authenticated) return 'none'
  if (siteId === 'solov') return 'xm'
  if (siteId === 'solov-api') return 'api'
  return 'none'
}

export interface UsageRouteChoice {
  preference: 'auto' | 'primary' | 'direct'
  line: 'primary' | 'direct'
}

export function usageRouteChoice(routing: RelayEndpointRoutingSnapshot, siteId: string): UsageRouteChoice | null {
  const site = routing.resolve(siteId)
  if (site.id !== 'solov' && site.id !== 'solov-api') return null
  return { preference: routing.preferences[site.id], line: routing.lines()[site.id].line }
}

function routeToken(route: UsageRouteChoice | null): string {
  if (!route) return 'x'
  return `${route.preference === 'auto' ? 'a' : 'm'}${route.line === 'direct' ? 2 : 1}`
}

export type UsageUpdateState = { state: 'current' } | { state: 'downloaded' | 'install-failed'; version: string }

function releaseParts(version: string): [number, number, number] | null {
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function isNewerRelease(candidate: string, current: string): boolean {
  const left = releaseParts(candidate)
  const right = releaseParts(current)
  if (!left || !right) return false
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index]
  }
  return false
}

/**
 * 「下好了没装」和「装了没装上」（#1385 一直分不开的那件事）。本机的更新记录（pending-update.json）
 * 里，下好的版本比正在运行的新，又已经在打开时、退出时或开机后台试着装过它，就是装了没装上；
 * 没试过就是下好了还在等。装上了的那一版开机时就从记录里清掉了（resolveRecordToWriteAtLaunch）。
 */
export function resolveUsageUpdateState(record: {
  downloadedVersion: string | null
  attemptedVersion: string | null
  quitAttemptedVersion?: string | null
  backgroundInstall?: { version: string } | null
}, currentVersion: string): UsageUpdateState {
  const downloaded = record.downloadedVersion
  if (!downloaded || !isNewerRelease(downloaded, currentVersion)) return { state: 'current' }
  const tried = record.attemptedVersion === downloaded
    || record.quitAttemptedVersion === downloaded
    || record.backgroundInstall?.version === downloaded
  return { state: tried ? 'install-failed' : 'downloaded', version: downloaded }
}

function updateStateToken(update: UsageUpdateState): string {
  if (update.state === 'current') return 'ok'
  const version = appVersionToken(update.version)
  return `${update.state === 'downloaded' ? 'dl' : 'ff'}~${version}`
}

export interface UsageToolInventory {
  /** 版本号；装了但读不出版本是空串；null = 没装；没有这一项 = 这次没检测到。 */
  clis: Partial<Record<'claude' | 'codex' | 'grok', string | null>>
  /** 下线的 Gemini CLI 还在不在（老客户的不卸不删）；null = 没检测到。 */
  gemini: boolean | null
  desktops: Partial<Record<'codexDesktop' | 'claudeDesktop' | 'workbuddy' | 'opencode', boolean>>
}

/** 首页检测里一个工具的结果（SystemSnapshot 的 clis、desktopApps 各项），只用到这几个字段。 */
export interface UsageToolProbe {
  installed: boolean
  version?: string | null
  /** 探测本身出错：装没装不知道，按没检测到算，不能算成没装。 */
  detectionFailed?: boolean
}

function probed(status: UsageToolProbe | undefined): status is UsageToolProbe {
  return status !== undefined && status.detectionFailed !== true
}

/** 只读首页检测已经拿到的结果，不为了发统计另起一轮检测。 */
export function usageToolInventory(
  scan: { clis: Partial<Record<string, UsageToolProbe>>; desktopApps: { codex: UsageToolProbe } } | null,
  externalClients: readonly { tool: string; installed: boolean; detectionError?: string | null }[] | null,
): UsageToolInventory {
  const inventory: { clis: Record<string, string | null>; gemini: boolean | null; desktops: Record<string, boolean> } = { clis: {}, gemini: null, desktops: {} }
  if (scan) {
    for (const provider of ['claude', 'codex', 'grok'] as const) {
      const status = scan.clis[provider]
      if (probed(status)) inventory.clis[provider] = status.installed ? status.version ?? '' : null
    }
    const gemini = scan.clis.gemini
    inventory.gemini = probed(gemini) ? gemini.installed : null
    if (probed(scan.desktopApps.codex)) inventory.desktops.codexDesktop = scan.desktopApps.codex.installed
  }
  for (const client of externalClients ?? []) {
    if (externalTargets.has(client.tool) && !client.detectionError) inventory.desktops[client.tool] = client.installed
  }
  return inventory
}

function flagToken(value: boolean | null | undefined): string {
  if (value === undefined || value === null) return 'x'
  return value ? '1' : '0'
}

// 命令行工具一格：版本号；0 = 没装；v = 装了但读不出版本（版本号认不出也算这种）；x = 这次没检测到。
function toolsToken(tools: UsageToolInventory): string {
  const cli = (provider: 'claude' | 'codex' | 'grok'): string => {
    const version = tools.clis[provider]
    if (version === undefined) return 'x'
    if (version === null) return '0'
    return toolVersionPattern.test(version) ? version : 'v'
  }
  return [
    `cc~${cli('claude')}`,
    `cx~${cli('codex')}`,
    `gk~${cli('grok')}`,
    `gm~${flagToken(tools.gemini)}`,
    `cdx~${flagToken(tools.desktops.codexDesktop)}`,
    `cd~${flagToken(tools.desktops.claudeDesktop)}`,
    `wb~${flagToken(tools.desktops.workbuddy)}`,
    `oc~${flagToken(tools.desktops.opencode)}`,
  ].join('_')
}

function countersToken(counters: UsageStatsCounters, prefix: 'i' | 'f' | 'h'): string {
  const items = Object.entries(counters)
    .filter(([key, count]) => key.startsWith(`${prefix}~`) && allowedCounterKeys.has(key) && validCount(count))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, count]) => `${key.slice(2)}~${Math.min(usageCounterCap, count)}`)
  return items.length ? items.join('_') : '0'
}

export interface UsageStatsSnapshot {
  appVersion: string
  /** resolveUsageOs 给的那个词。 */
  os: string
  arch: string
  account: UsageAccountKind
  route: UsageRouteChoice | null
  autoUpdate: boolean
  update: UsageUpdateState
  tools: UsageToolInventory
}

const osTokenPattern = /^(?:w10|w11|wx|m\d{1,2}|mx|lx|x)$/

/**
 * 一天那一条的地址（不含主机）。段的先后固定，每段「字母-值」：
 * v1 / d-日期 / a-星芒版本 / o-系统 / c-芯片 / k-账号类型 / r-线路 / u-自动更新 / s-更新状态 /
 * t-装了哪些工具 / i-安装失败 / f-更新失败 / h-卡住。
 */
export function buildUsageStatsPath(day: string, snapshot: UsageStatsSnapshot, counters: UsageStatsCounters): string | null {
  if (!dayPattern.test(day)) return null
  const account = snapshot.account === 'xm' || snapshot.account === 'api' ? snapshot.account : 'no'
  const segments = [
    schemaVersion,
    `d-${day}`,
    `a-${appVersionToken(snapshot.appVersion)}`,
    `o-${osTokenPattern.test(snapshot.os) ? snapshot.os : 'x'}`,
    `c-${archToken(snapshot.arch)}`,
    `k-${account}`,
    `r-${routeToken(snapshot.route)}`,
    `u-${snapshot.autoUpdate ? 1 : 0}`,
    `s-${updateStateToken(snapshot.update)}`,
    `t-${toolsToken(snapshot.tools)}`,
    `i-${countersToken(counters, 'i')}`,
    `f-${countersToken(counters, 'f')}`,
    `h-${countersToken(counters, 'h')}`,
  ]
  const path = `${usageStatsPathPrefix}${segments.join('/')}`
  // Belt and braces: every token above is already drawn from a closed set,
  // so this only fails if a future edit lets free text in.
  return path.length <= maxPathLength && /^[A-Za-z0-9/._~-]+$/.test(path) ? path : null
}

function failureText(error: unknown): string {
  if (typeof error === 'string') return error.slice(0, 2_000)
  if (typeof error !== 'object' || error === null) return ''
  const record = error as { message?: unknown; code?: unknown }
  const parts = [record.message, record.code].filter((part): part is string => typeof part === 'string')
  return parts.join(' ').slice(0, 2_000)
}

/** 报错原文只在这里过一遍，出去的只有这五类里的一个。 */
export function usageFailureCategory(error: unknown): UsageFailureCategory {
  const text = failureText(error)
  const npm = text ? npmFailureReasonFor(text) : null
  if (npm) return npm.kind
  const network = classifyNetworkFailure(error)
  if (network === 'tls' || network === 'certDate') return 'certificate'
  if (network === 'serviceUnavailable') return 'source'
  if (network) return 'network'
  return 'other'
}

export interface UsageOperation {
  channel: string
  /** 只有 usageArgumentChannels 那两条有，且只有第一个参数；其余通道都是空的。 */
  args: readonly unknown[]
  durationMs: number
  failed: boolean
  error?: unknown
}

function installTarget(channel: string, args: readonly unknown[]): UsageInstallTarget | null {
  const fixed = installChannels[channel]
  if (fixed) return fixed
  const tool = args[0]
  if (channel === 'cli:install' && typeof tool === 'string' && cliTargets.has(tool)) return tool as UsageInstallTarget
  if (channel === 'external-clients:install' && typeof tool === 'string' && externalTargets.has(tool)) return tool as UsageInstallTarget
  return null
}

/** 主窗口一次操作结束：装东西失败了、付款页没打开或打开得慢，各记一笔；其余的不记。 */
export function usageEventForOperation(operation: UsageOperation): UsageStatsEvent | null {
  if (paymentChannels.has(operation.channel)) {
    if (operation.failed) return { kind: 'hang', hang: 'paymentFailed' }
    return operation.durationMs >= usagePaymentSlowMs ? { kind: 'hang', hang: 'paymentSlow' } : null
  }
  if (!operation.failed || isInstallCancelledError(operation.error)) return null
  const target = installTarget(operation.channel, operation.args)
  return target ? { kind: 'install', target, category: usageFailureCategory(operation.error) } : null
}

export interface UsageUpdateView {
  error: { code: string; message: string; detail?: string; automatic?: boolean } | null
  failedStep?: UsageUpdateStep | null
}

/**
 * 更新失败只在「刚出错」那一下记一笔：同一个错误随着进度、重画会被反复推出来。开机或每 3 小时自己
 * 跑的检查没查成不记（网一抖就有，客户也看不见）；「上次自动装没装上」由每天那条的更新状态说，
 * 不再按次数记。
 */
export function usageEventForUpdate(previous: UsageUpdateView | null, next: UsageUpdateView): UsageStatsEvent | null {
  const error = next.error
  const step = next.failedStep
  if (!error || !step) return null
  if (step === 'check' && error.automatic) return null
  if (error.code === 'UPDATE_PREVIOUS_AUTO_INSTALL_FAILED') return null
  if (previous?.error && previous.failedStep === step && previous.error.code === error.code && previous.error.message === error.message) return null
  const category = /STALLED|TIMEOUT/.test(error.code)
    ? 'network'
    : usageFailureCategory({ message: [error.message, error.detail ?? ''].join(' '), code: error.code })
  return { kind: 'update', step, category }
}

/**
 * 主进程计时器隔了多久才轮到：比该轮到的晚 2 秒以上算卡住了一次。晚 30 秒以上的多半是电脑睡着、
 * 合上盖子，不算。只在星芒的窗口在前台时量（main.ts 按窗口得失焦点开关），后台被系统放慢的不算。
 */
export function isMainProcessStall(expectedMs: number, elapsedMs: number): boolean {
  const lag = elapsedMs - expectedMs
  return lag >= usageStallThresholdMs && lag < usageSleepGapMs
}
