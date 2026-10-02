/**
 * Linux 上星芒自己怎么更新：只有用 .deb 装的才自动更新，而且「装」这一步交给这台电脑
 * 自己的安装程序（Ubuntu 的应用中心、统信/deepin 的软件包安装器、麒麟安装器…）。
 *
 * 为什么不用 electron-updater 自带的 DebUpdater（摸底明细 U4）：它用 shell 拼一条
 * `pkexec /bin/bash -c 'dpkg -i …'`，pkexec/sudo 是从 PATH 里找的，dpkg 失败还会以 root
 * 跑 `apt-get install -f -y`；同步执行，授权窗口弹着的时候整个界面卡住。系统安装程序
 * 自己弹窗确认、自己问开机密码，权限边界留在系统手里，星芒从头到尾不提权。
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import fs from 'node:fs'
// Linux-only paths: spelled with posix semantics so the tests mean the same on
// the Windows CI shards that also run them.
import { posix as path } from 'node:path'
import { readBoundedUtf8FileSync } from './bounded-file'
import type { UpdateInstallMethod } from './updater'

/**
 * electron-builder 的 deb 目标往 resources 里写这个文件，内容是 `deb`；electron-updater
 * 也靠它决定用哪种更新器（node_modules/electron-updater/out/main.js）。
 */
const packageTypeFileName = 'package-type'
const packageTypeMaxBytes = 64

/**
 * 读安装包留下的「装法」标记。读不到（不是 deb 装的、解包直接运行的）返回 null。
 * resources 目录在 /opt 下、归 root，这里仍按有界读取走，不信任它的大小和类型。
 */
export function readLinuxPackageType(
  resourcesPath: string,
  read: typeof readBoundedUtf8FileSync = readBoundedUtf8FileSync,
): string | null {
  try {
    const value = read(path.join(resourcesPath, packageTypeFileName), packageTypeMaxBytes, '安装方式标记').trim()
    return value || null
  } catch {
    return null
  }
}

/**
 * 这台 Linux 电脑上的星芒能怎么更新。只发 .deb（Linux 版已定的默认），所以只有 deb 能
 * 自动更新；AppImage、解包运行、tar.gz 都请客户去下载页。开发运行（没打包）一律按
 * 'system-installer' 说，方便看界面；开发态本来就不许安装。
 */
export function resolveLinuxInstallMethod(input: { isPackaged: boolean; packageType: string | null }): UpdateInstallMethod {
  if (!input.isPackaged) return 'system-installer'
  return input.packageType === 'deb' ? 'system-installer' : 'manual'
}

// xdg-utils is a dependency of every deb electron-builder produces, so the
// opener exists wherever a deb install does. It is looked up at fixed absolute
// paths, never on PATH: the package it opens is about to be installed as root.
const systemOpenerCandidates = ['/usr/bin/xdg-open', '/bin/xdg-open'] as const

interface OpenerStats {
  isFile(): boolean
  isDirectory(): boolean
  uid: number
  mode: number
}

export interface OpenerFileSystem {
  realpathSync(target: string): string
  statSync(target: string): OpenerStats
}

const nativeOpenerFileSystem: OpenerFileSystem = {
  realpathSync: (target) => fs.realpathSync.native(target),
  statSync: (target) => fs.statSync(target),
}

function isRootControlled(stats: OpenerStats): boolean {
  // Group- or world-writable means someone other than root can rewrite it.
  return stats.uid === 0 && (stats.mode & 0o022) === 0
}

/**
 * 找到系统的「用默认程序打开」：解析到的文件和它所在的目录都必须归 root、别人改不了，
 * 否则不用。找不到返回 null。
 */
export function resolveSystemPackageOpener(fileSystem: OpenerFileSystem = nativeOpenerFileSystem): string | null {
  for (const candidate of systemOpenerCandidates) {
    try {
      const resolved = fileSystem.realpathSync(candidate)
      if (!path.isAbsolute(resolved)) continue
      const file = fileSystem.statSync(resolved)
      const directory = fileSystem.statSync(path.dirname(resolved))
      if (!file.isFile() || !directory.isDirectory()) continue
      if (!isRootControlled(file) || !isRootControlled(directory)) continue
      return resolved
    } catch {
      continue
    }
  }
  return null
}

// The opener is a same-user GUI launch, so the session's display, D-Bus and XDG
// variables have to survive. What must not survive is anything that would turn
// a child Electron or Node process into something else: the default .deb
// handler on some desktops is itself an Electron or Node based app.
const strippedEnvironmentKeys = new Set(['NODE_OPTIONS', 'NODE_PATH'])

export function systemInstallerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (strippedEnvironmentKeys.has(key) || key.startsWith('ELECTRON_')) continue
    result[key] = value
  }
  return result
}

/** 交给安装程序失败时带出去的错误：code 进日志，message 直接上屏。 */
export interface SystemInstallerError extends Error {
  code: 'UPDATE_PACKAGE_PATH_MISSING' | 'UPDATE_SYSTEM_INSTALLER_MISSING' | 'UPDATE_SYSTEM_INSTALLER_FAILED'
}

function installerError(code: SystemInstallerError['code'], message: string): SystemInstallerError {
  return Object.assign(new Error(message), { code })
}

