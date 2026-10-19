import { readBoundedUtf8FileSync } from './bounded-file'
import { readBoundedResponseText } from './bounded-response'
import { activeProviderIds } from './catalog'
import { isCliModelName, type CliModelHint, type CliModelHints } from './cli-model-defaults'
import { accountGroupRoles, isManagedCliGroupName, type AccountGroupHints } from './managed-cli-groups'

/**
 * 更新目录上的一份状态文件（`service-status.json`），给发布者一个不发版就能对
 * 已装好的客户端说话的地方。
 *
 * 为什么要它：星芒站维护或被防护层拦住时，客户端只能从一次失败的请求里倒推原因，
 * 猜出来的往往是「Key 坏了」「登录失效」；而站内公告要登录后才看得到，没登录的
 * 人连「在维护」都无从知道。更新目录是静态文件，和账号服务不在一处，账号服务停了
 * 它照样答话，所以把「正在维护」放在这里。
 *
 * 这份文件只能让客户端「少做」或「多说一句」，不能让它多拿任何能力：读不到、格式
 * 不对、字段缺失，一律当作没有这份文件——没在维护，客户端照常工作。它绝不能因为
 * 这份文件读不到而报错或拖慢启动。分组对照（accountGroups）也守这一条：它只在服务端
 * 已经允许这个账号用的分组里挑，不能让客户端用上任何它本来用不了的分组。型号表（cliModels）同理：
 * 只在账号模型列表里真有的型号里挑，下架名单也只换掉账号已经不再列出的型号。
 */
export const serviceStatusFileName = 'service-status.json'

export interface ServiceMaintenance {
  /** 发布者写给用户的一句话；没写就是 null，界面用自己的默认说法。 */
  message: string | null
}

export interface ServiceRollout {
  /** 这一版先只给一部分电脑。 */
  version: string
  /** 0～100：自动检查时只有这个百分比的电脑会看到它；用户手动点「检查更新」不受限。 */
  percent: number
  /**
   * 只对这几种安装包分批（写法见 releasePlatformPattern），别的照常全放。没写、写错就是对所有平台分批。
   * 0.2.19 及以前的客户端不认这一项，对所有平台分批，只会推得更慢。0.2.20 起的客户端认。
   */
  platforms?: readonly string[]
}

export interface ServiceStatus {
  /** 正在维护为对象，没在维护为 null。 */
  maintenance: ServiceMaintenance | null
  /**
   * 发布者撤回的版本。客户端永远不会装上这些版本；本机正是其中之一时，允许
   * 「更新」到更低的版本号（退回上一个好版本）。
   */
  badVersions?: readonly string[]
  /**
   * 撤回名单里哪几个版本只撤哪几种安装包（#1155 第 5 条）：键是 badVersions 里的版本号，值是平台列表。
   * 版本号照旧写在 badVersions 里，所以 0.2.19 及以前的客户端不认这一项也照样整版撤回，只会撤得更多。
   * 不在 badVersions 里的键、写错的、写了认不出的平台的，都按对所有平台撤回算。0.2.20 起的客户端认。
   */
  badVersionPlatforms?: Readonly<Record<string, readonly string[]>>
  /** 分批放量；没有就是 null。 */
  rollout?: ServiceRollout | null
  /**
   * 最低可用版本：本机低于它时，界面盖一层「更新后才能继续用」，只留更新和找客服。
   * 没写、写错一律是 null（不拦任何人）。只有 0.2.11 及以后的客户端认这一项。
   */
  minimumVersion?: string | null
  /**
   * 最低版本只拦哪几种安装包。没写、写错就是对所有平台都拦，跟 0.2.19 及以前的客户端读法一样。
   * 0.2.20 起的客户端认。
   */
  minimumVersionPlatforms?: readonly string[]
  /**
   * 换线路时工具配置怎么改（xm 三线路 R6）：merge = 退回整份重写的老办法。没写、写错都是缺省的
   * 只改地址。0.2.18 起的客户端认。
   */
  toolRouteRewrite?: 'merge'
  /**
   * 星芒账号（xm 站）每样用途用哪个分组：claude / codex / grok / image，各列几个候选名字，
   * 账号能用的里面排在前面的胜出。站上改分组本名前先在这里写上「新名字、老名字」，客户端不用
   * 发版就跟过去。没写、写错的那样用途照旧按写死的名字和工具专属词认。0.2.19 起的客户端认。
   */
  accountGroups?: AccountGroupHints
  /**
   * 各工具的型号表：claude / codex / grok 各自的默认型号、上一代默认、已下架（cli-model-defaults.ts 的
   * CliModelHint），和程序自带的那份合并。型号换代、站上下架不用发版。没写、写错的那一项照旧用自带的。
   * 0.2.20 起的客户端认。
   */
  cliModels?: CliModelHints
  /**
   * 发布者改这份文件的时间（GitHub 按钮写的 `updatedAt`），ISO 格式。只拿来比撤回名单和放量哪份更新：
   * 某条线路、某个 CDN 节点给了一份旧的，不让它盖掉本机记着的新的（#1157 第 10 条）。没写、写错、比本机
   * 时钟晚一天以上都当没写。
   */
  updatedAt?: string
}

