import type { ProgressInfo, UpdateFileInfo, UpdateInfo } from 'builder-util-runtime'
import { classifyNetworkFailure, updateNetworkFailureMessages } from './network-failure'
import { redactSecretQueryParameters, redactSecretShapes } from './redaction-patterns'
import type { ServiceMaintenance, ServiceRollout, ServiceStatus } from './service-status'

export type UpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'cancelled'
  | 'error'

/**
 * 哪一步失败了。`phase` 回答不了这个问题：检查失败、下载失败都落在 `error`，而
 * 安装失败为了留住已校验的安装包，刻意停在 `downloaded`。界面只看 `error` 就只能
 * 说一句「更新没有装上」，于是断网点一次「检查更新」也会被告知更新装不上——更新
 * 其实根本没开始下。这个字段让界面按步骤说话，并给出这一步对应的重试动作。
 */
export type UpdateFailedStep = 'check' | 'download' | 'install'

/**
 * 新版本怎么装上。缺省（快照里没有这一项）＝安装器接手退出、装完自动重开，Windows 和
 * Mac 一直是这样。
 *
 * - 'system-installer'：Linux 的 .deb。下好并核对后交给这台电脑自己的安装程序打开，软件
 *   随即关掉；客户在系统的安装窗口里点「安装」、输入开机密码，装好后自己重新打开。软件
 *   从不提权，所以既不在退出时、也不在打开时自动装，每次都由客户点一下。
 * - 'manual'：这种装法自动更新用不了（Linux 上不是用 .deb 装的，electron-updater 对它
 *   什么也不做）。阶段停在 disabled，界面请客户去下载页手动下新版本。
 */
export type UpdateInstallMethod = 'system-installer' | 'manual'

/**
 * 下载前量出来的空间缺口。不是错误：新版本照旧摆在那里（phase 仍是 available），
 * 只是这一轮没下。放进 `error` 会让界面喊「下载更新失败」，可一个字节都还没下。
 */
export interface UpdateDiskShortfall {
  /** 装这次更新估计要空出来的字节数。*/
  neededBytes: number
  /** 下载目录所在盘此刻剩下的字节数。*/
  freeBytes: number
}

export interface UpdateDownloadOptions {
  /** 用户看过「空间可能不够」后仍坚持要下：跳过这一次的空间预检。*/
  ignoreDiskSpace?: boolean
}

/**
 * 定义在这里而不是 installed-release.ts：这个类型经 ipc-contract.ts 进渲染层的
 * 程序图，而那个模块要读文件（node:fs），不能被拖进去（AGENTS.md T9）。
 */
export interface InstalledRelease {
  /** 这次启动是更新后的第一次。 */
  justUpdated: boolean
  /** 上次运行的版本；从还没有这项记录的旧版升上来时不知道，为 null。 */
  previousVersion: string | null
  /** 本版随包带的用户可见改动；构建时 release-notes.md 顶节不是这一版（日常测试包）时为 null。 */
  notes: string[] | null
}

export interface UpdateSnapshot {
  phase: UpdatePhase
  currentVersion: string
  availableVersion: string | null
  releaseName: string | null
  releaseNotesText: string | null
  checkedAt: string | null
  progress: {
    percent: number
    bytesPerSecond: number
    transferred: number
    total: number
    /**
     * 最近一段时间的平均速度（字节/秒），界面上写「每秒多快」用这个，不用上面那个
     * electron-updater 原样给的瞬时值——那个一秒一跳，客户看着乱。下载刚开始、样本
     * 还不够算的时候是 null；可选是为了兼容旧快照，缺省＝只显示已下载多少。
     */
    averageBytesPerSecond?: number | null
    /** 按上面的平均速度估的剩余秒数；算不出来（刚开始、不知道总大小、速度为 0）时为 null。*/
    secondsRemaining?: number | null
  } | null
  /**
   * `message` 是给用户看的中文；认不出的英文原话脱敏后放在可选的 `detail` 里，只为
   * 进 runtime.jsonl 给客服排查，界面不显示。
   */
  error: { code: string; message: string; detail?: string } | null
  /**
   * 与 `error` 同生共死：有错才有步骤，错误被清掉时一并回到 null。可选是为了
   * 向后兼容（AGENTS.md §6「缺省 = 旧行为」）——旧快照没有这个字段，界面照旧
   * 走那句不分步骤的兜底文案。
   */
  failedStep?: UpdateFailedStep | null
  development: boolean
  /**
   * True when this build ships through the unsigned release channel, where
   * electron-updater performs no installer signature check. Such a build never
   * downloads or installs on its own; the user confirms each step.
   */
  unsignedChannel?: boolean
  /**
   * 这台电脑上「自动更新」开关能不能起作用。未签名通道在没有放开之前为 false，界面
   * 据此不显示那个勾选框。可选＝旧快照，界面照旧不显示。
   */
  autoUpdateSupported?: boolean
  /**
   * 这次启动是不是刚更新完、这一版随包带了哪些改动（installed-release.ts）。整个
   * 进程生命周期内不变：更新页要一直能看到「当前版本的更新内容」，而「已更新到」
   * 的提示由渲染层在启动时读一次。可选＝旧快照，界面照旧只显示待下载版本的说明。
   */
  installedRelease?: InstalledRelease | null
  /**
   * 更新目录上的状态文件说服务正在维护时，这里是发布者写的那句话（见
   * service-status.ts）；没在维护或读不到那份文件时为 null。放在更新快照里是因为
   * 它本来就来自更新目录，而渲染层从启动那一刻起就订阅着这份快照——没登录也收得到。
   */
  serviceMaintenance?: ServiceMaintenance | null
  /**
   * 发布者在状态文件里撤回了本机正在用的这个版本。界面据此说「这个版本有已知问题」，
   * 更新器据此允许装一个更低的版本号（退回上一个好版本）。
   */
  currentVersionWithdrawn?: boolean
  /** 找到的「新版本」其实比本机旧：这是一次退回，不是升级，界面要换个说法。 */
  rollback?: boolean
  /**
   * 这一轮因为磁盘空间不够没有下载。只在 phase 为 available 时有值，阶段一变就清掉。
   * 可选＝旧快照，界面照旧。
   */
  diskShortfall?: UpdateDiskShortfall | null
  /**
   * 状态文件定了最低版本、而本机低于它时，这里是那个最低版本；否则 null。界面据此
   * 盖一层「更新后才能继续用」（见 required-update.ts）。可选＝旧快照，不拦。
   */
  requiredVersion?: string | null
  /**
   * 开机自动装上次下好的版本前那几秒的预告。系统通知在专注助手、关了通知权限的电脑上
   * 会被静默吞掉，窗口里得同时摆一张卡，不然用户看到的就是窗口自己关掉、凭空弹授权窗。
   * 只在 phase 为 downloaded 时有值，阶段一变就清掉。可选＝旧快照，界面照旧不显示。
   */
  launchInstallNotice?: LaunchInstallNotice | null
  /** 见 UpdateInstallMethod。可选＝旧快照，界面照旧按「重启安装」说。 */
  installMethod?: UpdateInstallMethod | null
}

export interface LaunchInstallNotice {
  version: string
  title: string
  body: string
  /** 预计开始安装的时刻（毫秒时间戳），界面据此倒数。 */
  installAt: number
}

export interface UpdateCheckOptions {
  /** 用户自己点了「检查更新」。分批放量只约束自动检查，不拦主动来要的人。 */
  manual?: boolean
}

type UpdateEventName =
  | 'checking-for-update'
  | 'update-not-available'
  | 'update-available'
  | 'update-downloaded'
  | 'download-progress'
  | 'update-cancelled'
  | 'error'

/**
 * The one member of builder-util-runtime's CancellationToken the stall watchdog
 * uses. The host creates the token from electron-updater's own export: the
 * library recognises a cancellation with `instanceof CancellationError`, so a
 * token from a second copy of builder-util-runtime would surface as an error.
 */
export interface UpdateDownloadCancellation {
  cancel(): void
}

/** 看门狗停掉一次下载时交给宿主记日志的东西。*/
export interface UpdateDownloadStall {
  /** true＝接下来自动重下一次；false＝这就报下载失败。*/
  retrying: boolean
  /**
   * true＝取消以后 electron-updater 那次一直没收尾，多半停在增量下载里（它不认取消）。这时
   * 再下只会接回同一次，所以不自动重下。
   */
  unsettled: boolean
  transferred: number
  total: number
}

