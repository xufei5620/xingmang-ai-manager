/**
 * 客户端版本上报（2026-11-20 yoyo 在线程「统计用户版本并同步到网站」里选了「软件主动报给控制台」）：
 * 登录着的软件每天最多报一次「哪个站的几号用户在用哪个版本、什么系统、什么芯片」，控制台
 * （console.solov.cc，xingmang-console 仓库）把它放进用户详情。
 *
 * 跟匿名使用统计（usage-stats.ts）是两回事，别合到一起：那一路故意不带账号，告知卡上就是这么跟客户说的，
 * 所以账号不往那里加；这一路只在登录着时发，隐私政策另写一句。
 *
 * This module decides every byte of the report, so it stays free of Electron
 * and the disk and is pinned by tests. Exactly five fields leave the machine,
 * each from a closed vocabulary or a strict pattern: the site, that site's
 * numeric user id, the app version, the OS family and the CPU architecture.
 * Anything that does not fit turns the whole report into null -- there is no
 * free text, no e-mail or user name, no machine identifier, and never a
 * credential: the console cannot verify who sent a report, and handing it the
 * account's login to check would put that credential in a second system.
 */
import { createHash } from 'node:crypto'

/** 固定地址，不跟着账号、线路或设置变；控制台那边的接收口按这个路径挂（xingmang-console 的 stations 模块）。 */
export const clientVersionReportUrl = 'https://console.solov.cc/api/public/client-versions'
export const clientVersionReportDisableEnvironmentKey = 'XINGMANG_DISABLE_CLIENT_VERSION_REPORT'
/** 一天最多试这么多次（成没成都算），控制台挂了也不会一直敲。 */
export const clientVersionReportMaxAttemptsPerDay = 3

export type ClientVersionSite = 'xm' | 'api'
export type ClientVersionOs = 'windows' | 'macos' | 'linux'
export type ClientVersionArch = 'x64' | 'arm64'

export interface ClientVersionReport {
  site: ClientVersionSite
  userId: number
  version: string
  os: ClientVersionOs
  arch: ClientVersionArch
}

export interface ClientVersionReportInput {
  /** 当前账号所在的站（realm-account-service.ts 的 RealmAccountSiteId）。 */
  siteId: string
  authenticated: boolean
  userId: unknown
  appVersion: string
  platform: string
  arch: string
}

const siteCodes: Readonly<Record<string, ClientVersionSite>> = { solov: 'xm', 'solov-api': 'api' }
const osCodes: Readonly<Record<string, ClientVersionOs>> = { win32: 'windows', darwin: 'macos', linux: 'linux' }
const archCodes: Readonly<Record<string, ClientVersionArch>> = { x64: 'x64', arm64: 'arm64' }
const appVersionPattern = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.]{1,30})?$/
// 两个站的用户编号都是数据库自增的正整数；上限只防有人把别的东西塞进来。
const maxUserId = 2_147_483_647

function own<T>(table: Readonly<Record<string, T>>, key: string): T | null {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null
}

/** 没登录、或者任何一样对不上，就整份不报（返回 null），不拿占位值凑。 */
export function buildClientVersionReport(input: ClientVersionReportInput): ClientVersionReport | null {
  if (!input.authenticated) return null
  const site = own(siteCodes, input.siteId)
  const os = own(osCodes, input.platform)
  const arch = own(archCodes, input.arch)
  if (!site || !os || !arch) return null
  const userId = input.userId
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0 || userId > maxUserId) return null
  if (!appVersionPattern.test(input.appVersion)) return null
  return { site, userId, version: input.appVersion, os, arch }
}

/**
 * 发出去的正文。键名和顺序是和控制台那边约好的（xingmang-console 的接收口按 schema 1 校验），
 * 改了要两边一起改；样例在 client-version-report.test.ts。
 */
export function serializeClientVersionReport(report: ClientVersionReport): string {
  return JSON.stringify({
    schema: 1,
    site: report.site,
    user_id: report.userId,
    version: report.version,
    os: report.os,
    arch: report.arch,
  })
}

/** 本机只记这份报告的摘要，用来判断「今天这份报过没有」：换了账号、升了版本，摘要就变，当天再报一次。 */
export function clientVersionReportDigest(report: ClientVersionReport): string {
  return createHash('sha256').update(serializeClientVersionReport(report)).digest('hex').slice(0, 32)
}

export function shouldSendClientVersionReport(input: { packaged: boolean; localBuild: boolean; env: NodeJS.ProcessEnv }): boolean {
  // 开发版、本机自己编的版本不是客户；GitHub Actions 里真装真开的打包版也不是（同 usage-stats.ts）。
  if (!input.packaged || input.localBuild) return false
  return input.env[clientVersionReportDisableEnvironmentKey] !== '1' && input.env.CI !== 'true'
}

export interface ClientVersionReportState {
  /** 最近一次报成功的那份的摘要，和报成功是哪一天（UTC，YYYYMMDD）。 */
  sentDigest: string | null
  sentDay: string | null
  attemptDay: string | null
  attempts: number
}

const dayPattern = /^\d{8}$/
const digestPattern = /^[0-9a-f]{32}$/

export function emptyClientVersionReportState(): ClientVersionReportState {
  return { sentDigest: null, sentDay: null, attemptDay: null, attempts: 0 }
}

/** 本机文件是用户可写的：认不出的一律当没报过，最多是当天多报一次。 */
export function parseClientVersionReportState(content: string): ClientVersionReportState {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return emptyClientVersionReportState()
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return emptyClientVersionReportState()
  const record = value as Record<string, unknown>
  if (record.version !== 1) return emptyClientVersionReportState()
  const day = (candidate: unknown): string | null => typeof candidate === 'string' && dayPattern.test(candidate) ? candidate : null
  const sentDigest = typeof record.sentDigest === 'string' && digestPattern.test(record.sentDigest) ? record.sentDigest : null
  const attempts = typeof record.attempts === 'number' && Number.isSafeInteger(record.attempts) && record.attempts >= 0
    ? Math.min(record.attempts, clientVersionReportMaxAttemptsPerDay)
    : 0
  const sentDay = sentDigest ? day(record.sentDay) : null
  return { sentDigest: sentDay ? sentDigest : null, sentDay, attemptDay: day(record.attemptDay), attempts }
}

export function serializeClientVersionReportState(state: ClientVersionReportState): string {
  return `${JSON.stringify({ version: 1, ...state })}\n`
}

/** 按 UTC 分天，跟匿名使用统计同一个口径。 */
export function clientVersionReportDay(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '')
}

/**
 * 这一份今天要不要发。返回发之前先落盘的状态（先记「今天又试了一次」再发：发到一半退出，下次打开也不会多试），
 * 不该发时返回 null。同一天里换账号、升版本都算新的一份，但一天总共最多试 clientVersionReportMaxAttemptsPerDay 次。
 */
export function planClientVersionReport(state: ClientVersionReportState, digest: string, day: string): ClientVersionReportState | null {
  if (state.sentDigest === digest && state.sentDay === day) return null
  const attempts = state.attemptDay === day ? state.attempts : 0
  if (attempts >= clientVersionReportMaxAttemptsPerDay) return null
  return { ...state, attemptDay: day, attempts: attempts + 1 }
}