export const emptyServiceStatus: ServiceStatus = Object.freeze({ maintenance: null, badVersions: [], rollout: null, minimumVersion: null })

/**
 * 撤回名单和分批放量：发版的安全网。客户端只认最近一次读成功的那份，还记在本地，下次打开软件时
 * 状态文件没读到也照样算数（#1055）。最低版本不在里面：它会把人挡在门外，发布者撤掉以后，读不到
 * 状态文件的电脑不能还一直被拦着。
 */
export interface ReleaseGuard {
  badVersions: readonly string[]
  /** 同 ServiceStatus.badVersionPlatforms；缺省 = 撤回名单上的版本对所有平台都撤。 */
  badVersionPlatforms?: Readonly<Record<string, readonly string[]>>
  rollout: ServiceRollout | null
  /** 这份出自哪一版状态文件（ServiceStatus.updatedAt）；缺省 = 那份没写，比不出新旧。 */
  updatedAt?: string
}

// 一份只写着几个开关的 JSON 远用不到这么大；上限是给「这个地址被换成了别的东西」
// 准备的，免得把一整张网页读进内存再去解析。
const maxStatusBytes = 16 * 1024
const maxMessageLength = 200
const defaultTimeoutMs = 5_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/**
 * electron-builder 写进安装包的 `app-update.yml` 只有几行 `key: value`，这里只取
 * `url` 那一行，不为它引入 YAML 解析器。地址的要求与构建脚本
 * `normalizeUpdateBaseUrl` 一致：HTTPS、不内嵌账号密码、不带查询参数与片段；只有
 * 开发态更新源允许本机 HTTP。任何一条不满足就返回 null——读不到状态文件而已。
 */