const packageMissingMessage = '下载好的安装包找不到了，可能被清理软件删掉了。点「重新下载」再试一次。'

/**
 * 没交出去时给客户的那句话。`revealed`＝已经替他打开了安装包所在的文件夹，这时给出
 * 一条自己就能走通的路：双击安装包。
 */
export function systemInstallerFailureMessage(code: SystemInstallerError['code'], revealed: boolean): string {
  if (code === 'UPDATE_PACKAGE_PATH_MISSING') return packageMissingMessage
  const reason = code === 'UPDATE_SYSTEM_INSTALLER_MISSING'
    ? '这台电脑上没找到能装 .deb 安装包的程序。'
    : '没能打开这台电脑的安装程序。'
  return revealed
    ? `${reason}已经替你打开了安装包所在的文件夹，双击里面的安装包就能装；还不行请找客服。`
    : `${reason}点「重新安装」再试一次；还不行请找客服。`
}

/**
 * xdg-open 的退出码（xdg-utils 手册）：2＝文件不存在，3＝缺少需要的工具，4＝打开失败，
 * 1＝参数不对。0 由调用方当成功处理；被信号打断时 code 为 null，按打开失败算。
 */
export function systemInstallerExitError(code: number | null): SystemInstallerError {
  if (code === 2) return installerError('UPDATE_PACKAGE_PATH_MISSING', packageMissingMessage)
  if (code === 3) return installerError('UPDATE_SYSTEM_INSTALLER_MISSING', systemInstallerFailureMessage('UPDATE_SYSTEM_INSTALLER_MISSING', false))
  return installerError('UPDATE_SYSTEM_INSTALLER_FAILED', systemInstallerFailureMessage('UPDATE_SYSTEM_INSTALLER_FAILED', false))
}

/** 安装包在交出去之前还得是那个普通文件：不是链接、只有一个硬链接、确实是 .deb。 */
function assertHandoffPackage(packagePath: string, lstat: (target: string) => fs.Stats): void {
  if (!path.isAbsolute(packagePath) || packagePath.includes('\0') || path.extname(packagePath).toLowerCase() !== '.deb') {
    throw installerError('UPDATE_SYSTEM_INSTALLER_FAILED', systemInstallerFailureMessage('UPDATE_SYSTEM_INSTALLER_FAILED', false))
  }
  let stats: fs.Stats
  try {
    stats = lstat(packagePath)
  } catch {
    throw installerError('UPDATE_PACKAGE_PATH_MISSING', packageMissingMessage)
  }
  if (!stats.isFile() || stats.nlink !== 1) throw installerError('UPDATE_PACKAGE_PATH_MISSING', packageMissingMessage)
}

/**
 * 等多久还没退出就当安装程序已经起来了。GNOME、KDE、deepin 上 xdg-open 把文件交给桌面
 * 就退出（0）；没认出桌面环境时它直接前台运行安装程序，要等装完才退出。
 */
export const systemInstallerSettleMs = 3_000

export interface OpenWithSystemInstallerOptions {
  packagePath: string
  opener: string | null
  env: NodeJS.ProcessEnv
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
  lstat?: (target: string) => fs.Stats
  settleMs?: number
}

/**
 * 用系统默认程序打开安装包。安装程序在这个函数返回之前就已经拉起（同步 spawn）：退出
 * 确认里选了「安装并退出」时，软件紧接着就退了，等不到任何 await。返回的 Promise 在
 * 安装程序看起来起来了时 resolve，早早失败退出时 reject（SystemInstallerError）。
 */
export function openWithSystemInstaller(options: OpenWithSystemInstallerOptions): Promise<void> {
  try {
    assertHandoffPackage(options.packagePath, options.lstat ?? fs.lstatSync)
  } catch (error) {
    return Promise.reject(error)
  }
  if (!options.opener) {
    return Promise.reject(installerError('UPDATE_SYSTEM_INSTALLER_MISSING', systemInstallerFailureMessage('UPDATE_SYSTEM_INSTALLER_MISSING', false)))
  }
  const spawn = options.spawn ?? nodeSpawn
  let child: ChildProcess
  try {
    // argv only, no shell: the path goes to the opener as one argument (I1). It
    // is absolute, so xdg-open never mistakes it for an option or a URL.
    child = spawn(options.opener, [options.packagePath], {
      detached: true,
      stdio: 'ignore',
      env: options.env,
      shell: false,
    })
  } catch {
    return Promise.reject(installerError('UPDATE_SYSTEM_INSTALLER_MISSING', systemInstallerFailureMessage('UPDATE_SYSTEM_INSTALLER_MISSING', false)))
  }
  const settleMs = options.settleMs ?? systemInstallerSettleMs
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => finish(null), settleMs)
    timer.unref?.()
    function finish(error: SystemInstallerError | null): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // A late spawn error must not become an uncaught exception, and the
      // opener has to outlive this process once the app quits for the install.
      child.on('error', () => undefined)
      child.unref()
      if (error) reject(error)
      else resolve()
    }
    child.once('error', () => finish(installerError('UPDATE_SYSTEM_INSTALLER_MISSING', systemInstallerFailureMessage('UPDATE_SYSTEM_INSTALLER_MISSING', false))))
    child.once('exit', (code) => finish(code === 0 ? null : systemInstallerExitError(code)))
  })
}
