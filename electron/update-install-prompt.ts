/**
 * 新版本在后台下好以后，先在屏幕中间问一句要不要现在装；没装的 Mac 等电脑闲着时自己装上
 * （#1380，yoyo 2026-10-25「先弹窗装，然后再闲时装」，要的是跳到屏幕中间的框，字按「更新改」那版）。
 *
 * 为什么要有它：自动更新原来只在退出星芒、或下次打开的头两分钟装（auto-update-install.ts）。
 * 很多客户配好工具以后窗口一直缩在托盘（Mac 是菜单栏）里，Mac 又很少关机，几周碰不到退出和
 * 重开，下好的新版就一直摆着。
 *
 * - **跳框**：下好的版本都问，只有打开时装已经接手的那一版不问（记了 attempted），再问会跟它抢。
 *   打开时就已经下好、打开时装却没接手的照样问：开机自启以后窗口一直缩着（Windows 等第一次开窗口
 *   才装，Mac 要输开机密码的留到退出），或者开机两分钟里没轮到。以前这些这次运行既不装也不问，
 *   开机自启、只关机不退出的电脑就一直停在旧版（#1410）。问过以后宿主把打开时装撤下，叫出窗口
 *   时不再预告装一遍。默认按钮是「稍后再说」，回车、空格、Esc 都落在它上面，只有用鼠标点「现在
 *   安装」才装；等电脑几秒没人按键盘、动鼠标再弹，免得客户正打着字框跳出来。每个版本每次运行
 *   最多问一次。账号不在管理员组的 Windows 自己装不了，不问；关了「自动更新」的不问。网络加速开着
 *   时先不问：开加速的多半在打游戏，过场、读图那几秒就凑够「没人动」，框一跳会把游戏切出去；点了
 *   「现在安装」加速会先断，装好也不会自己连回去。等加速关了再按上面的规矩问，一直没关的这次就
 *   不问了，留给退出时或下次打开时装。付款窗口开着、对话正在出字、视频在出或在拼片时也先不问：扫码付款、
 *   等回答、等视频正好都是几秒不碰电脑，框一跳点了「现在安装」，付款页、出了一半的回答、拼了一半的片都没了，
 *   付款页没了的客户还可能以为没付成又付一次。等这几样完了再按上面的规矩问，30 秒看一次。
 * - **闲时装**：只在装的时候一个窗口也不弹的 Mac 上（canInstallUnattended）。Windows 每次装都要
 *   有人点授权窗口的「是」，没人在电脑前就卡在那儿，不做。要等电脑 10 分钟没人碰或者锁了屏，
 *   星芒的窗口都缩着，没在装工具，Claude Code 这些工具没在干活，网络加速没开，手机遥控没开着，
 *   视频没在出，界面手上没事（拼片、对话在出字这些）；问过的版本还要等「稍后再说」之后 10 分钟。
 *   每个版本只自动试一次，记在打开时装的同一条记录里（attempted），没装上就退回到退出时装。
 *   客户不在电脑前时下好的不问，直接等着闲时装；框弹出来以后人一直没回、电脑 10 分钟没人碰的，
 *   把框收掉，再按闲时装的规矩办。星芒窗口开着（含最小化）或者手机遥控开着时这两条不做：闲时装
 *   要窗口都缩着、遥控关着，遥控可能一开一整天，记成问过了或者把框收掉，这一版这次运行就再也没人
 *   管了；人不在时先不问，等人回来、几秒没动再跳框，框弹出来以后也不收。遥控开着时框里那句换成
 *   退出或下次打开时装（YK-2）。装之前跟退出时装一样，先现读一次服务状态文件（最多等几秒）：
 *   下载之后才被撤回的版本在这里收回，不装。
 *
 * 不含任何 Electron 依赖：框、窗口、空闲时长、装都由宿主接进来。
 */
import { macKeychainUpdateHint } from './mac-keychain-update-copy'
import { resolveInstallableUpdateOnQuit } from './quit-blocking-tasks'
import type { UpdateSnapshot } from './updater'