export interface UpdateClient {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  autoRunAppAfterInstall: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  disableWebInstaller: boolean
  forceDevUpdateConfig: boolean
  /**
   * electron-updater 的增量下载（只下变了的那几段）开关，下载开始那一刻读。看门狗停住一次后
   * 重下时临时关掉增量下载，见 downloadWatched。
   */
  disableDifferentialDownload?: boolean
  logger: unknown
  on(event: UpdateEventName, listener: (...args: any[]) => void): this
  off(event: UpdateEventName, listener: (...args: any[]) => void): this
  checkForUpdates(): Promise<unknown>
  downloadUpdate(cancellationToken?: UpdateDownloadCancellation): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  /**
   * electron-updater 判断「这台电脑在不在放量范围内」的钩子，默认读 latest.yml
   * 的 stagingPercentage。这里包一层，先过状态文件里的撤回名单与分批放量。
   */
  isUserWithinRollout?: (info: UpdateInfo) => boolean | Promise<boolean>
}

export interface UpdaterService {
  getState(): UpdateSnapshot
  startup(): Promise<UpdateSnapshot>
  check(options?: UpdateCheckOptions): Promise<UpdateSnapshot>
  /** 定时检查：找到新版本且自动更新开着时顺手下载。 */
  scheduledCheck(): Promise<UpdateSnapshot>
  /** 自动更新开关刚被打开：已经找到但还没下的版本现在就开始下。 */
  autoUpdateChanged(): Promise<UpdateSnapshot>
  /** 自动更新此刻是否生效（开关开着，且这个更新通道允许自动下载）。 */
  autoUpdateEnabled(): boolean
  download(options?: UpdateDownloadOptions): Promise<UpdateSnapshot>
  install(): { accepted: true }
  /** 更新目录上的状态文件读到了新内容（null = 读不到，当没有）。 */
  setServiceStatus(status: ServiceStatus | null): void
  /** 开机自动装前的预告摆出来（或收回，null）。 */
  setLaunchInstallNotice(notice: LaunchInstallNotice | null): void
  subscribe(listener: (snapshot: UpdateSnapshot) => void): () => void
  dispose(): void
}

export interface MacInstallHandoff {
  nativeUpdateDownloadedListenerCount(): number
  retryNativeCheck(): void
}

export interface UpdaterRuntime {
  currentVersion: string
  isPackaged: boolean
  platform?: NodeJS.Platform
  localBuild?: boolean
  enableDevelopmentUpdates?: boolean
  startupCheckTimeoutMs?: number
  installLaunchTimeoutMs?: number
  /** Retry a failed update request after switching only the updater session to direct mode. */
  retryWithoutProxy?: () => Promise<void>
  /**
   * Put the updater session back on its default proxy resolution once the
   * direct-mode retry finishes. Paired with `retryWithoutProxy`; omitting it
   * keeps the old behaviour of leaving the session in direct mode.
   */
  restoreProxy?: () => Promise<void>
  now?: () => Date
  installEnvironmentGuard?: (launch: () => void) => void
  /**
   * Lets the host's quit flow stand aside before the installer is launched.
   * quitAndInstall ends in app.quit() (and on macOS closes every window first);
   * without this the window lifecycle intercepts that quit as if the user had
   * closed the window, and asks about the very update being installed. A
   * returned promise is awaited first (the host runs its quit cleanup, such as
   * stopping acceleration, which must happen before the installer kills the
   * process); returning nothing launches synchronously. A rejection is
   * reported as an install failure.
   */
  prepareInstallQuit?: () => Promise<void> | void
  /** The installer did not start after prepareInstallQuit: the app keeps running. */
  installQuitAborted?: () => void
  macInstallHandoff?: MacInstallHandoff
  /**
   * Set for builds produced with XINGMANG_UNSIGNED_RELEASE=1. electron-updater
   * skips its signature verification entirely when the package carries no
   * publisherName, so the compensating control is that nothing reaches the
   * machine without an explicit user action.
   */
  unsignedChannel?: boolean
  /**
   * Opt-in that lets the unsigned channel download on its own as well. Kept
   * separate from `unsignedChannel` because it removes the compensating control
   * described above, and the publisher has to accept that explicitly.
   */
  unsignedAutoUpdate?: boolean
  /**
   * 读用户的「自动更新」开关（app-settings 的 autoUpdate，缺省开）。每次要决定下不下载
   * 时现读，改了开关不用重启。不传＝开着（签名通道的旧行为）。
   */
  readAutoUpdate?: () => boolean
  /**
   * 后台下载（启动检查超时后补下、开发环境不等下载）没人 await，被拒绝时交给这里记日志。
   * 真正的下载失败 download() 自己会发 error 快照给界面；走到这里的多半是状态已被别处推进。
   * 不传＝静默丢弃（只为测试夹具保持旧签名）。
   */
  reportBackgroundError?: (error: unknown) => void
  /**
   * Recomputes the downloaded package digest and compares it with the manifest
   * value. Resolving false means a mismatch; throwing means the comparison could
   * not be made. Both outcomes reject the package.
   */
  verifyPackageDigest?: (filePath: string, expectedSha512: string) => Promise<boolean>
  installedRelease?: InstalledRelease | null
  /**
   * 每次检查前重读一遍更新目录上的状态文件，撤回名单与分批放量都以最新的为准。
   * 读不到返回 null（当作没有那份文件），不能抛错。
   */
  refreshServiceStatus?: () => Promise<ServiceStatus | null>
  /**
   * 下载好（或命中本地缓存）一个版本时问一句：上次运行是不是已经自动装过它、却没装上
   * （见 auto-update-install.ts 的 resolvePreviousAutoInstallFailure）。返回给用户看的
   * 那句话时，这个版本停在「安装失败」，只留「重新安装」按钮，不再自动装；返回 null
   * 照常。不传＝旧行为。
   */
  previousAutoInstallFailure?: (version: string) => string | null
  /**
   * 下载前读更新包落地那块盘的剩余字节数。读不到返回 null，照常下载（宁可让一次下载
   * 自己失败，也不因一个查不到的数字把更新拦死）。不传＝旧行为，不做预检。
   */
  readFreeDiskBytes?: () => Promise<number | null>
  /** 这一轮因为空间不够没下。宿主拿去记一条日志。*/
  diskShortfallSkipped?: (shortfall: UpdateDiskShortfall, version: string | null) => void
  /**
   * Gives each download a token the stall watchdog cancels. Cancelling settles
   * a full-package download at once. Nothing on this side can stop more than
   * that: the differential downloader never reads the token, and closing the
   * updater session's connections would not help either. Electron 43 leaves
   * HTTP/1.1 sockets that are in use open, and fails an HTTP/2 multi-range
   * response that electron-updater gave no 'error' listener, which surfaces as
   * Electron's uncaught-exception dialog. Both were reproduced against a local
   * server that stalls mid-body. Without a token the watchdog can only stop
   * waiting.
   */
  createDownloadCancellation?: () => UpdateDownloadCancellation
  /** 看门狗停掉了一次下载。宿主拿去记一条日志。*/
  downloadStalled?: (stall: UpdateDownloadStall) => void
  /** 见 UpdateInstallMethod。不传＝安装器接手退出（Windows、Mac 的旧行为）。 */
  installMethod?: UpdateInstallMethod
  /**
   * 'system-installer' 通道：把下载时已经核对过 SHA-512 的安装包交给系统安装程序。
   * 必须在返回之前就把安装程序拉起来（退出确认里选「安装并退出」时，紧接着软件就退了，
   * 等不到任何 await）；返回的 Promise resolve＝安装窗口已经交出去，reject＝没交出去，
   * 软件照常开着，报安装失败。
   */
  openSystemInstaller?: (packagePath: string) => Promise<void>
  /** 安装窗口交出去之后把软件关掉：安装包要替换的正是这个软件自己的文件。 */
  quitAfterSystemInstaller?: () => void
}

/**
 * 没有 size 时的兜底：星芒的安装包一两百 MB，装的时候还要解开一份。宁可高估一点：
 * 高估的代价是空间将将够时晚一轮下载，低估的代价是下到一半报「磁盘满」。
 */
export const updateDiskFallbackBytes = 600 * 1024 ** 2
/** 算出来再小也不低于这个数：安装器解包、写日志、系统自己也要喘口气。*/
export const updateDiskMinimumBytes = 300 * 1024 ** 2

/**
 * 更新清单里安装包的大小（electron-builder 写进 latest.yml 的 files[].size）。
 * 同一份清单里 Windows 只有一个安装包、Mac 有 zip 和 dmg，取最大的那个——
 * 下的是哪个由 electron-updater 决定，按最大的估不会少算。
 */
export function resolveUpdatePackageBytes(info: Pick<UpdateInfo, 'files'> | null | undefined): number | null {
  const files = Array.isArray(info?.files) ? info.files : []
  let largest = 0
  for (const entry of files) {
    const size = Number((entry as { size?: unknown }).size)
    if (Number.isFinite(size) && size > largest) largest = size
  }
  return largest > 0 ? Math.floor(largest) : null
}

/**
 * 装一次更新要空出来的空间：安装包本身一份，装的时候解开来至少还要两份（Windows 的
 * 安装器先解到临时目录再覆盖，Mac 先解压 zip 再替换应用）。系数是估的，不是量的。
 */
