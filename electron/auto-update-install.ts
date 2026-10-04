/**
 * 「自动更新」开着时，已经下载好的新版本什么时候装。
 *
 * 规矩是不在用户正用着的时候把软件关掉重开，所以只有两个时机：
 * - **用户自己退出时**：直接装，不再弹「顺手装上吗」那一问（main.ts 的 confirmQuit）。
 *   系统关机、重启、注销不算：安装器会被一起结束，留给下次打开。
 * - **下次打开软件时**：上一次运行就已经下好了，这次启动刚打开、用户还没开始用，装上。
 *   常驻托盘、从不真正退出的人只能靠这一条拿到新版本。
 *
 * 第二条最怕的是死循环：安装器每次都起不来，软件就会每次一打开就关掉。所以每个版本
 * 在启动时只试一次，先记下「试过了」再去装；没装成的版本退回到「退出时装」和更新页
 * 的按钮。判断「上一次运行就下好了」要靠落盘的记录：electron-updater 启动时命中本地
 * 缓存和现场下载，对外发出的事件是一样的。
 *
 * 退出时装同样每个版本只自动试一次：授权窗被点了「否」、安装器没起来时，软件已经
 * 退出了，这次失败只能等下次打开时从记录里认出来（见 resolvePreviousAutoInstallFailure）。
 * 认出来之后这个版本不再自动装，只在提示气泡和更新页留「重新安装」，别让授权窗一直弹。
 *
 * 记录读坏了一律当作没有记录：最多少装一次，绝不会多装。
 */
import path from 'node:path'
import { ensureSafeDataDirectory, readSafeUtf8FileSync, writeAtomicSafeUtf8File } from './safe-local-data'
import { resolveInstallableUpdateOnQuit } from './quit-blocking-tasks'
import type { UpdateInstallMethod, UpdateSnapshot } from './updater'

const storeLabel = '自动更新记录'
const MAX_STORE_BYTES = 4 * 1024
const VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?$/

/**
 * 启动后多久之内下好的才算「打开时装」。本地缓存命中加上 SHA-512 复核通常几秒就完；
 * 超过这个时间才下好，说明是这次现场下载的，用户多半已经在用了，留到退出时再装。
 */
export const LAUNCH_INSTALL_WINDOW_MS = 2 * 60 * 1_000

/** 启动时自动装之前，预告通知摆出来之后等多久再关窗去装。 */
export const LAUNCH_INSTALL_NOTICE_MS = 5_000
/** 退出时自动装之前，给系统把预告通知摆出来的时间。 */
export const QUIT_INSTALL_NOTICE_MS = 1_200

export interface PendingUpdateRecord {
  /** 上一次（或更早）运行时已经下载并校验好的版本。 */
  downloadedVersion: string | null
  /** 已经在启动时试着装过的版本；同一个版本不再在启动时试第二次。 */
  attemptedVersion: string | null
  /** 已经在退出时自动装过的版本。可选＝旧记录，当作没试过。 */
  quitAttemptedVersion?: string | null
}