/** 电脑这么久没人按键盘、动鼠标才跳框。 */
export const PROMPT_QUIET_INPUT_MS = 3_000
/** 电脑这么久没人碰才算闲着。 */
export const IDLE_INSTALL_IDLE_MS = 10 * 60_000
/** 点了「稍后再说」以后，至少再等这么久才闲时装。 */
export const IDLE_INSTALL_AFTER_PROMPT_MS = 10 * 60_000
/** 等着跳框时多久看一次有没有人在打字。 */
export const PROMPT_POLL_MS = 2_000
/** 等着闲时装、框开着等回答、加速开着或付款、出字、出视频时先不问，多久看一次。 */
export const IDLE_POLL_MS = 30_000
/** 闲时装之前现读服务状态文件最多等这么久，读不到就按上次读到的撤回名单算（同退出时装）。 */
export const IDLE_INSTALL_STATUS_WAIT_MS = 3_000

export interface InstallPrompt {
  title: string
  message: string
  detail: string
  /** [稍后再说, 现在安装]。默认和取消都是第一个。 */
  buttons: [string, string]
}

export interface InstallPromptCopyOptions {
  /** 装的时候一个窗口也不弹，闲着时会自己装（canInstallUnattended）。 */
  unattended: boolean
  /** 星芒这次本身就带着管理员权限在跑，不弹授权窗口（windows-elevation.ts 的 highIntegrity）。 */
  elevated?: boolean
}

/**
 * 跳框里的字（yoyo 2026-10-25 回「更新改」的那一版，改字要先问他）。Mac 那句钥匙串提醒是
 * 10-28「钥匙串提示改」加的：从这里点「现在安装」，重开后第一眼看到的就是那个系统密码框。
 */
export function buildInstallPrompt(version: string, platform: NodeJS.Platform, options: InstallPromptCopyOptions): InstallPrompt {
  const consent = platform === 'win32' && !options.elevated ? 'Windows 弹出授权窗口时请点「是」。' : ''
  const keychain = platform === 'darwin' ? macKeychainUpdateHint : ''
  const later = platform !== 'darwin'
    ? '关掉软件或下次打开时自动装上。'
    : options.unattended
      ? '你不用电脑时星芒会自己装好，装完照旧待在菜单栏。'
      : '退出星芒或下次打开时自动装上。'
  return {
    title: '星芒AI管理工具',
    message: `新版 ${version} 已经下好，现在装上吗？`,
    detail: `装的时候星芒会先关掉，装好自动打开。${consent}${keychain}现在不装也行：${later}`,
    buttons: ['稍后再说', '现在安装'],
  }
}

export interface InstallPromptInput {
  autoUpdate: boolean
  snapshot: UpdateSnapshot
  /** 这一版已经自动装过或正在装（打开时装接手了、退出时、闲时，任何一种）。 */
  attempted: boolean
  /** Windows 上这个账号不在管理员组；null = 还没问出来。 */
  standardAccount: boolean | null
}

/**
 * 这一刻该问哪个版本，不该问时返回 null。账号是不是管理员还没问出来时先不问：问出来是
 * 标准账号的，那句「要输管理员密码」由原来的提示说。
 */
export function resolveInstallPromptVersion(input: InstallPromptInput): string | null {
  if (!input.autoUpdate || input.standardAccount !== false) return null
  // 交给系统安装器的版本（Linux）装的时候要输开机密码、装完不会自己打开，框里那几句都不对。
  if (input.snapshot.installMethod === 'system-installer' || input.snapshot.launchInstallNotice) return null
  const version = resolveInstallableUpdateOnQuit(input.snapshot)?.version
  if (!version || input.attempted) return null
  return version
}

