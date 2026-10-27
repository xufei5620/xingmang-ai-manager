import type { CommandResult } from './command-runner'
import { readDesktopBucketPackage } from './desktop-package-bucket'
import {
  compareMacosDesktopVersions,
  macosDesktopAppReplaceable,
  macosDesktopBucketPackageId,
  type MacosDesktopAppId,
  type MacosDesktopAppProcess,
  type MacosDesktopArchitecture,
} from './macos-desktop-app-installer'

/**
 * Mac 上星芒一键装的那几个桌面端有新版时，首页提醒、点一下就在星芒里更新（yoyo 2026-10-27「桌面端更新改」）。
 * 以前星芒只装新的、不碰装着的，新版全靠它们自己升级；它们问新版的地址国内直连多半不通（#1373），
 * 很多客户一直停在星芒当初装的那一版。
 *
 * 新版以星芒自己的存储桶为准：同步作业每 6 小时从官方拉一次、核过签名才放上去，一键安装也是从这里下，
 * 国内直连，清单几 KB。所以「有新版」= 桶里的比装着的新；它自己升级过、比桶里还新的不提醒。
 */

// 同步作业每 6 小时跑一次，清单在这之间不会变。读不到的过半小时再问，免得桶一时不通就半天不提醒。
const latestVersionTtlMs = 6 * 60 * 60_000
const failedLookupTtlMs = 30 * 60_000
/**
 * 首页检测最多为它多等这么久：清单在上海，国内一般零点几秒就回来。超了就这一轮先不提醒，
 * 那次请求照样跑完、记进缓存，下一轮检测就有了。
 */
export const macosDesktopLatestVersionBudgetMs = 3_000
// 先请主程序退出，等这么久；还有没走的再请一次，再等这么久。都是正常退出，不强杀。
const quitMainWaitMs = 20_000
const quitRemainingWaitMs = 10_000
const quitPollMs = 500
const processListTimeoutMs = 10_000
const processListMaximumBytes = 4 * 1024 * 1024

/**
 * 系统设置「隐私与安全性 → App 管理」那一页。macOS 13 起替换别家签名的 App 要这里允许星芒，没允许时挪旧版那一步
 * 系统回 EPERM（macosDesktopAppManagementBlockedMessage）。写死在主进程，渲染层只说要打开它。
 */
export const macosAppManagementSettingsUrl = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles'

export interface MacosDesktopLatestVersionLookup {
  /** 存储桶里这一家、这种芯片的最新版本号；桶里没有、读不到都是 null。永不抛错。 */
  latest(tool: MacosDesktopAppId, architecture: MacosDesktopArchitecture): Promise<string | null>
}

export interface MacosDesktopLatestVersionLookupOptions {
  fetch: typeof fetch
  now?: () => number
  /** 测试换成假的清单。 */
  readPackage?: typeof readDesktopBucketPackage
  /** 读不到清单的原话，只进运行日志。 */
  onFailure?(detail: string): void
}

export function createMacosDesktopLatestVersionLookup(options: MacosDesktopLatestVersionLookupOptions): MacosDesktopLatestVersionLookup {
  const now = options.now ?? Date.now
  const readPackage = options.readPackage ?? readDesktopBucketPackage
  const entries = new Map<string, { at: number; ttl: number; version: Promise<string | null> }>()
  function latest(tool: MacosDesktopAppId, architecture: MacosDesktopArchitecture): Promise<string | null> {
    const id = macosDesktopBucketPackageId(tool, architecture)
    if (!id) return Promise.resolve(null)
    const cached = entries.get(id)
    if (cached && now() - cached.at < cached.ttl) return cached.version
    // 还在读的那一次也算缓存：同一轮检测里 Codex 和外部客户端一起问，只读一次。
    const entry = { at: now(), ttl: latestVersionTtlMs, version: Promise.resolve<string | null>(null) }
    entry.version = readPackage(id, options.fetch).then((release) => release.version, (error: unknown) => {
      entry.ttl = failedLookupTtlMs
      options.onFailure?.(`${id}：${error instanceof Error ? error.message : String(error)}`)
      return null
    })
    entries.set(id, entry)
    return entry.version
  }
  return { latest }
}

/** 在 budgetMs 之内拿到就用，拿不到先当不知道（返回 null）；那次请求不取消，照样跑完。 */
export function withinMacosDesktopLatestVersionBudget(
  version: Promise<string | null>,
  budgetMs: number = macosDesktopLatestVersionBudgetMs,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), budgetMs) })
  return Promise.race([version.catch(() => null), timeout]).finally(() => clearTimeout(timer))
}

export interface MacosDesktopUpdateOffer {
  latestVersion: string | null
  updateAvailable: boolean
}