export function requiredUpdateDiskBytes(packageBytes: number | null): number {
  if (!packageBytes || packageBytes <= 0) return updateDiskFallbackBytes
  return Math.max(updateDiskMinimumBytes, packageBytes * 3)
}

/** 读不到空间（null）一律放行；够就放行；不够才给出缺口。*/
export function resolveUpdateDiskShortfall(
  freeBytes: number | null,
  neededBytes: number,
): UpdateDiskShortfall | null {
  if (freeBytes === null || !Number.isFinite(freeBytes)) return null
  if (freeBytes >= neededBytes) return null
  return { neededBytes, freeBytes: Math.max(0, Math.floor(freeBytes)) }
}

export interface DownloadProgressSample {
  at: number
  transferred: number
}

/** 算平均速度看最近多久：太短数字乱跳，太长换线路以后半天才跟上。*/
export const downloadRateWindowMs = 10_000
/** 样本跨度不到这么久就先不报速度：刚开始那一两秒的数字没有参考价值。*/
export const downloadRateMinimumSpanMs = 3_000

/**
 * 记一个进度样本，返回新的样本表。已下载的量变少了说明重新开始了（换线路、重下），
 * 旧样本作废；超出窗口的丢掉，但留最早那一个在窗口边上，好让跨度撑满整个窗口。
 */
export function recordDownloadProgressSample(
  samples: readonly DownloadProgressSample[],
  sample: DownloadProgressSample,
): DownloadProgressSample[] {
  const last = samples.at(-1)
  if (last && (sample.transferred < last.transferred || sample.at < last.at)) return [sample]
  const next = [...samples, sample]
  const cutoff = sample.at - downloadRateWindowMs
  let first = 0
  while (first < next.length - 1 && next[first + 1].at <= cutoff) first += 1
  return next.slice(first)
}

/** 样本表首尾之间的平均速度（字节/秒）；跨度不够或者没在动时返回 null。*/
export function resolveAverageDownloadRate(samples: readonly DownloadProgressSample[]): number | null {
  if (samples.length < 2) return null
  const first = samples[0]
  const last = samples[samples.length - 1]
  const span = last.at - first.at
  if (span < downloadRateMinimumSpanMs) return null
  const rate = (last.transferred - first.transferred) / (span / 1000)
  return rate > 0 ? rate : null
}

/** 还要多少秒；不知道总大小、已经下完、速度算不出来时返回 null。*/
export function resolveDownloadSecondsRemaining(
  rate: number | null,
  transferred: number,
  total: number,
): number | null {
  if (!rate || rate <= 0 || total <= 0 || transferred >= total) return null
  return Math.ceil((total - transferred) / rate)
}

/**
 * 到 `at` 这一刻的平均速度：最后一个样本之后没有新进度，就当这段时间一个字节也没进账。
 * 下载停住时 electron-updater 不再报进度，只看已有的样本，界面会一直挂着停住前的速度和
 * 「大约还要多久」。
 */
export function resolveDownloadRateAt(samples: readonly DownloadProgressSample[], at: number): number | null {
  const last = samples.at(-1)
  if (!last || at <= last.at) return resolveAverageDownloadRate(samples)
  return resolveAverageDownloadRate(recordDownloadProgressSample(samples, { at, transferred: last.transferred }))
}

/**
 * 下载多久没有新进度算停住了，和装 Codex 桌面端、Node.js 那几个大安装包同一个数
 * （download-retry.ts）。
 *
 * electron-updater 自带的 60 秒超时在 Electron 里不起作用：builder-util-runtime 把它挂在
 * 请求的 socket 事件上，而 Electron 的 net 请求不发这个事件。断网、换了网络旧连接没断
 * 干净、代理软件不转发时，下载就一直停在那里，不报错也不重试。
 */
export const updateDownloadStallMs = 45_000
/** 下载中多久看一眼：停没停住、要不要把停住前的速度收起来，都按这个节拍。*/
export const updateDownloadWatchMs = 5_000
/**
 * 取消一次停住的下载以后，最多等这么久让 electron-updater 收尾。下整个安装包时几毫秒就收完；
 * 等不到说明停在了增量下载里（它不认取消），不再干等，照「停住了」往下走。
 */
export const updateDownloadCancelWaitMs = 10_000

/** 看门狗停掉的那一次下载。只在 download() 里流转，进快照前换成「超时」那句话。*/
class UpdateDownloadStalled extends Error {
  /** 见 UpdateDownloadStall.unsettled。*/
  readonly unsettled: boolean

  constructor(unsettled: boolean) {
    super('update download stalled')
    this.name = 'UpdateDownloadStalled'
    this.unsettled = unsettled
  }
}

function waitFor(milliseconds: number): Promise<null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), milliseconds)
    timer.unref?.()
  })
}

function versionParts(version: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  return match ? match.slice(1, 4).map(Number) : null
}

/** 只比 x.y.z；比不出来（版本号写法不认识）按「不更旧」处理。 */
export function isOlderVersion(candidate: string, current: string): boolean {
  const left = versionParts(candidate)
  const right = versionParts(current)
  if (!left || !right) return false
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index]
  }
  return false
}

/**
 * 本机低于状态文件里的最低版本时返回那个最低版本，否则 null。任何一边的版本号认不出
 * 都当作不低于：这一项会把人挡在门外，拿不准就不拦。
 */
export function resolveRequiredVersion(currentVersion: string, minimumVersion: string | null | undefined): string | null {
  if (!minimumVersion || !versionParts(minimumVersion) || !versionParts(currentVersion)) return null
  return isOlderVersion(currentVersion, minimumVersion) ? minimumVersion : null
}

/**
 * 「必须更新」那道门此刻该不该亮出来：返回要求的最低版本，不拦时返回 null。
 *
 * Windows、Mac 低于最低版本就拦（旧行为）：它们的更新包和发布一起出，拦下来就有东西
 * 可装。交给系统安装器的那条路（Linux）不一样：Linux 的更新包可能还没上架、这台电脑
 * 的架构可能没有包，最低版本却是对所有平台写的。拦了也装不上，付费客户就被整个关在
 * 门外（摸底明细 U1）。所以 Linux 只在更新目录真的给了这台电脑一个够得上最低版本的
 * 新版本时才拦；退回（找到的版本比本机还旧）不算。
 */
export function resolveGatedRequiredVersion(input: {
  minimumRequired: string | null
  installMethod: UpdateInstallMethod | null | undefined
  availableVersion: string | null
  rollback: boolean
}): string | null {
  const minimum = input.minimumRequired
  if (!minimum) return null
  if (input.installMethod !== 'system-installer') return minimum
  const offered = input.availableVersion
  if (!offered || input.rollback || !versionParts(offered)) return null
  return isOlderVersion(offered, minimum) ? null : minimum
}

/**
 * 退回的下限。撤回名单让更新目录有了「把客户端装回旧版本」的能力；更新目录一旦被
 * 人拿到，这条路就能被用来把大家退回一个有已知安全问题的老版本。所以退回只能退到
 * 这个版本及以后：它是第一个有清单备份、能被正规回退流程选中的版本。以后哪一版修了
 * 安全问题，就把这里抬到那一版，更新目录再也没法把客户端退到它之前。
 */
export const rollbackFloorVersion = '0.2.9'

export type UpdateOfferDecision =
  | { offer: false }
  | { offer: true; stagingPercentage?: number }

/**
 * 更新目录给出了某个版本时，这台电脑要不要接：
 * - 撤回名单上的版本一律不接，手动检查也不接；
 * - 分批放量只管自动检查：用户主动点「检查更新」的不拦，本机版本已被撤回的也不拦
 *   （它得尽快离开这个版本）；
 * - 其余交回 electron-updater 原本的判断（latest.yml 里的 stagingPercentage）。
 */
export function decideUpdateOffer(input: {
  version: string
  currentVersion: string
  badVersions: readonly string[]
  rollout: ServiceRollout | null
  manual: boolean
  rollbackFloor?: string
}): UpdateOfferDecision {
  const version = input.version.trim().replace(/^v/i, '')
  const bad = new Set(input.badVersions)
  if (bad.has(version)) return { offer: false }
  if (
    isOlderVersion(version, input.currentVersion)
    && (!versionParts(version) || isOlderVersion(version, input.rollbackFloor ?? rollbackFloorVersion))
  ) return { offer: false }
  const currentWithdrawn = bad.has(input.currentVersion)
  if (input.rollout && input.rollout.version === version && !input.manual && !currentWithdrawn) {
    return { offer: true, stagingPercentage: input.rollout.percent }
  }
  return { offer: true }
}

// Chromium reports an unreachable proxy as a structured net error code. The
// only reaction to it is taking the updater session off the user's proxy, so
// the match must never be made against free text: a release note, a mirror's
// HTML error page or a manifest field that merely mentions the code would
// otherwise be enough to bypass a proxy the user deliberately configured.
const PROXY_CONNECTION_FAILED_CODE = 'ERR_PROXY_CONNECTION_FAILED'