export interface IdleInstallInput {
  platform: NodeJS.Platform
  unattended: boolean
  autoUpdate: boolean
  snapshot: UpdateSnapshot
  /** 电脑多久没人按键盘、动鼠标了。 */
  idleMs: number
  locked: boolean
  /** 星芒有窗口摆在屏幕上（含最小化的）。 */
  windowVisible: boolean
  /** 有工具在装（resolveInterruptibleInstallTask）。 */
  busy: boolean
  /** Claude Code 这些工具正在干活（cli-keep-awake）。 */
  toolsWorking: boolean
  accelerationActive: boolean
  /** 手机遥控开着（任一渠道）。重开星芒后遥控不会自己连回去，开着它的人又多半不在电脑前。 */
  remoteControlActive: boolean
  /** 视频在出或在取回（主进程里的请求）：重启会把它打断，已经交给服务端的片段照样扣钱。 */
  videoWorking: boolean
  /** 主窗口界面手上有事：视频剪辑在拼片、对话在出字、开着对话框（renderer-release.ts 的 rendererBusy）。 */
  rendererBusy: boolean
  /** 这个版本已经自动装过（打开时、退出时、闲时，任何一种）。 */
  attempted: boolean
  /** 跳框开着、还在等回答。 */
  promptOpen: boolean
  /** 早于这个时间不装（毫秒时间戳）；null = 不用等。 */
  notBefore: number | null
  now: number
}

/** 返回现在要闲时装的版本；不该装时返回 null。 */
export function decideIdleInstall(input: IdleInstallInput): string | null {
  if (input.platform !== 'darwin' || !input.unattended || !input.autoUpdate) return null
  if (input.snapshot.installMethod === 'system-installer') return null
  const version = resolveInstallableUpdateOnQuit(input.snapshot)?.version
  if (!version || input.attempted || input.promptOpen) return null
  if (input.notBefore !== null && input.now < input.notBefore) return null
  if (!input.locked && !(input.idleMs >= IDLE_INSTALL_IDLE_MS)) return null
  if (input.windowVisible || input.busy || input.toolsWorking || input.accelerationActive) return null
  if (input.remoteControlActive || input.videoWorking || input.rendererBusy) return null
  return version
}

/** 客户不在电脑前（锁了屏，或者很久没碰）：这时跳框没人看，能闲时装的（窗口都缩着）就不问了。 */
export function isAwayFromComputer(idleMs: number, locked: boolean): boolean {
  return locked || idleMs >= IDLE_INSTALL_IDLE_MS
}

export type InstallPromptAnswer = 'install' | 'later'