/**
 * 首页那一行要不要出「可更新到 v…」：装着、版本读得出来、在「应用程序」里（星芒换得了），桶里那版比它新。
 * 有一样不满足就不提醒；latestVersion 照样带上，给反馈报告看。
 */
export function buildMacosDesktopUpdateOffer(
  tool: MacosDesktopAppId,
  installed: { path: string | null, version: string | null } | null,
  latestVersion: string | null,
  userHome: string,
): MacosDesktopUpdateOffer {
  const updateAvailable = Boolean(installed?.path && installed.version && latestVersion
    && macosDesktopAppReplaceable(tool, installed.path, userHome)
    && compareMacosDesktopVersions(latestVersion, installed.version) === 1)
  return { latestVersion, updateAvailable }
}

export interface MacosBundleProcess {
  pid: number
  uid: number
  executable: string
}

/** `ps -axo pid=,uid=,comm=` 里这个应用包里跑着的那几个（主程序、帮手进程）。 */
export function parseMacosBundleProcesses(stdout: string, bundle: string): MacosBundleProcess[] {
  const prefix = `${bundle}/Contents/`
  const processes: MacosBundleProcess[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\/.*\S)\s*$/.exec(line)
    if (!match || !match[3].startsWith(prefix)) continue
    const pid = Number(match[1])
    const uid = Number(match[2])
    if (Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(uid)) processes.push({ pid, uid, executable: match[3] })
  }
  return processes
}

export interface MacosDesktopReplacementOptions {
  /** 「应用程序」里那个应用本身。 */
  bundle: string
  /** 原因原话里的名字。 */
  name: string
  /** 客户在「还开着」那个框里点了「关掉并更新」。 */
  closeRunning: boolean
  runProcess(plan: MacosDesktopAppProcess): Promise<CommandResult>
  /** 当前用户；别的账户里开着的那份星芒关不了。 */
  uid: number
  /** 测试接缝；缺省 process.kill。 */
  kill?(pid: number, signal: NodeJS.Signals): void
  /** 测试接缝；缺省按真实时间等。 */
  wait?(milliseconds: number): Promise<void>
  now?(): number
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/**
 * 新版已经放在旧版旁边、换之前调（MacosDesktopAppReplacement.beforeReplace）。它关着就直接换；开着而
 * 客户点过「关掉并更新」，先请它正常退出：主程序收到 SIGTERM（Electron 做的那几家收到它和点「退出」
 * 一样收尾），等一会儿还有没走的帮手进程再请一次，还不走就不换（不强杀，客户手头的东西不能丢）。
 * 客户没点过（点的时候它关着，下载那几分钟里又打开了）就不换，下次点会先问。抛错 = 不换，旧版原样留着。
 */
export async function prepareMacosDesktopReplacement(options: MacosDesktopReplacementOptions): Promise<void> {
  const wait = options.wait ?? waitFor
  const now = options.now ?? Date.now
  const kill = options.kill ?? ((pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal) })
  async function running(): Promise<MacosBundleProcess[]> {
    const result = await options.runProcess({ executable: '/bin/ps', argv: ['-axo', 'pid=,uid=,comm='], timeoutMs: processListTimeoutMs })
    if (result.stdout.length > processListMaximumBytes) throw new Error('进程列表太长，读不出来')
    return parseMacosBundleProcesses(result.stdout, options.bundle)
  }
  function terminate(processes: readonly MacosBundleProcess[]) {
    for (const entry of processes) {
      try {
        kill(entry.pid, 'SIGTERM')
      } catch (error) {
        // Gone between the listing and the signal: nothing left to close.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
  }
  async function goneWithin(milliseconds: number): Promise<MacosBundleProcess[]> {
    const deadline = now() + milliseconds
    let remaining = await running()
    while (remaining.length > 0 && now() < deadline) {
      await wait(quitPollMs)
      remaining = await running()
    }
    return remaining
  }
  const processes = await running()
  if (processes.length === 0) return
  if (!options.closeRunning) throw new Error(`${options.name} 在下载新版的时候被打开了，客户没同意关掉它，这次不换`)
  if (processes.some((entry) => entry.uid !== options.uid)) throw new Error(`${options.name} 在这台 Mac 的别的账户里开着，星芒关不了它`)
  const main = processes.filter((entry) => entry.executable.startsWith(`${options.bundle}/Contents/MacOS/`))
  terminate(main.length > 0 ? main : processes)
  let remaining = await goneWithin(quitMainWaitMs)
  if (remaining.length === 0) return
  if (remaining.some((entry) => entry.uid !== options.uid)) throw new Error(`${options.name} 在这台 Mac 的别的账户里开着，星芒关不了它`)
  terminate(remaining)
  remaining = await goneWithin(quitRemainingWaitMs)
  if (remaining.length > 0) throw new Error(`${options.name} 请它退出以后还开着（${remaining.length} 个进程），这次不换`)
}