function isProxyConnectionFailure(error: unknown): boolean {
  // electron-updater wraps executor failures, so follow a bounded cause chain
  // rather than only inspecting the outermost error.
  let candidate: unknown = error
  for (let depth = 0; depth < 4 && candidate !== null && candidate !== undefined; depth += 1) {
    const code = (candidate as { code?: unknown }).code
    if (typeof code === 'string' && code.toUpperCase() === PROXY_CONNECTION_FAILED_CODE) return true
    candidate = (candidate as { cause?: unknown }).cause
  }
  return false
}

function releaseNotesText(info: UpdateInfo): string | null {
  const notes = info.releaseNotes
  if (typeof notes === 'string') return notes.trim().slice(0, 20_000) || null
  if (!Array.isArray(notes)) return null
  const text = notes
    .map((entry) => [entry.version, entry.note?.trim()].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n')
  return text.slice(0, 20_000) || null
}

interface DownloadedUpdateEvent extends UpdateInfo {
  downloadedFile?: string
}

function fileNameOf(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return (separator < 0 ? trimmed : trimmed.slice(separator + 1)).toLowerCase()
}

function manifestFileName(entry: UpdateFileInfo): string {
  const url = typeof entry.url === 'string' ? entry.url : ''
  if (!url) return ''
  try {
    return fileNameOf(decodeURIComponent(url))
  } catch {
    return fileNameOf(url)
  }
}

/**
 * Resolves the SHA-512 the manifest declared for the file that was actually
 * downloaded. Returns null when no digest can be attributed to that file, which
 * the caller treats as a rejection rather than as "nothing to check".
 */
function manifestPackageDigest(info: UpdateInfo, downloadedFile: string): string | null {
  const target = fileNameOf(downloadedFile)
  const entries = (Array.isArray(info.files) ? info.files : [])
    .filter((entry): entry is UpdateFileInfo => Boolean(entry))
  const named = entries.find((entry) => {
    const name = manifestFileName(entry)
    return name.length > 0 && name === target
  })
  // A single-artifact manifest leaves no ambiguity about which digest applies,
  // even when the cached file was renamed on the way to disk. A manifest that
  // does list this file, on the other hand, never borrows another file's digest.
  const chosen = named ?? (entries.length === 1 ? entries[0] : null)
  if (chosen) {
    const digest = typeof chosen.sha512 === 'string' ? chosen.sha512.trim() : ''
    return digest || null
  }
  if (entries.length > 0) return null
  const legacy = typeof info.sha512 === 'string' ? info.sha512.trim() : ''
  return legacy || null
}

function digestFailureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 200) || '未知错误'
}