export const emptyPendingUpdateRecord: PendingUpdateRecord = { downloadedVersion: null, attemptedVersion: null, quitAttemptedVersion: null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseVersion(value: unknown): string | null {
  return typeof value === 'string' && VERSION_PATTERN.test(value) ? value : null
}

export function parsePendingUpdateRecord(content: string): PendingUpdateRecord {
  try {
    const value: unknown = JSON.parse(content)
    if (!isRecord(value) || value.version !== 1) return { ...emptyPendingUpdateRecord }
    return {
      downloadedVersion: parseVersion(value.downloadedVersion),
      attemptedVersion: parseVersion(value.attemptedVersion),
      quitAttemptedVersion: parseVersion(value.quitAttemptedVersion),
    }
  } catch {
    return { ...emptyPendingUpdateRecord }
  }
}

/** 这次快照是一个刚下好、需要记下来的版本时返回它，否则返回 null。 */
export function resolveDownloadedVersionToRecord(snapshot: UpdateSnapshot, record: PendingUpdateRecord): string | null {
  const installable = resolveInstallableUpdateOnQuit(snapshot)
  const version = parseVersion(installable?.version)
  return version && version !== record.downloadedVersion ? version : null
}

export interface LaunchInstallInput {
  autoUpdate: boolean
  snapshot: UpdateSnapshot
  /** 本次启动时读到的记录，不是运行中改写过的那份。 */
  recordAtLaunch: PendingUpdateRecord
  elapsedSinceLaunchMs: number
  /** 有安装任务在跑（装 CLI、装 Node 之类）时不打断。 */
  busy: boolean
}

/** 返回要在启动时装上的版本；不该装时返回 null。 */
export function decideLaunchInstall(input: LaunchInstallInput): string | null {
  if (!input.autoUpdate || input.busy) return null
  // 交给系统安装器的版本（Linux）从不自己装：一打开（常常是开机自启）就弹一个要开机密码
  // 的窗口，客户只会当成来路不明的东西点掉。
  if (input.snapshot.installMethod === 'system-installer') return null
  if (!(input.elapsedSinceLaunchMs >= 0 && input.elapsedSinceLaunchMs <= LAUNCH_INSTALL_WINDOW_MS)) return null
  const version = parseVersion(resolveInstallableUpdateOnQuit(input.snapshot)?.version)
  if (!version) return null
  if (input.recordAtLaunch.downloadedVersion !== version) return null
  if (input.recordAtLaunch.attemptedVersion === version) return null
  if (input.recordAtLaunch.quitAttemptedVersion === version) return null
  return version
}

export interface QuitInstallInput {
  autoUpdate: boolean
  version: string | null
  record: PendingUpdateRecord
  /** 缺省＝安装器接手退出（Windows、Mac）。 */
  installMethod?: UpdateInstallMethod | null
  /** 系统已经在关机、重启或注销。缺省＝没有。 */
  systemShuttingDown?: boolean
}

/**
 * 退出时有下好的更新：自动更新开着、这个版本还没在退出时自动试过，就直接装；否则
 * 回到「顺手装上吗」那一问，由用户决定。交给系统安装器的版本（Linux）每次都问：装的时候
 * 要他在系统窗口里点「安装」、输开机密码，没问过就弹出来只会被当成可疑窗口关掉。
 *
 * 系统在关机、重启或注销时这次不装也不问（'later'）：安装器会被关机一起结束，问了也没人
 * 回答。也不记「退出时试过了」，记了下次打开就会被当成上次没装上；不记，下次打开照常
 * 自动装（decideLaunchInstall）。
 */
export function decideQuitInstall(input: QuitInstallInput): 'install' | 'ask' | 'later' {
  if (input.systemShuttingDown) return 'later'
  const version = parseVersion(input.version)
  if (!input.autoUpdate || !version || input.installMethod === 'system-installer') return 'ask'
  return input.record.quitAttemptedVersion === version ? 'ask' : 'install'
}

/** 这次退出时自动装写下的「试过了」，连同写之前记录里的值，撤回时要用。 */
export interface QuitInstallAttempt {
  version: string
  previous: string | null
}

/**
 * 退出时自动装已经记下「试过了」，可系统关机抢在安装器装完之前（Mac 的安装器在本进程里
 * 准备，会被一起结束）：撤回那条记录，下次打开照常自动装，不说「上次没装上」。记录已经
 * 不是这次写的样子时不动，返回 null。
 */
export function undoQuitInstallAttempt(record: PendingUpdateRecord, attempt: QuitInstallAttempt | null): PendingUpdateRecord | null {
  if (!attempt || record.quitAttemptedVersion !== attempt.version) return null
  return { ...record, quitAttemptedVersion: attempt.previous }
}

/**
 * 上次运行时自动装过、这次打开还是旧版本、同一个版本又摆在那儿等着装：说明上次没装上
 * （授权窗被点了「否」、安装器没起来）。返回那个版本；不是这种情况返回 null。
 */
export function resolvePreviousAutoInstallFailure(version: string, currentVersion: string, recordAtLaunch: PendingUpdateRecord): string | null {
  const parsed = parseVersion(version)
  if (!parsed || parsed === currentVersion) return null
  return recordAtLaunch.attemptedVersion === parsed || recordAtLaunch.quitAttemptedVersion === parsed ? parsed : null
}

export type AutoInstallMoment = 'quit' | 'launch'

export interface AutoInstallNotice {
  title: string
  body: string
}

/**
 * 自动装之前的那句预告。Windows 的安装包装在「所有用户」目录下，装的时候会弹系统授权
 * 窗口；事先不说一声，用户看到的就是软件自己关了、又凭空冒出一个窗口问要不要允许。
 */
export function buildAutoInstallNotice(version: string, moment: AutoInstallMoment, platform: NodeJS.Platform): AutoInstallNotice {
  const consent = platform === 'win32' ? 'Windows 弹出授权窗口时请点「是」。' : ''
  if (moment === 'quit') {
    return {
      title: '正在安装星芒AI新版本',
      body: `正在装新版 ${version}，装好会自动打开。${consent}`,
    }
  }
  return {
    title: '星芒AI马上更新',
    body: `上次下好的新版 ${version} 几秒后开始安装，软件会先关掉，装好自动打开。${consent}`,
  }
}

export interface QuitInstallPrompt {
  message: string
  detail: string
  /** [装, 不装]，顺序与退出确认框的按钮一致。 */
  buttons: [string, string]
}

/**
 * 退出时「顺手装上吗」那一问。交给系统安装器的版本（Linux）装完不会自己打开，还要在
 * 系统窗口里输一次开机密码，事先说清楚，免得客户以为软件闪退、被病毒弹窗。
 */
export function quitInstallPrompt(version: string | null, installMethod: UpdateInstallMethod | null | undefined): QuitInstallPrompt {
  if (installMethod === 'system-installer') {
    return {
      message: version ? `新版本 ${version} 已经下载好，现在装上吗？` : '新版本已经下载好，现在装上吗？',
      detail: '星芒会先关掉，再打开这台电脑的安装窗口：在里面点「安装」，输入开机密码就行。装好后从应用菜单重新打开星芒。现在不装也行，下次退出时再问你。',
      buttons: ['关掉并安装', '先退出，下次再装'],
    }
  }
  return {
    message: version ? `新版本 ${version} 已经下载好，顺手装上吗？` : '新版本已经下载好，顺手装上吗？',
    detail: '安装很快，装完会自动打开新版本。现在不装也行，更新会一直留着，下次退出时再问你。',
    buttons: ['安装并退出', '先退出，下次再装'],
  }
}

/** 上次自动装没装上时，提示气泡和更新页上的那句话。 */
export function previousAutoInstallFailureMessage(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? '新版本上次没装上：Windows 的授权窗口被关掉了，或者安装程序没起来。点「重新安装」再试一次，授权窗口弹出来时点「是」。'
    : '新版本上次没装上，安装程序没起来。点「重新安装」再试一次。'
}

export interface PendingUpdateStore {
  read(): PendingUpdateRecord
  write(record: PendingUpdateRecord): Promise<void>
}

export function createPendingUpdateStore(options: { filePath: string }): PendingUpdateStore {
  if (!path.isAbsolute(options.filePath)) throw new Error('自动更新记录必须使用绝对路径。')
  return {
    read() {
      try {
        const content = readSafeUtf8FileSync(options.filePath, storeLabel, MAX_STORE_BYTES)
        return content === null ? { ...emptyPendingUpdateRecord } : parsePendingUpdateRecord(content)
      } catch {
        return { ...emptyPendingUpdateRecord }
      }
    },
    async write(record) {
      ensureSafeDataDirectory(path.dirname(options.filePath), storeLabel)
      const value = {
        version: 1,
        downloadedVersion: parseVersion(record.downloadedVersion),
        attemptedVersion: parseVersion(record.attemptedVersion),
        quitAttemptedVersion: parseVersion(record.quitAttemptedVersion),
      }
      await writeAtomicSafeUtf8File(options.filePath, `${JSON.stringify(value)}\n`, storeLabel)
    },
  }
}