export interface UpdateInstallPrompterOptions {
  platform: NodeJS.Platform
  getState(): UpdateSnapshot
  autoUpdate(): boolean
  /** 见 InstallPromptInput.standardAccount。 */
  standardAccount(): boolean | null
  unattended(): boolean
  elevated(): boolean
  /** 电脑多久没人按键盘、动鼠标了（毫秒）。读不到时宿主返回 0：当作有人在，不装也不跳。 */
  idleMs(): number
  locked(): boolean
  windowVisible(): boolean
  busy(): boolean
  toolsWorking(): boolean
  accelerationActive(): boolean
  /** 见 IdleInstallInput.remoteControlActive。 */
  remoteControlActive(): boolean
  /** 见 IdleInstallInput.videoWorking。 */
  videoWorking(): boolean
  /** 见 IdleInstallInput.rendererBusy。 */
  rendererBusy(): boolean
  /** 付款窗口开着（含最小化）：装的时候星芒连同付款页一起关掉。 */
  paymentWindowOpen(): boolean
  attempted(version: string): boolean
  /** 跳框；signal 断开时宿主收起框，当作「稍后再说」。 */
  ask(prompt: InstallPrompt, signal: AbortSignal): Promise<InstallPromptAnswer>
  /** 客户点了「现在安装」。 */
  installNow(version: string): Promise<void>
  /**
   * 现读一次服务状态文件。撤回名单平时 15 分钟才读一次，读到这一版被撤回时更新器自己把它收回
   * （updater.ts 的 withdrawOffer），getState 就不再给这一版。
   */
  refreshServiceStatus(): Promise<unknown>
  /** 闲时装：记下「试过了」再装。 */
  installWhileIdle(version: string): Promise<void>
  log(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void
  now?(): number
  setTimer?(callback: () => void, ms: number): () => void
}

export interface UpdateInstallPrompter {
  /** 更新状态变了（宿主订阅 updaterService 后转进来）。 */
  observe(snapshot: UpdateSnapshot): void
  /** 跳框开着、还在等客户回答。 */
  prompting(): boolean
  dispose(): void
}

/** 跳框先等一等的几样手上的事，日志里记是哪一样。 */
type PromptHold = 'payment' | 'video' | 'renderer'

const promptHoldDescriptions: Record<PromptHold, string> = {
  payment: '付款窗口开着',
  video: '视频在出',
  renderer: '界面手上有事（对话在出字、拼片或开着对话框）',
}

function installableVersion(snapshot: UpdateSnapshot | null): string | null {
  return snapshot ? resolveInstallableUpdateOnQuit(snapshot)?.version ?? null : null
}

function defaultTimer(callback: () => void, ms: number): () => void {
  const timer = setTimeout(callback, ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export function createUpdateInstallPrompter(options: UpdateInstallPrompterOptions): UpdateInstallPrompter {
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? defaultTimer
  const asked = new Set<string>()
  let waiting: string | null = null
  // windowShown：跳框之前星芒就有窗口开着。宿主跳框时会把主窗口叫出来，所以要在跳之前看。
  let open: { version: string; controller: AbortController; windowShown: boolean } | null = null
  let notBefore: number | null = null
  let idleTried: string | null = null
  let heldForAcceleration: string | null = null
  // 付款、出字、出视频占着，正等它们完了再跳框的那一版（记着是哪一样，换了一样再记一行日志）。
  let heldForWork: { version: string; hold: PromptHold } | null = null
  // 人不在、窗口又开着，正等人回来再跳框的那一版。
  let heldUntilBack: string | null = null
  let cancelTimer: (() => void) | null = null
  let armedMs: number | null = null
  let disposed = false

  function log(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void {
    try { options.log(level, event, message, detail) } catch { /* 记日志失败不能挡住提示和安装。 */ }
  }

  function read<T>(probe: () => T, fallback: T): T {
    try { return probe() } catch { return fallback }
  }

  function promptVersion(snapshot: UpdateSnapshot): string | null {
    const version = installableVersion(snapshot)
    return resolveInstallPromptVersion({
      autoUpdate: read(options.autoUpdate, false),
      snapshot,
      // 每次现问：等着跳框的这几秒里，打开时装可能刚接手（客户从托盘点开了窗口）。
      attempted: !version || read(() => options.attempted(version), true),
      standardAccount: read(options.standardAccount, null),
    })
  }

  function idleVersion(snapshot: UpdateSnapshot): string | null {
    const version = installableVersion(snapshot)
    return decideIdleInstall({
      platform: options.platform,
      unattended: read(options.unattended, false),
      autoUpdate: read(options.autoUpdate, false),
      snapshot,
      idleMs: read(options.idleMs, 0),
      locked: read(options.locked, false),
      windowVisible: read(options.windowVisible, true),
      busy: read(options.busy, true),
      toolsWorking: read(options.toolsWorking, true),
      accelerationActive: read(options.accelerationActive, true),
      remoteControlActive: read(options.remoteControlActive, true),
      videoWorking: read(options.videoWorking, true),
      rendererBusy: read(options.rendererBusy, true),
      attempted: !version || version === idleTried || read(() => options.attempted(version), true),
      promptOpen: open !== null,
      notBefore,
      now: now(),
    })
  }

  // 能闲时装的电脑上要一直看着（框开着时也要看人走没走），不能的只在等着跳框时看。
  function canInstallWhileIdle(): boolean {
    return options.platform === 'darwin' && read(options.unattended, false)
  }

  // 手机遥控可能一开就是一整天，这期间闲时装等不来：跟窗口开着一样，人不在就等人回来再跳框、
  // 框也不收；框里说退出或下次打开时装。视频、界面上的活一会儿就做完，不用这样。
  function idleInstallHeldByRemote(): boolean {
    return read(options.remoteControlActive, true)
  }

  // 读不出加速开没开时当作开着：宁可这次不问，也不能把正在打的游戏切出去。
  function accelerationOn(): boolean {
    return read(options.accelerationActive, true)
  }

  // 读不出来当作在忙：宁可晚问一会儿，也不能把付款页、正在出的回答关掉。
  function promptHold(): PromptHold | null {
    if (read(options.paymentWindowOpen, true)) return 'payment'
    if (read(options.videoWorking, true)) return 'video'
    if (read(options.rendererBusy, true)) return 'renderer'
    return null
  }

  // 更新状态每变一次都会来一遍：已经排着同样间隔的就不重排，免得一直往后推。
  function schedule(): void {
    const downloaded = installableVersion(read<UpdateSnapshot | null>(options.getState, null)) !== null
    // 加速开着时一局游戏可能打几个小时、人不在可能一走一整夜，这段时间放慢着看，加速关了、人回来了
    // 再按 2 秒一次等人停手。
    const wanted = disposed
      ? null
      : waiting
        ? accelerationOn() || heldUntilBack === waiting || heldForWork?.version === waiting ? IDLE_POLL_MS : PROMPT_POLL_MS
        : downloaded && canInstallWhileIdle() && idleTried === null ? IDLE_POLL_MS : null
    if (wanted !== null && wanted === armedMs && cancelTimer) return
    cancelTimer?.()
    cancelTimer = null
    armedMs = wanted
    if (wanted !== null) cancelTimer = setTimer(tick, wanted)
  }

  function tick(): void {
    cancelTimer = null
    armedMs = null
    if (disposed) return
    const snapshot = read<UpdateSnapshot | null>(options.getState, null)
    if (!snapshot) return
    if (waiting) considerPrompt(snapshot)
    else if (open) considerAbandon()
    else considerIdleInstall(snapshot)
    schedule()
  }

  function considerPrompt(snapshot: UpdateSnapshot): void {
    const version = waiting
    if (!version) return
    if (promptVersion(snapshot) !== version) {
      waiting = null
      return
    }
    // 先于「人在不在」看：加速开着时什么都不记，关了以后再按原规矩办，人走开了的照样等闲时装。
    if (accelerationOn()) {
      if (heldForAcceleration !== version) {
        heldForAcceleration = version
        log('info', 'install.prompt.held', `网络加速开着，新版本 ${version} 先不跳框问，等加速关了再问`)
      }
      return
    }
    const idleMs = read(options.idleMs, 0)
    const locked = read(options.locked, false)
    if (canInstallWhileIdle() && isAwayFromComputer(idleMs, locked)) {
      // 窗口开着、遥控开着的闲时装等不来（要窗口都缩着、遥控关着），在这里记成问过了，这一版这次运行
      // 就既不问也不装。读不出窗口开没开时当作开着：顶多等人回来多问一句。
      const windowOpen = read(options.windowVisible, true)
      if (windowOpen || idleInstallHeldByRemote()) {
        if (heldUntilBack !== version) {
          heldUntilBack = version
          log('info', windowOpen ? 'install.prompt.away-window-open' : 'install.prompt.away-remote-on',
            `新版本 ${version} 下好时没人在电脑前，可${windowOpen ? '星芒窗口' : '手机遥控'}开着、闲时装不了，等人回来再跳框`, { locked })
        }
        return
      }
      heldUntilBack = null
      waiting = null
      asked.add(version)
      notBefore = null
      log('info', 'install.prompt.away', `新版本 ${version} 下好时没人在电脑前，不跳框，等闲时装`, { locked })
      return
    }
    heldUntilBack = null
    // 人不在的那一路不跳框，用不着在这里等：闲时装自己会等视频、界面上的活，付款窗口开着就算窗口开着。
    const hold = promptHold()
    if (hold) {
      if (heldForWork?.version !== version || heldForWork.hold !== hold) {
        log('info', 'install.prompt.held-work', `${promptHoldDescriptions[hold]}，新版本 ${version} 先不跳框问，完了再问`, { hold })
      }
      heldForWork = { version, hold }
      return
    }
    heldForWork = null
    if (!(idleMs >= PROMPT_QUIET_INPUT_MS)) return
    waiting = null
    asked.add(version)
    showPrompt(version)
  }

  function showPrompt(version: string): void {
    const controller = new AbortController()
    open = { version, controller, windowShown: read(options.windowVisible, true) }
    const prompt = buildInstallPrompt(version, options.platform, {
      unattended: canInstallWhileIdle() && !idleInstallHeldByRemote(),
      elevated: read(options.elevated, false),
    })
    log('info', 'install.prompt.shown', `新版本 ${version} 下好了，跳框问要不要现在装`)
    void Promise.resolve()
      .then(() => options.ask(prompt, controller.signal))
      .catch((cause: unknown) => {
        log('warn', 'install.prompt.failed', '跳框没弹出来，当作稍后再说', { cause: cause instanceof Error ? cause.message : String(cause) })
        return 'later' as const
      })
      .then(async (answer) => {
        if (open?.controller === controller) open = null
        if (disposed) return
        const abandoned = controller.signal.aborted
        if (answer === 'install' && !abandoned) {
          log('info', 'install.prompt.accepted', `客户点了现在安装 ${version}`)
          // 框开着的时候可能已经装上、被撤回或者又下了更新的一版：只装框里问的那一版。
          if (installableVersion(read<UpdateSnapshot | null>(options.getState, null)) !== version) return
          await options.installNow(version)
          return
        }
        // 人走开了框才被收掉的，不用再等：闲时装的条件这一刻已经满足了。
        notBefore = abandoned ? null : now() + IDLE_INSTALL_AFTER_PROMPT_MS
        log('info', abandoned ? 'install.prompt.abandoned' : 'install.prompt.later', abandoned
          ? `跳框一直没人回，收起来了，${version} 等闲时装`
          : `客户点了稍后再说，${version} 留着`)
      })
      .catch((cause: unknown) => {
        log('warn', 'install.prompt.install-failed', '点了现在安装，可是没装起来', { cause: cause instanceof Error ? cause.message : String(cause) })
      })
      .finally(() => schedule())
  }

  function considerAbandon(): void {
    if (!open || !canInstallWhileIdle() || idleInstallHeldByRemote()) return
    // 窗口本来就开着的，收了框窗口也照样开着、闲时装等不来：框留着等人回来回答。
    if (open.windowShown) return
    if (!isAwayFromComputer(read(options.idleMs, 0), read(options.locked, false))) return
    open.controller.abort()
  }

  // 读得慢、读不到都不能把闲时装一直挂着：等满了就按上次读到的撤回名单装。
  function refreshServiceStatus(): Promise<void> {
    return new Promise<void>((resolve) => {
      const cancel = setTimer(resolve, IDLE_INSTALL_STATUS_WAIT_MS)
      void Promise.resolve()
        .then(() => options.refreshServiceStatus())
        .catch(() => undefined)
        .then(() => {
          cancel()
          resolve()
        })
    })
  }

  function considerIdleInstall(snapshot: UpdateSnapshot): void {
    const version = idleVersion(snapshot)
    if (!version) return
    idleTried = version
    void refreshServiceStatus()
      .then(() => {
        if (disposed) return
        // 下载之后才被撤回的版本在这一步收回（同退出时装）。这一版没试过，下一版下好以后照样能闲时装。
        if (installableVersion(read<UpdateSnapshot | null>(options.getState, null)) !== version) {
          idleTried = null
          log('info', 'install.idle.withdrawn', `${version} 刚被撤回或换了一版，这次不闲时装`)
          schedule()
          return
        }
        log('info', 'install.idle', `电脑闲着、窗口缩着，在后台装下好的 ${version}，装好照旧缩在菜单栏`)
        return options.installWhileIdle(version)
      })
      .catch((cause: unknown) => {
        log('warn', 'install.idle.failed', '闲时装没装起来，留到退出时再装', { cause: cause instanceof Error ? cause.message : String(cause) })
      })
  }

  return {
    observe(snapshot) {
      if (disposed) return
      const version = promptVersion(snapshot)
      if (version && !asked.has(version) && open === null) waiting = version
      else if (waiting && waiting !== version) waiting = null
      schedule()
    },
    prompting() {
      return open !== null
    },
    dispose() {
      if (disposed) return
      disposed = true
      cancelTimer?.()
      cancelTimer = null
      armedMs = null
      waiting = null
      open?.controller.abort()
      open = null
    },
  }
}