function hasChannelManifestUrl(description: string, channelFile: string): boolean {
  const failedRequestUrl = description.match(
    /\b(?:for\s+|method:\s*(?:GET|HEAD)\s+url:\s*)(https?:\/\/[^\s"'<>]+)/i,
  )?.[1]
  if (!failedRequestUrl) return false
  try {
    const url = new URL(failedRequestUrl)
    return url.pathname.slice(url.pathname.lastIndexOf('/') + 1) === channelFile
  } catch {
    return false
  }
}

function safeError(error: unknown, platform: NodeJS.Platform): { code: string; message: string; detail?: string } {
  const candidate = error as {
    code?: unknown
    message?: unknown
    statusCode?: unknown
    description?: unknown
  }
  const code = typeof candidate?.code === 'string' ? candidate.code.slice(0, 80) : 'UPDATE_ERROR'
  // 网络先判：`net::ERR_INTERNET_DISCONNECTED` 这类原文对用户毫无意义，而它恰恰是
  // 更新失败里最常见的一类。原始 code 仍然原样留在 error.code 里，runtime.jsonl
  // 因此不丢线索，界面上只留中文。
  const networkFailure = classifyNetworkFailure(error)
  if (networkFailure) return { code, message: updateNetworkFailureMessages[networkFailure] }
  const channelFile = platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml'
  const source = typeof candidate?.message === 'string' ? candidate.message : String(error)
  const description = typeof candidate?.description === 'string' ? candidate.description : source
  const isNotFound = candidate?.statusCode === 404 || /\b404\b/.test(source)
  const redacted = redactSecretShapes(redactSecretQueryParameters(
    source.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@'),
  )).slice(0, 500)
  const missingChannelManifest = code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
    || (
      isNotFound
      && (platform === 'darwin' || platform === 'win32')
      && hasChannelManifestUrl(description, channelFile)
    )
  // 这两种是发布那头的事，客户什么也改不了；清单文件名只进 detail 给客服看。
  const message = missingChannelManifest
    ? '更新服务器上这一版的更新文件还没放好，不是你这边的问题。稍后再试；急着用请找客服。'
    : /<!doctype\s+html|<html|text\/html|unexpected\s+token\s+["']?</i.test(source)
      ? '更新服务器这会儿返回的内容不对，不是你这边的问题。稍后再试；还不行请找客服。'
      : null
  if (message) {
    const detail = missingChannelManifest
      ? `更新服务器缺少更新清单 ${channelFile}`
      : `更新服务器返回了网页而不是 ${channelFile}`
    return { code, message, detail }
  }
  const translated = describeUnrecognizedUpdateFailure(redacted)
  return translated === redacted
    ? { code, message: translated || '更新操作失败' }
    : { code, message: translated, ...(redacted ? { detail: redacted } : {}) }
}

/**
 * electron-updater 与 Node 的原话几乎都是英文（`ENOENT: no such file or directory…`），
 * 直接上屏客户看不懂。认得出的按原因说人话，认不出的也不贴原文，只说原话记进日志了；
 * 本来就是中文的（主进程自己抛的那些）原样保留。原话放在 detail 里进 runtime.jsonl。
 */
export function describeUnrecognizedUpdateFailure(source: string): string {
  if (!source || /[\u4e00-\u9fff]/.test(source)) return source
  if (/\bENOSPC\b|no space left/i.test(source)) return '电脑的磁盘空间不够了，清出一些空间后再试。'
  if (/\b(?:EPERM|EACCES|EBUSY)\b|operation not permitted|permission denied|resource busy/i.test(source)) {
    return '新版本的安装包写不进去或被占用了，常见是安全软件拦了。重开软件再试；还不行请找客服。'
  }
  if (/\bENOENT\b|no such file|sha512|checksum/i.test(source)) {
    return '下载好的安装包不完整或被删掉了，常见是安全软件拦了。重新下载一次就好。'
  }
  // 这句会出现在更新页、首页气泡和强制更新那道门三处，三处的按钮不一样（门里没有
  // 「查看日志」，气泡里也没有），所以只说发生了什么、哪三处都做得到的下一步。
  return '更新没有完成，没认出是哪一类问题，原因已经记下来了。再试一次；还不行请找客服。'
}

function cloneInstalledRelease(release: InstalledRelease | null | undefined): InstalledRelease | null {
  return release ? { ...release, notes: release.notes ? [...release.notes] : null } : null
}

function cloneSnapshot(snapshot: UpdateSnapshot): UpdateSnapshot {
  return {
    ...snapshot,
    progress: snapshot.progress ? { ...snapshot.progress } : null,
    error: snapshot.error ? { ...snapshot.error } : null,
    diskShortfall: snapshot.diskShortfall ? { ...snapshot.diskShortfall } : null,
    installedRelease: cloneInstalledRelease(snapshot.installedRelease),
    serviceMaintenance: snapshot.serviceMaintenance ? { ...snapshot.serviceMaintenance } : null,
    launchInstallNotice: snapshot.launchInstallNotice ? { ...snapshot.launchInstallNotice } : null,
  }
}

export function createUpdaterService(
  client: UpdateClient,
  runtime: UpdaterRuntime,
): UpdaterService {
  const development = !runtime.isPackaged || runtime.localBuild === true
  const platform = runtime.platform ?? process.platform
  const installMethod = runtime.installMethod ?? null
  const systemInstaller = installMethod === 'system-installer'
  // 'manual' 的装法 electron-updater 不认（checkForUpdates 什么事件都不发就返回），
  // 开着只会让界面永远停在「正在检查」。
  const enabled = runtime.localBuild !== true
    && installMethod !== 'manual'
    && (runtime.isPackaged || runtime.enableDevelopmentUpdates === true)
  const listeners = new Set<(snapshot: UpdateSnapshot) => void>()
  const now = runtime.now ?? (() => new Date())
  const startupCheckTimeoutMs = runtime.startupCheckTimeoutMs ?? 8_000
  const installLaunchTimeoutMs = runtime.installLaunchTimeoutMs ?? 10_000
  const retryWithoutProxy = runtime.retryWithoutProxy
  const restoreProxy = runtime.restoreProxy
  const installEnvironmentGuard = runtime.installEnvironmentGuard ?? ((launch) => launch())
  const macInstallHandoff = platform === 'darwin' ? runtime.macInstallHandoff : undefined
  const unsignedChannel = runtime.unsignedChannel === true
  // An unsigned installer is never fetched behind the user's back unless the
  // publisher opted that channel in: otherwise the check only reports the new
  // version and waits for an explicit download.
  const autoUpdateSupported = !unsignedChannel || runtime.unsignedAutoUpdate === true
  const autoDownload = (): boolean => {
    if (!autoUpdateSupported) return false
    try {
      return runtime.readAutoUpdate ? runtime.readAutoUpdate() !== false : true
    } catch {
      return true
    }
  }
  const verifyPackageDigest = runtime.verifyPackageDigest
  let installWatchdogTimer: NodeJS.Timeout | null = null
  let startupPromise: Promise<UpdateSnapshot> | null = null
  let installRequested = false
  let macInstallHandoffRegistered = false
  let disposed = false
  let lastProgressAt = 0
  let serviceStatus: ServiceStatus | null = null
  let manualCheck = false
  let lastProgressPercent = -1
  let progressSamples: DownloadProgressSample[] = []
  let offeredPackageBytes: number | null = null
  // 状态文件定的最低版本、而本机低于它时的那个版本。快照里的 requiredVersion 由它和
  // 当前提议一起算（resolveGatedRequiredVersion），分批放量的豁免则只看它。
  let minimumRequired: string | null = null
  // 下载后 SHA-512 核对通过的那个安装包。只有 'system-installer' 通道用它：安装包要原样
  // 交给系统安装程序，而不是像 electron-updater 那样由它自己去找缓存里的文件。
  let verifiedPackagePath: string | null = null
  // 正在下载的那一次的看门狗（见 downloadWatched）；没在下载时为 null。
  let downloadWatch: { observe(percent: number): void; stop(): void } | null = null
  // 看门狗放弃了、electron-updater 那边还没收尾的下载。取消的只有看门狗，所以这期间它发来的
  // 「已取消」都是回声，没人盯着时来的进度也都是这几次的。
  const abandonedDownloads = new Set<Promise<unknown>>()
  let snapshot: UpdateSnapshot = {
    phase: enabled ? 'idle' : 'disabled',
    currentVersion: runtime.currentVersion,
    availableVersion: null,
    releaseName: null,
    releaseNotesText: null,
    checkedAt: null,
    progress: null,
    error: null,
    failedStep: null,
    development,
    unsignedChannel,
    autoUpdateSupported,
    installedRelease: cloneInstalledRelease(runtime.installedRelease),
    serviceMaintenance: null,
    currentVersionWithdrawn: false,
    rollback: false,
    diskShortfall: null,
    requiredVersion: null,
    launchInstallNotice: null,
    // 只在 Linux 上出现：Windows、Mac 的快照与以前逐字相同。
    ...(installMethod ? { installMethod } : {}),
  }

  client.autoDownload = false
  client.autoInstallOnAppQuit = false
  client.autoRunAppAfterInstall = true
  client.allowPrerelease = false
  client.allowDowngrade = false
  client.disableWebInstaller = true
  client.forceDevUpdateConfig = development && enabled
  client.logger = null

  function isWithdrawn(version: string | null | undefined): boolean {
    return Boolean(version) && (serviceStatus?.badVersions ?? []).includes(String(version).trim().replace(/^v/i, ''))
  }

  // 撤回名单与分批放量都在 electron-updater 判断「有没有可用更新」的那一步生效：
  // 被拦下的版本对它来说就是没有更新，后面的下载、安装根本不会开始。
  const defaultRolloutCheck = client.isUserWithinRollout
  client.isUserWithinRollout = async (info: UpdateInfo) => {
    const decision = decideUpdateOffer({
      version: info.version,
      currentVersion: runtime.currentVersion,
      badVersions: serviceStatus?.badVersions ?? [],
      rollout: serviceStatus?.rollout ?? null,
      // 被要求必须更新的电脑不受分批放量限制：放量挡住它，它就只能停在要淘汰的版本上。
      // 看的是本机低不低于最低版本，不是那道门亮没亮：Linux 的门要等有了提议才亮。
      manual: manualCheck || Boolean(minimumRequired),
    })
    if (!decision.offer) return false
    if (!defaultRolloutCheck) return true
    return defaultRolloutCheck(decision.stagingPercentage === undefined
      ? info
      : { ...info, stagingPercentage: decision.stagingPercentage })
  }

  const emit = (patch: Partial<UpdateSnapshot>) => {
    // 失败步骤在这里统一跟着 error 走：清错误的地方有七八处（applyInfo、进度、
    // 请求安装……），逐处补一句 failedStep: null 早晚会漏一处，漏掉的那处会让界面
    // 在一次成功的检查之后还挂着上一次的失败按钮。
    const failedStep = patch.failedStep !== undefined
      ? patch.failedStep
      : patch.error === null ? null : snapshot.failedStep
    // 空间缺口同理：它只描述「这个版本摆着、这一轮没下」，阶段一离开 available
    // （开始下、重新检查、出错、被撤回）就不再成立。
    const phase = patch.phase ?? snapshot.phase
    const diskShortfall = phase !== 'available'
      ? null
      : patch.diskShortfall !== undefined ? patch.diskShortfall : snapshot.diskShortfall ?? null
    // 开机装的预告同理：它说的是「这个下好的版本马上装」，离开 downloaded（被撤回、
    // 重新检查）或者安装器没起来报了错，就不该再挂着倒数。
    const launchInstallNotice = phase !== 'downloaded' || (patch.error !== undefined && patch.error !== null)
      ? null
      : patch.launchInstallNotice !== undefined ? patch.launchInstallNotice : snapshot.launchInstallNotice ?? null
    const merged = { ...snapshot, ...patch, failedStep, diskShortfall, launchInstallNotice }
    // 那道门跟着提议走（见 resolveGatedRequiredVersion），提议在这里统一落地，门也就在
    // 这里统一重算，不用每个改 availableVersion 的地方各补一句。
    const requiredVersion = resolveGatedRequiredVersion({
      minimumRequired,
      installMethod,
      availableVersion: merged.availableVersion,
      rollback: merged.rollback === true,
    })
    snapshot = { ...merged, requiredVersion }
    const value = cloneSnapshot(snapshot)
    for (const listener of listeners) listener(value)
  }

  const applyInfo = (phase: UpdatePhase, info: UpdateInfo, extra: Partial<UpdateSnapshot> = {}) => {
    emit({
      phase,
      availableVersion: phase === 'not-available' ? null : info.version,
      rollback: phase !== 'not-available' && isOlderVersion(info.version, runtime.currentVersion),
      releaseName: info.releaseName?.trim() || null,
      releaseNotesText: releaseNotesText(info),
      checkedAt: now().toISOString(),
      progress: null,
      error: null,
      ...extra,
    })
  }

  // 已经找到或下载好的版本刚被撤回：收回这个提议，界面回到「没有可装的更新」。
  const withdrawOffer = () => {
    verifiedPackagePath = null
    emit({
      phase: 'idle',
      availableVersion: null,
      releaseName: null,
      releaseNotesText: null,
      rollback: false,
      progress: null,
      error: null,
    })
  }

  const applyServiceStatus = (status: ServiceStatus | null) => {
    serviceStatus = status
    const maintenance = status?.maintenance ? { message: status.maintenance.message } : null
    const patch: Partial<UpdateSnapshot> = {}
    if (JSON.stringify(maintenance) !== JSON.stringify(snapshot.serviceMaintenance ?? null)) {
      patch.serviceMaintenance = maintenance
    }
    const withdrawn = isWithdrawn(runtime.currentVersion)
    if (withdrawn !== (snapshot.currentVersionWithdrawn === true)) patch.currentVersionWithdrawn = withdrawn
    // 开发态装不了更新，拦下来只会把人困住。
    const required = enabled && !development ? resolveRequiredVersion(runtime.currentVersion, status?.minimumVersion) : null
    const previouslyRequired = minimumRequired
    minimumRequired = required
    // 快照里的 requiredVersion 由 emit 按 minimumRequired 重算，这里只判断要不要发一次。
    if (Object.keys(patch).length || required !== previouslyRequired) emit(patch)
    // 最低版本是软件开着时才定下的：上一次检查可能已经说过「没有新版本」，界面据此不拦。
    // 刚变成「必须更新」时补查一次，免得要等到三小时后的例行检查。
    if (
      required
      && required !== previouslyRequired
      && (snapshot.phase === 'idle' || snapshot.phase === 'not-available' || snapshot.phase === 'error')
    ) void check().catch(() => undefined)
    if (
      !installRequested
      && isWithdrawn(snapshot.availableVersion)
      && (snapshot.phase === 'available' || snapshot.phase === 'downloaded' || snapshot.phase === 'cancelled')
    ) withdrawOffer()
  }

  const syncServiceStatus = async () => {
    if (!runtime.refreshServiceStatus) return
    try {
      applyServiceStatus(await runtime.refreshServiceStatus())
    } catch {
      // 状态文件读不到只是少一份信息，检查照常进行。
    }
  }

  const clearInstallWatchdog = () => {
    if (installWatchdogTimer) clearTimeout(installWatchdogTimer)
    installWatchdogTimer = null
  }

  const reportInstallFailure = (error: unknown) => {
    clearInstallWatchdog()
    installRequested = false
    try { runtime.installQuitAborted?.() } catch { /* The failure below is what the user needs to see. */ }
    emit({
      // The verified package remains available for a retry. Keeping the phase
      // downloaded also makes the recovery action visible in the UI.
      phase: 'downloaded',
      progress: null,
      error: safeError(error, platform),
      failedStep: 'install',
    })
  }

  const requestInstall = (): boolean => {
    if (development || disposed || installRequested) return false
    clearInstallWatchdog()
    installRequested = true
    emit({ error: null })
    let preparation: Promise<void> | void
    try {
      preparation = runtime.prepareInstallQuit?.()
    } catch (error) {
      reportInstallFailure(error)
      return false
    }
    if (!preparation) return launchInstaller()
    void preparation.then(() => {
      if (disposed || !installRequested) return
      launchInstaller()
    }, reportInstallFailure)
    return true
  }

  const startInstallWatchdog = (message: string) => {
    installWatchdogTimer = setTimeout(() => {
      installWatchdogTimer = null
      if (!installRequested || disposed) return
      reportInstallFailure({ code: 'UPDATE_INSTALL_LAUNCH_TIMEOUT', message })
    }, installLaunchTimeoutMs)
    installWatchdogTimer.unref?.()
  }

  // Linux never lets electron-updater install: its DebUpdater builds a shell
  // command line, runs dpkg as root through pkexec/sudo found on PATH, and falls
  // back to a root `apt-get install -f -y` (摸底明细 U4). The verified package is
  // handed to the desktop's own package installer instead, which owns the
  // password prompt and the privilege boundary; this process stays unprivileged.
  const launchSystemInstaller = (): boolean => {
    const packagePath = verifiedPackagePath
    // 安装包没了要重来的是下载：停在「已下载」只会让「重新安装」一遍遍撞同一堵墙。
    const packageMissing = () => {
      try { runtime.installQuitAborted?.() } catch { /* The rejection below is what the user needs to see. */ }
      rejectDownloadedUpdate(
        'UPDATE_PACKAGE_PATH_MISSING',
        '下载好的安装包找不到了，可能被清理软件删掉了。点「重新下载」再试一次。',
      )
    }
    if (!packagePath) {
      packageMissing()
      return false
    }
    if (!runtime.openSystemInstaller) {
      reportInstallFailure({ code: 'UPDATE_SYSTEM_INSTALLER_MISSING', message: '这台电脑上没法打开安装程序。请找客服。' })
      return false
    }
    const failed = (error: unknown) => {
      if ((error as { code?: unknown } | null)?.code === 'UPDATE_PACKAGE_PATH_MISSING') packageMissing()
      else reportInstallFailure(error)
    }
    let opening: Promise<void>
    try {
      opening = runtime.openSystemInstaller(packagePath)
    } catch (error) {
      failed(error)
      return false
    }
    void opening.then(() => {
      if (disposed || !installRequested) return
      startInstallWatchdog('安装窗口已经打开了，可星芒没能自己关掉。在安装窗口里点「安装」、输入开机密码；装好后关掉星芒再重新打开。')
      runtime.quitAfterSystemInstaller?.()
    }, (error: unknown) => {
      if (disposed || !installRequested) return
      failed(error)
    })
    return true
  }

  const launchInstaller = (): boolean => {
    if (systemInstaller) return launchSystemInstaller()
    try {
      installEnvironmentGuard(() => {
        if (macInstallHandoffRegistered && macInstallHandoff) {
          macInstallHandoff.retryNativeCheck()
          return
        }
        if (!macInstallHandoff) {
          client.quitAndInstall(true, true)
          return
        }
        const listenerCount = macInstallHandoff.nativeUpdateDownloadedListenerCount()
        try {
          client.quitAndInstall(true, true)
        } finally {
          macInstallHandoffRegistered = macInstallHandoffRegistered
            || macInstallHandoff.nativeUpdateDownloadedListenerCount() > listenerCount
        }
      })
    } catch (error) {
      reportInstallFailure(error)
      return false
    }
    startInstallWatchdog(platform === 'win32'
      ? '新版本没装上：安装程序没起来，可能是 Windows 的授权窗口被关掉了。点「重新安装」再试一次，授权窗口弹出来时点「是」。'
      : '新版本没装上：安装程序没起来。点「重新安装」再试一次。')
    return true
  }

  // 下载好就停在这里，等用户点「重启安装」。以前签名通道（Mac）下载完 0.3 秒就
  // 自动退出重装，不管用户是在生图还是在装工具（全面检测 Q42），而设置页和更新页
  // 都写着安装由你确认。「自动更新」开着时也不在这里装，而是由主进程等到用户退出、
  // 或下次一打开时再装（auto-update-install.ts），同样不打断正在用的人。
  const acceptDownloadedUpdate = (info: UpdateInfo) => {
    // 下载途中被撤回的版本：下好了也不留，免得用户一点「重启安装」装上它。
    if (isWithdrawn(info.version)) {
      withdrawOffer()
      return
    }
    let previousFailure: string | null = null
    try { previousFailure = runtime.previousAutoInstallFailure?.(info.version) ?? null } catch { previousFailure = null }
    applyInfo('downloaded', info, previousFailure
      ? { error: { code: 'UPDATE_PREVIOUS_AUTO_INSTALL_FAILED', message: previousFailure }, failedStep: 'install' }
      : {})
  }

  // 安装包校验不过时要重来的是下载，不是安装：本地这一份已经不可信了。
  const rejectDownloadedUpdate = (code: string, message: string, detail?: string) => {
    clearInstallWatchdog()
    installRequested = false
    verifiedPackagePath = null
    emit({
      phase: 'error',
      checkedAt: now().toISOString(),
      progress: null,
      error: detail ? { code, message, detail } : { code, message },
      failedStep: 'download',
    })
  }

  const verifyDownloadedUpdate = async (event: DownloadedUpdateEvent) => {
    if (!verifyPackageDigest) return
    const downloadedFile = typeof event.downloadedFile === 'string' ? event.downloadedFile.trim() : ''
    if (!downloadedFile) {
      rejectDownloadedUpdate(
        'UPDATE_PACKAGE_PATH_MISSING',
        '下载好的安装包找不到了，为了安全没有安装。点「重新下载」再试一次。',
      )
      return
    }
    const expected = manifestPackageDigest(event, downloadedFile)
    if (!expected) {
      rejectDownloadedUpdate(
        'UPDATE_PACKAGE_DIGEST_MISSING',
        '更新服务器没给这个安装包的核对信息，为了安全没有安装。不是你这边的问题，稍后再试；急着用请找客服。',
        '更新清单没有提供本安装包的 SHA-512 校验值',
      )
      return
    }
    let matched: boolean
    try {
      matched = await verifyPackageDigest(downloadedFile, expected)
    } catch (error) {
      if (disposed) return
      rejectDownloadedUpdate(
        'UPDATE_PACKAGE_DIGEST_FAILED',
        '下载好的安装包没能核对完，为了安全没有安装。点「重新下载」再试一次。',
        `安装包完整性校验没有完成：${digestFailureDetail(error)}`,
      )
      return
    }
    if (disposed) return
    if (!matched) {
      rejectDownloadedUpdate(
        'UPDATE_PACKAGE_DIGEST_MISMATCH',
        '下载好的安装包和服务器上的对不上，可能是没下完整，为了安全没有安装。点「重新下载」再试一次；还不对请找客服。',
        '安装包与更新清单的 SHA-512 不一致',
      )
      return
    }
    verifiedPackagePath = downloadedFile
    acceptDownloadedUpdate(event)
  }

  const eventHandlers: Record<UpdateEventName, (...args: any[]) => void> = {
    'checking-for-update': () => emit({ phase: 'checking', progress: null, error: null }),
    'update-not-available': (info: UpdateInfo) => applyInfo('not-available', info),
    'update-available': (info: UpdateInfo) => {
      offeredPackageBytes = resolveUpdatePackageBytes(info)
      applyInfo('available', info, { diskShortfall: null })
    },
    'update-downloaded': (event: DownloadedUpdateEvent) => {
      if (disposed) return
      if (!verifyPackageDigest) {
        acceptDownloadedUpdate(event)
        return
      }
      void verifyDownloadedUpdate(event)
    },
    'update-cancelled': (info: UpdateInfo) => {
      // 取消下载的只有看门狗（autoDownload 关着，electron-updater 不会自己起一次带令牌的
      // 下载），接下来重下还是报错由它定。把它的回声落成「已取消」，会盖掉它要发的状态；
      // 放弃的那次过了很久才收尾的话，盖掉的就是界面上早已报出的失败。
      if (abandonedDownloads.size > 0) return
      clearInstallWatchdog()
      installRequested = false
      applyInfo('cancelled', info)
    },
    'download-progress': (progress: ProgressInfo) => {
      const timestamp = Date.now()
      const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0))
      const transferred = Math.max(0, Number(progress.transferred) || 0)
      const total = Math.max(0, Number(progress.total) || 0)
      // 没人盯着时来的进度，只能是看门狗放弃的那次又动了。界面已经报了下载失败，不能悄悄
      // 翻回「正在下载」又没人看它停没停；它真下完了，update-downloaded 照常接住。
      if (!downloadWatch && abandonedDownloads.size > 0) return
      // 在节流之前告诉看门狗：被节流掉的那几次同样说明数据还在来。
      downloadWatch?.observe(percent)
      // 样本在节流之前记：被节流掉的那几次也是真实的进度，算速度用得上。
      progressSamples = recordDownloadProgressSample(progressSamples, { at: timestamp, transferred })
      if (
        percent < 100
        && timestamp - lastProgressAt < 100
        && Math.abs(percent - lastProgressPercent) < 1
      ) return
      lastProgressAt = timestamp
      lastProgressPercent = percent
      const averageRate = resolveAverageDownloadRate(progressSamples)
      emit({
        phase: 'downloading',
        progress: {
          percent,
          bytesPerSecond: Math.max(0, Number(progress.bytesPerSecond) || 0),
          transferred,
          total,
          averageBytesPerSecond: averageRate,
          secondsRemaining: resolveDownloadSecondsRemaining(averageRate, transferred, total),
        },
        error: null,
      })
    },
    error: (error: unknown) => {
      if (
        snapshot.phase === 'downloaded'
        && (
          installRequested
          || (macInstallHandoffRegistered && snapshot.error !== null)
        )
      ) {
        reportInstallFailure(error)
        return
      }
      clearInstallWatchdog()
      installRequested = false
      // electron-updater 的 error 事件不说自己来自哪一步，只能按当前阶段倒推。
      // 这里永远不标 'install'：这条分支会把阶段推到 error，安装包不再可用，界面
      // 给出的「重新安装」会当场被主进程以「更新尚未下载并校验完成」顶回来。真正
      // 的安装失败走 reportInstallFailure，那条路把阶段留在 downloaded。
      emit({
        phase: 'error',
        error: safeError(error, platform),
        failedStep: snapshot.phase === 'downloading' || snapshot.phase === 'downloaded'
          ? 'download'
          : 'check',
        progress: null,
      })
    },
  }

  for (const [event, handler] of Object.entries(eventHandlers)) {
    client.on(event as UpdateEventName, handler)
  }

  // A function call is not narrowed by an earlier comparison on snapshot.phase,
  // which event handlers may have changed while an await was pending.
  const currentPhase = (): UpdatePhase => snapshot.phase

  const requireEnabled = () => {
    if (!enabled) throw new Error('开发环境未启用主程序更新')
  }

  // Direct mode is scoped to the one request that needed it. Leaving the
  // updater session pinned to 'direct' for the rest of the process would mean
  // a single proxy hiccup silently keeps every later update request off the
  // proxy the user configured, with nothing in the UI saying so.
  async function retryOffProxy(run: () => Promise<void>): Promise<void> {
    try {
      if (retryWithoutProxy) await retryWithoutProxy()
      await run()
    } finally {
      if (restoreProxy) {
        // Best effort: a failed restore must not replace the update error the
        // caller is about to report.
        try { await restoreProxy() } catch { /* keep the original outcome */ }
      }
    }
  }

  const check = async (options: UpdateCheckOptions = {}): Promise<UpdateSnapshot> => {
    requireEnabled()
    if (
      snapshot.phase === 'checking'
      || snapshot.phase === 'downloading'
      // A downloaded package with an install error must stay checkable, or a
      // failed install would lock out update checks for the whole session.
      || (snapshot.phase === 'downloaded' && !snapshot.error)
    ) return cloneSnapshot(snapshot)
    emit({ phase: 'checking', error: null, progress: null })
    await syncServiceStatus()
    if (disposed) return cloneSnapshot(snapshot)
    // 只有本机版本被撤回时才放开降级：平时 latest.yml 哪怕被误退回旧版本，也不能
    // 让全体用户跟着「更新」回去。
    client.allowDowngrade = isWithdrawn(runtime.currentVersion)
    manualCheck = options.manual === true
    let result: unknown
    try {
      result = await client.checkForUpdates()
    } catch (error) {
      if (retryWithoutProxy && isProxyConnectionFailure(error)) {
        try {
          await retryOffProxy(async () => {
            emit({ phase: 'checking', error: null, progress: null })
            result = await client.checkForUpdates()
          })
        } catch (retryError) {
          emit({ phase: 'error', error: safeError(retryError, platform), failedStep: 'check', progress: null })
        }
      } else {
        emit({ phase: 'error', error: safeError(error, platform), failedStep: 'check', progress: null })
      }
    } finally {
      manualCheck = false
    }
    // electron-updater resolves null without emitting a single event when it
    // considers this install unable to update itself (on Linux: an AppImage
    // started without $APPIMAGE, a snap, an unpacked or tar.gz build). Every
    // later check() returns early while the phase is 'checking', so without this
    // the updater would sit in '正在检查' for the rest of the session. A packaged
    // Windows or macOS build is always active, so this never fires there.
    if (result === null && currentPhase() === 'checking' && !disposed) {
      emit({
        phase: 'error',
        error: {
          code: 'UPDATE_INACTIVE',
          message: '这台电脑上的星芒没法自己更新。到下载页下载新版本的安装包，装好后打开就行；不会装请找客服。',
        },
        failedStep: 'check',
        progress: null,
      })
    }
    return cloneSnapshot(snapshot)
  }

  // 下载前先量一下盘。量不出来就当够：这一步只为省掉注定失败的下载，不能自己
  // 变成更新下不来的原因。
  const measureShortfall = async (): Promise<UpdateDiskShortfall | null> => {
    if (!runtime.readFreeDiskBytes) return null
    let freeBytes: number | null
    try {
      freeBytes = await runtime.readFreeDiskBytes()
    } catch {
      return null
    }
    return resolveUpdateDiskShortfall(freeBytes, requiredUpdateDiskBytes(offeredPackageBytes))
  }

  // 下载停住时快照里一直是停住前那个速度。还在报进度时不动它（免得多发快照）；停了一拍
  // 以上，按「这段时间没进账」重算：10 秒没进账速度就是 0，界面只留「已下载多少」。
  const refreshIdleDownloadRate = (at: number) => {
    const progress = snapshot.progress
    const last = progressSamples.at(-1)
    if (!progress || !last || at - last.at < updateDownloadWatchMs) return
    const averageBytesPerSecond = resolveDownloadRateAt(progressSamples, at)
    const secondsRemaining = resolveDownloadSecondsRemaining(averageBytesPerSecond, progress.transferred, progress.total)
    if (
      averageBytesPerSecond === (progress.averageBytesPerSecond ?? null)
      && secondsRemaining === (progress.secondsRemaining ?? null)
    ) return
    emit({ progress: { ...progress, averageBytesPerSecond, secondsRemaining } })
  }

  const noteDownloadStall = (stall: UpdateDownloadStalled, retrying: boolean) => {
    try {
      runtime.downloadStalled?.({
        retrying,
        unsettled: stall.unsettled,
        transferred: snapshot.progress?.transferred ?? 0,
        total: snapshot.progress?.total ?? 0,
      })
    } catch {
      // 记日志失败不影响接下来重下或报错。
    }
  }

  // 停住和连接超时对客户是一回事：那头没动静了。沿用更新那张表里「超时」那句，界面不多
  // 一句新话；code 另记，日志里分得清是看门狗停的。
  const downloadFailure = (error: unknown) => error instanceof UpdateDownloadStalled
    ? { code: 'UPDATE_DOWNLOAD_STALLED', message: updateNetworkFailureMessages.timeout }
    : safeError(error, platform)

  // 下载一次，期间盯着进度：updateDownloadStallMs 没有新进度就取消这一次，抛
  // UpdateDownloadStalled；electron-updater 自己报的错原样抛出。到 100% 就不再计时：之后
  // 核对签名、改名、算 SHA-512 都不报进度，各自另有超时。增量下载分批的话，下一批又会报
  // 不到 100% 的进度，计时跟着接上；只剩一段要下的那批不报进度，下得久了会被当成停住，
  // 那次接着在后台下，下完照常落到「已下载」。fullPackage 让这一次不走增量下载。
  async function downloadWatched(fullPackage: boolean): Promise<void> {
    const cancellation = runtime.createDownloadCancellation?.()
    let lastActivityAt = Date.now()
    let transferEnded = false
    let reportStall: () => void = () => undefined
    const stalled = new Promise<'stalled'>((resolve) => { reportStall = () => resolve('stalled') })
    const timer = setInterval(() => {
      if (snapshot.phase !== 'downloading') return
      const at = Date.now()
      if (transferEnded || at - lastActivityAt < updateDownloadStallMs) {
        refreshIdleDownloadRate(at)
        return
      }
      watch.stop()
      reportStall()
    }, updateDownloadWatchMs)
    timer.unref?.()
    const watch = {
      observe(percent: number) {
        lastActivityAt = Date.now()
        transferEnded = percent >= 100
      },
      stop() {
        clearInterval(timer)
        if (downloadWatch === watch) downloadWatch = null
      },
    }
    downloadWatch = watch
    const differential = client.disableDifferentialDownload
    try {
      if (fullPackage) client.disableDifferentialDownload = true
      const pending = cancellation ? client.downloadUpdate(cancellation) : client.downloadUpdate()
      // electron-updater 同时只下一次：上一次还没收尾时，downloadUpdate() 交回来的就是那一次。
      const inherited = abandonedDownloads.has(pending)
      const settled = pending.then(
        () => ({ failed: false as const, error: null }),
        (error: unknown) => ({ failed: true as const, error }),
      )
      const outcome = await Promise.race([settled, stalled])
      if (outcome !== 'stalled') {
        if (!outcome.failed) return
        // 接手的是放弃过的那次，它只会以当初那个令牌的「已取消」收场：对客户来说还是停住了，
        // 不过它这就收了尾，再下就是新的一次。
        if (inherited) throw new UpdateDownloadStalled(false)
        throw outcome.error
      }
      if (!abandonedDownloads.has(pending)) {
        abandonedDownloads.add(pending)
        const settle = () => { abandonedDownloads.delete(pending) }
        pending.then(settle, settle)
      }
      // 取消让下整个安装包的那条路当场收场。增量下载不认取消，只能不再等它。
      try { cancellation?.cancel() } catch { /* waiting below still bounds this attempt */ }
      const late = await Promise.race([settled, waitFor(updateDownloadCancelWaitMs)])
      // 停表以后它自己下完了：就当没停过。
      if (late && !late.failed) return
      throw new UpdateDownloadStalled(late === null)
    } finally {
      watch.stop()
      if (fullPackage) client.disableDifferentialDownload = differential
    }
  }

  const download = async (options: UpdateDownloadOptions = {}): Promise<UpdateSnapshot> => {
    requireEnabled()
    if (snapshot.phase === 'downloading') return cloneSnapshot(snapshot)
    if (snapshot.phase !== 'available') throw new Error('当前没有可下载的新版本')
    if (options.ignoreDiskSpace !== true) {
      const shortfall = await measureShortfall()
      if (disposed) return cloneSnapshot(snapshot)
      // 量盘是异步的，这段时间里阶段可能已经变了（另一处已经开始下、版本被撤回）。
      if (snapshot.phase !== 'available') return cloneSnapshot(snapshot)
      if (shortfall) {
        emit({ diskShortfall: shortfall, progress: null, error: null })
        try {
          runtime.diskShortfallSkipped?.(shortfall, snapshot.availableVersion)
        } catch {
          // 记日志失败不影响给用户的那句话。
        }
        return cloneSnapshot(snapshot)
      }
    }
    progressSamples = []
    verifiedPackagePath = null
    emit({ phase: 'downloading', progress: null, error: null })
    try {
      await downloadWatched(false)
    } catch (error) {
      const stall = error instanceof UpdateDownloadStalled ? error : null
      // 自动再下只有一次，再不行就照实报下载失败，重下的按钮界面上都有。停住的那次多半是
      // 这条路不通了（代理软件不转发、换了网络旧连接没断干净），和代理连不上一样换直连，
      // 而且重下整个安装包：增量下载不认取消，停住了就收不了场，它有几段也不报进度。
      // electron-updater 那次一直没收尾时不重下：再下只会接回同一次，白等一轮。
      const retry = stall
        ? !stall.unsettled
        : retryWithoutProxy !== undefined && isProxyConnectionFailure(error)
      if (stall) noteDownloadStall(stall, retry)
      if (retry) {
        try {
          await retryOffProxy(async () => {
            progressSamples = []
            emit({ phase: 'downloading', error: null, progress: null })
            await downloadWatched(stall !== null)
          })
        } catch (retryError) {
          if (retryError instanceof UpdateDownloadStalled) noteDownloadStall(retryError, false)
          emit({ phase: 'error', error: downloadFailure(retryError), failedStep: 'download', progress: null })
        }
      } else {
        emit({ phase: 'error', error: downloadFailure(error), failedStep: 'download', progress: null })
      }
    }
    return cloneSnapshot(snapshot)
  }

  function downloadInBackground(): void {
    download().catch((error: unknown) => runtime.reportBackgroundError?.(error))
  }

  return {
    getState: () => cloneSnapshot(snapshot),
    startup() {
      if (!enabled) return Promise.resolve(cloneSnapshot(snapshot))
      if (startupPromise) return startupPromise
      startupPromise = (async () => {
        let timeout: NodeJS.Timeout | null = null
        const checkPromise = check()
        const checked = await Promise.race([
          checkPromise.then((value) => ({ timedOut: false as const, value })),
          new Promise<{ timedOut: true; value: null }>((resolve) => {
            timeout = setTimeout(() => resolve({ timedOut: true, value: null }), startupCheckTimeoutMs)
            timeout.unref?.()
          }),
        ])
        if (timeout) clearTimeout(timeout)
        if (checked.timedOut) {
          // The updater emits its result event before checkForUpdates() has to
          // settle. If that event already moved the state forward, preserve it
          // instead of replacing a real result with a synthetic timeout.
          if (snapshot.phase !== 'checking') {
            const eventSnapshot = cloneSnapshot(snapshot)
            if (eventSnapshot.phase === 'available' && autoDownload()) {
              if (development) {
                downloadInBackground()
                return eventSnapshot
              }
              return download()
            }
            return eventSnapshot
          }
          // The timeout only releases the startup UI. Keep the updater request
          // alive so a slow network can still download the discovered release.
          if (autoDownload()) {
            void checkPromise.then((lateSnapshot) => {
              if (lateSnapshot.phase === 'available') downloadInBackground()
            }, (error: unknown) => runtime.reportBackgroundError?.(error))
          }
          emit({
            phase: 'error',
            checkedAt: now().toISOString(),
            progress: null,
            error: {
              code: 'STARTUP_UPDATE_TIMEOUT',
              message: '网络有点慢，这次没来得及查完有没有新版本。星芒会在后台接着查，不影响现在使用。',
            },
            failedStep: 'check',
          })
          return cloneSnapshot(snapshot)
        }
        if (checked.value.phase !== 'available' || !autoDownload()) return checked.value
        if (development) {
          downloadInBackground()
          return checked.value
        }
        return download()
      })()
      return startupPromise
    },
    check,
    async scheduledCheck() {
      const checked = await check()
      if (checked.phase !== 'available' || !autoDownload()) return checked
      return download()
    },
    async autoUpdateChanged() {
      if (!enabled || snapshot.phase !== 'available' || !autoDownload()) return cloneSnapshot(snapshot)
      return download()
    },
    autoUpdateEnabled: () => enabled && !development && autoDownload(),
    download,
    install() {
      requireEnabled()
      if (development) throw new Error('开发环境禁止执行安装更新')
      if (snapshot.phase !== 'downloaded') throw new Error('更新尚未下载并校验完成')
      if (isWithdrawn(snapshot.availableVersion)) throw new Error('这个版本已被撤回，请重新检查更新')
      if (!installRequested && !requestInstall()) {
        throw new Error(snapshot.error?.message || '更新程序未能启动')
      }
      return { accepted: true }
    },
    setServiceStatus(status) {
      if (disposed) return
      applyServiceStatus(status)
    },
    setLaunchInstallNotice(notice) {
      if (disposed) return
      if (notice && (snapshot.phase !== 'downloaded' || notice.version !== snapshot.availableVersion)) return
      if (!notice && !snapshot.launchInstallNotice) return
      emit({ launchInstallNotice: notice ? { ...notice } : null })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      disposed = true
      listeners.clear()
      clearInstallWatchdog()
      downloadWatch?.stop()
      for (const [event, handler] of Object.entries(eventHandlers)) {
        client.off(event as UpdateEventName, handler)
      }
    },
  }
}