export function resolveServiceStatusUrl(
  updateConfigText: string,
  options: { allowLocalHttp?: boolean } = {},
): string | null {
  const line = updateConfigText.split(/\r?\n/).find((entry) => /^url\s*:/.test(entry))
  if (!line) return null
  const raw = line.slice(line.indexOf(':') + 1).trim().replace(/^(['"])(.*)\1$/, '$2').trim()
  if (!raw) return null
  let base: URL
  try {
    base = new URL(raw)
  } catch {
    return null
  }
  const localHttp = options.allowLocalHttp === true && base.protocol === 'http:' && isLoopbackHost(base.hostname)
  if (base.protocol !== 'https:' && !localHttp) return null
  if (base.protocol === 'https:' && isLoopbackHost(base.hostname)) return null
  if (base.username || base.password || base.search || base.hash) return null
  if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`
  return new URL(serviceStatusFileName, base).href
}

/**
 * 从安装包里的更新配置推出状态文件的地址：正式包读资源目录的 `app-update.yml`，
 * 开发态读 `dev-app-update.yml`。文件在用户可写的安装目录下，所以照 I8 走有界、
 * 拒绝链接的读法；读不出来返回 null，这台客户端就不看状态文件。
 */
export function locateServiceStatusUrl(updateConfigPath: string, options: { allowLocalHttp?: boolean } = {}): string | null {
  try {
    return resolveServiceStatusUrl(readBoundedUtf8FileSync(updateConfigPath, 16 * 1024, '更新配置'), options)
  } catch {
    return null
  }
}

// 控制字符与双向文本控制符会让一句公告在界面上排版错乱，或把后半句伪装成别的
// 内容；这份文字只该是一句普通的话。
const unsafeCharacters = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

function readMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(unsafeCharacters, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return null
  return Array.from(cleaned).slice(0, maxMessageLength).join('')
}

function readMaintenance(value: unknown, now: Date): ServiceMaintenance | null {
  if (!isRecord(value) || value.active !== true) return null
  // until 是给「维护完忘了关」兜底的：过了这个时间就当维护结束，客户端不会一直
  // 挂着一条过期的维护提示。写错了读不出来就不管它，只认 active。
  if (typeof value.until === 'string') {
    const until = Date.parse(value.until)
    if (Number.isFinite(until) && until <= now.getTime()) return null
  }
  return { message: readMessage(value.message) }
}

// 只认 x.y.z（可带预发布后缀），与 package.json 的版本号写法一致；前导 v 去掉。
// 写错的条目直接丢掉：一个认不出的版本号什么也挡不住，但也不该让整份文件作废。
const versionPattern = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z.-]{1,40})?$/
const maxBadVersions = 100

function readVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const version = value.trim().replace(/^v/i, '')
  return versionPattern.test(version) ? version : null
}

function readBadVersions(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const versions = new Set<string>()
  for (const entry of value.slice(0, maxBadVersions)) {
    const version = readVersion(entry)
    if (version) versions.add(version)
  }
  return [...versions]
}

/**
 * 撤回、放量、最低版本只对哪几种安装包生效（#1155 第 5 条）：「平台」或「平台-架构」，比如 mac-x64 是 Intel 版
 * 的 Mac 包，mac 是两种 Mac 包都算。哪天只有 Intel 版坏了，不用连 Windows 和 M 系列芯片版一起撤回。
 */
const releasePlatformPattern = /^(windows|mac|linux)(?:-(x64|arm64))?$/
// 三个平台各自整个、x64、arm64，一共九种写法。
const maxReleasePlatforms = 9

// 只对这几种安装包生效的条目要收窄的是别人：认不出的一项可能正是这台电脑，所以有一项读不懂就整张作废，
// 回到对所有平台生效。撤回、放量这样算只会更保守；最低版本这样算跟不认平台的旧客户端一个样。
function readReleasePlatforms(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxReleasePlatforms) return null
  const platforms: string[] = []
  for (const entry of value) {
    const name = typeof entry === 'string' ? entry.trim().toLowerCase() : ''
    if (!releasePlatformPattern.test(name)) return null
    if (!platforms.includes(name)) platforms.push(name)
  }
  return platforms
}

// 只收撤回名单里真有的版本，按名单的先后排，记在本地的那份前后两次比得出一样。同一个版本写了两次
// （0.2.20、v0.2.20）就合起来；其中一份读不懂就整版撤回。
function readBadVersionPlatforms(value: unknown, badVersions: readonly string[]): Record<string, string[]> | null {
  if (!isRecord(value)) return null
  const scoped = new Map<string, string[]>()
  const everywhere = new Set<string>()
  for (const [key, entry] of Object.entries(value)) {
    const version = readVersion(key)
    if (!version || !badVersions.includes(version)) continue
    const platforms = readReleasePlatforms(entry)
    if (!platforms) {
      everywhere.add(version)
      continue
    }
    scoped.set(version, [...new Set([...(scoped.get(version) ?? []), ...platforms])])
  }
  const result: Record<string, string[]> = {}
  let any = false
  for (const version of badVersions) {
    const platforms = scoped.get(version)
    if (!platforms || everywhere.has(version)) continue
    result[version] = platforms
    any = true
  }
  return any ? result : null
}

function readRollout(value: unknown): ServiceRollout | null {
  if (!isRecord(value)) return null
  const version = readVersion(value.version)
  const percent = value.percent
  if (!version || typeof percent !== 'number' || !Number.isFinite(percent)) return null
  const platforms = readReleasePlatforms(value.platforms)
  return { version, percent: Math.min(100, Math.max(0, percent)), ...(platforms ? { platforms } : {}) }
}

const releasePlatformNames: Partial<Record<NodeJS.Platform, string>> = { win32: 'windows', darwin: 'mac', linux: 'linux' }

/**
 * 这台电脑的安装包属于哪几种写法，例如 Intel Mac 是 mac、mac-x64。Apple 芯片上经 Rosetta 跑着 Intel 版的
 * Mac 两种都算：装着的是 Intel 版，更新时 electron-updater 又会给它换 M 系列芯片版（macRunsArm64）。
 * 多算一种，撤回和放量只会多拦，不会漏。认不出的平台给空表，只对某几种安装包生效的条目都管不到它。
 */
export function resolveReleasePlatforms(input: { platform: NodeJS.Platform; arch: string; macRunsArm64?: boolean }): string[] {
  const platform = releasePlatformNames[input.platform]
  if (!platform) return []
  const arches = new Set<string>()
  if (input.arch === 'x64' || input.arch === 'arm64') arches.add(input.arch)
  if (input.platform === 'darwin' && input.macRunsArm64 !== undefined) arches.add(input.macRunsArm64 ? 'arm64' : 'x64')
  return [platform, ...[...arches].map((arch) => `${platform}-${arch}`)]
}

function appliesTo(platforms: readonly string[] | undefined, here: readonly string[]): boolean {
  return !platforms || platforms.length === 0 || platforms.some((entry) => here.includes(entry))
}

/**
 * 撤回名单和放量里，这台电脑要守的那部分：只撤别的安装包的版本从名单里拿掉，只对别的安装包分批的放量
 * 当没有（交回 latest.yml 里的 stagingPercentage）。
 */
export function resolveReleaseGuardFor(
  guard: Pick<ReleaseGuard, 'badVersions' | 'badVersionPlatforms' | 'rollout'>,
  here: readonly string[],
): { badVersions: string[]; rollout: ServiceRollout | null } {
  const scoped = guard.badVersionPlatforms ?? {}
  return {
    badVersions: guard.badVersions.filter((version) => !Object.hasOwn(scoped, version) || appliesTo(scoped[version], here)),
    rollout: guard.rollout && appliesTo(guard.rollout.platforms, here) ? guard.rollout : null,
  }
}

/** 状态文件里的最低版本管不管这台电脑：只拦别的安装包时返回 null。 */
export function resolveMinimumVersionFor(
  status: Pick<ServiceStatus, 'minimumVersion' | 'minimumVersionPlatforms'> | null | undefined,
  here: readonly string[],
): string | null {
  const minimum = status?.minimumVersion ?? null
  return minimum && appliesTo(status?.minimumVersionPlatforms, here) ? minimum : null
}

// 时间写在未来太远的当没写：不然一份手误写到明年的文件，会让之后每一份都显得比它旧、谁也盖不掉它。
// 留一天给两边时钟的偏差。
const maxUpdatedAtLeadMs = 24 * 60 * 60 * 1000

function readUpdatedAt(value: unknown, now: Date): string | null {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  if (!Number.isFinite(at) || at > now.getTime() + maxUpdatedAtLeadMs) return null
  return new Date(at).toISOString()
}

/**
 * 记在本地的那份撤回名单和分批放量，按状态文件的同一套口径重新校验：写错的条目丢掉，整份不是
 * 对象返回 null（当作从没读到过）。
 */
export function parseReleaseGuard(value: unknown, now: Date = new Date()): ReleaseGuard | null {
  if (!isRecord(value)) return null
  const updatedAt = readUpdatedAt(value.updatedAt, now)
  const badVersions = readBadVersions(value.badVersions)
  const badVersionPlatforms = readBadVersionPlatforms(value.badVersionPlatforms, badVersions)
  return {
    badVersions,
    ...(badVersionPlatforms ? { badVersionPlatforms } : {}),
    rollout: readRollout(value.rollout),
    ...(updatedAt ? { updatedAt } : {}),
  }
}

/**
 * 新读到的这份撤回名单和放量是不是比手上的旧（#1157 第 10 条）。两份都写了时间才比得出来；有一份没写
 * （手改的文件、0.2.20 以前记下的）就照旧以新读到的为准。
 */
export function isOlderReleaseGuard(next: Pick<ReleaseGuard, 'updatedAt'>, current: Pick<ReleaseGuard, 'updatedAt'>): boolean {
  if (!next.updatedAt || !current.updatedAt) return false
  return Date.parse(next.updatedAt) < Date.parse(current.updatedAt)
}

// 最低版本会把人挡在门外，所以比撤回名单读得更严：只认纯 x.y.z，带预发布后缀的
// 一律当没写——「0.2.12-beta」该不该算低于 0.2.12，客户端和发布者很容易想得不一样。
function readMinimumVersion(value: unknown): string | null {
  const version = readVersion(value)
  return version && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version) ? version : null
}

// 一样用途列「新名字、老名字」两三个就够了；上限只防一份写坏的文件塞进一长串。
const maxAccountGroupCandidates = 8

// 名字会原样进建 Key 的请求体，按分组名的同一套口径校验（I5）；不合格的那一个丢掉，
// 不让整样用途作废——排在后面的老名字仍然能兜底。
function readAccountGroups(value: unknown): AccountGroupHints | null {
  if (!isRecord(value)) return null
  const hints: AccountGroupHints = {}
  let any = false
  for (const role of accountGroupRoles) {
    const entries = value[role]
    if (!Array.isArray(entries)) continue
    const names: string[] = []
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry.trim() : ''
      if (!isManagedCliGroupName(name) || names.includes(name)) continue
      names.push(name)
      if (names.length === maxAccountGroupCandidates) break
    }
    if (names.length === 0) continue
    hints[role] = names
    any = true
  }
  return any ? hints : null
}

// 上一代列两三个就够，下架名单留宽一点；上限只防一份写坏的文件塞进一长串。
const maxPreviousCliModels = 8
const maxRetiredCliModels = 32

function readCliModelNames(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  const names: string[] = []
  for (const entry of value) {
    const name = typeof entry === 'string' ? entry.trim() : ''
    if (!isCliModelName(name) || names.includes(name)) continue
    names.push(name)
    if (names.length === limit) break
  }
  return names
}

// 只认还在管的工具（Gemini CLI 已下线）；名字不合格的那一个丢掉，同一项里写对的照用。
function readCliModels(value: unknown): CliModelHints | null {
  if (!isRecord(value)) return null
  const hints: CliModelHints = {}
  let any = false
  for (const provider of activeProviderIds) {
    const entry = value[provider]
    if (!isRecord(entry)) continue
    const hint: CliModelHint = {}
    const preferred = typeof entry.default === 'string' ? entry.default.trim() : ''
    if (isCliModelName(preferred)) hint.default = preferred
    const previous = readCliModelNames(entry.previous, maxPreviousCliModels)
    if (previous.length) hint.previous = previous
    const retired = readCliModelNames(entry.retired, maxRetiredCliModels)
    if (retired.length) hint.retired = retired
    if (!hint.default && !hint.previous && !hint.retired) continue
    hints[provider] = hint
    any = true
  }
  return any ? hints : null
}

/** 记在本地的那份型号表（cli-model-hints-store.ts），按状态文件的同一套口径重新校验（#1154 第 6 条）。 */
export function parseCliModelHints(value: unknown): CliModelHints | null {
  return readCliModels(value)
}

/** 解析状态文件；格式不对的部分一律按「没有」处理，永不抛错。 */
export function parseServiceStatus(text: string, now: Date): ServiceStatus {
  return parseServiceStatusDocument(text, now) ?? emptyServiceStatus
}

/**
 * 同上，只是整份不是 JSON 对象时返回 null，不给空白的那一份。门户页、半截内容这类 200 回来的
 * 东西算「没读到」：对维护提示两者一样，但分组对照要靠它接着用上一次读到的那份（lastKnown）。
 */
export function parseServiceStatusDocument(text: string, now: Date): ServiceStatus | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const accountGroups = readAccountGroups(parsed.accountGroups)
  const cliModels = readCliModels(parsed.cliModels)
  const updatedAt = readUpdatedAt(parsed.updatedAt, now)
  const badVersions = readBadVersions(parsed.badVersions)
  const badVersionPlatforms = readBadVersionPlatforms(parsed.badVersionPlatforms, badVersions)
  const minimumVersion = readMinimumVersion(parsed.minimumVersion)
  const minimumVersionPlatforms = minimumVersion ? readReleasePlatforms(parsed.minimumVersionPlatforms) : null
  return {
    maintenance: readMaintenance(parsed.maintenance, now),
    badVersions,
    ...(badVersionPlatforms ? { badVersionPlatforms } : {}),
    rollout: readRollout(parsed.rollout),
    minimumVersion,
    ...(minimumVersionPlatforms ? { minimumVersionPlatforms } : {}),
    ...(parsed.toolRouteRewrite === 'merge' ? { toolRouteRewrite: 'merge' as const } : {}),
    ...(accountGroups ? { accountGroups } : {}),
    ...(cliModels ? { cliModels } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  }
}

export interface ServiceStatusReaderOptions {
  url: string
  fetch: (url: string, init: RequestInit) => Promise<Response>
  timeoutMs?: number
  now?: () => Date
}

/**
 * 读一次状态文件。读不到（没联网、文件不存在、超时、被重定向、太大、不是 JSON）
 * 返回 null，调用方把它当成「没在维护」。
 *
 * 重定向直接拒绝：这份文件和更新清单放在同一个目录，没有任何理由跳去别处；门户
 * 认证页之类的拦截会把它换成一张网页，跟着跳过去读到的只会是别人的内容。
 */
export async function readServiceStatus(options: ServiceStatusReaderOptions): Promise<ServiceStatus | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? defaultTimeoutMs)
  timer.unref?.()
  try {
    const response = await options.fetch(options.url, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    const text = await readBoundedResponseText(response, maxStatusBytes, '服务状态文件')
    return parseServiceStatusDocument(text, (options.now ?? (() => new Date()))())
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export interface ServiceStatusMonitorOptions {
  read: () => Promise<ServiceStatus | null>
  onChange: (status: ServiceStatus | null) => void
  /** 平时多久看一次；默认 15 分钟。 */
  idleIntervalMs?: number
  /** 维护期间多久看一次，好让维护一结束提示就消失；默认 5 分钟。 */
  activeIntervalMs?: number
}

export interface ServiceStatusMonitor {
  start(): void
  refresh(): Promise<ServiceStatus | null>
  current(): ServiceStatus | null
  /**
   * 正在读就等这一次读完，没在读就给手上现有的那份，自己不发请求。登录后签 Key 要看分组对照，
   * 又不能因为状态文件读不到就每次多等一个超时，所以只搭启动时（或定时）那一次的便车。
   */
  settled(): Promise<ServiceStatus | null>
  /**
   * 最近一次读成功的那份；一次也没读成功过是 null。维护提示读不到就当没在维护，分组对照不能这样：
   * 站上删了老名字以后对照是唯一认得出新名字的办法，一次定时读失败不该让签 Key 退回老名字。型号表同理。
   */
  lastKnown(): ServiceStatus | null
  dispose(): void
}

function sameStatus(left: ServiceStatus | null, right: ServiceStatus | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * 启动时读一次，之后定时再读。同一时间只有一个请求在路上，调用方并发 refresh
 * 拿到的是同一个结果；结果变了才通知。
 */
export function createServiceStatusMonitor(options: ServiceStatusMonitorOptions): ServiceStatusMonitor {
  const idleIntervalMs = options.idleIntervalMs ?? 15 * 60_000
  const activeIntervalMs = options.activeIntervalMs ?? 5 * 60_000
  let status: ServiceStatus | null = null
  let lastKnown: ServiceStatus | null = null
  let inflight: Promise<ServiceStatus | null> | null = null
  let timer: NodeJS.Timeout | null = null
  let started = false
  let disposed = false

  function schedule(): void {
    if (timer) clearTimeout(timer)
    timer = null
    if (!started || disposed) return
    timer = setTimeout(() => {
      timer = null
      void refresh()
    }, status?.maintenance ? activeIntervalMs : idleIntervalMs)
    timer.unref?.()
  }

  function refresh(): Promise<ServiceStatus | null> {
    if (disposed) return Promise.resolve(status)
    if (inflight) return inflight
    inflight = (async () => {
      let next: ServiceStatus | null
      try {
        next = await options.read()
      } catch {
        next = null
      }
      if (disposed) return status
      const changed = !sameStatus(status, next)
      status = next
      if (next) lastKnown = next
      if (changed) {
        try { options.onChange(next) } catch { /* a listener failure must not stop the polling */ }
      }
      return status
    })().finally(() => {
      inflight = null
      schedule()
    })
    return inflight
  }

  return {
    start() {
      if (started || disposed) return
      started = true
      void refresh()
    },
    refresh,
    current: () => status,
    settled: () => inflight ?? Promise.resolve(status),
    lastKnown: () => lastKnown,
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
