import fs from 'node:fs'
import path from 'node:path'
import type { App } from 'electron'
import type { AppUninstallLeftover, AppUninstallRequest, AppUninstallResult } from './ipc-contract'
import { inspectMacosInstallLocation } from './macos-install-location'
import { managedProductRoot } from './managed-cli-paths'

// Mac 上删软件就是把 .app 拖进废纸篓，没有卸载程序替我们收尾。四家工具配置里的钩子、
// 状态行还指着 .app 里的脚本，文件没了以后每一轮都在终端里报红；Windows 由卸载程序
// 顺手收回（uninstall-cleanup.ts），这里补上 Mac 那一半：设置里点「卸载星芒」，先收回
// 这些，再把自己移到废纸篓并退出。Key 和工具设置照 Windows 的口径留着，卸了星芒工具照样能用。

export interface MacUninstallDependencies {
  platform: NodeJS.Platform
  packaged: boolean
  /** `app.getAppPath()`：和 macos-install-location 一样，两条路径都看。 */
  appPath: string
  /** `process.execPath`。 */
  executablePath: string
  /** 安装队列里有活就不卸（I11）：原子替换做到一半被删掉目录，比不卸更糟。 */
  installationBusy(): boolean
  /** 改之前按「保存配置」同一份备份，「备份」页里能找回。 */
  backupCliConfigs(): Promise<void>
  removeCliHooks(): boolean
  removeLoginItem(): boolean
  removeManagedTools(): Promise<boolean>
  trashItem(target: string): Promise<void>
  /** 断开加速、还原系统代理、聊天记录写完盘。清登录记录前必须先跑完，否则会被写回来。 */
  prepareQuit(): Promise<void>
  /** 移不进废纸篓时撤回 prepareQuit 置下的「正在退出」，窗口照常能关、能缩到菜单栏。 */
  abortQuit(): void
  /** 删掉自动更新下好的安装包（~/Library/Caches 下的更新缓存）。 */
  removeUpdaterCache(): Promise<boolean>
  clearLoginRecords(): Promise<boolean>
  quit(): void
  report?(line: string): void
}

/**
 * `/Applications/<名字>.app/Contents/MacOS/<名字>` → `/Applications/<名字>.app`。
 * 形状对不上就是 null：宁可不删，也不能把别的目录移进废纸篓。
 */
export function resolveMacAppBundlePath(executablePath: string): string | null {
  if (typeof executablePath !== 'string' || !path.posix.isAbsolute(executablePath)) return null
  const macOSDirectory = path.posix.dirname(path.posix.normalize(executablePath))
  const contents = path.posix.dirname(macOSDirectory)
  const bundle = path.posix.dirname(contents)
  if (path.posix.basename(macOSDirectory) !== 'MacOS' || path.posix.basename(contents) !== 'Contents') return null
  if (!bundle.endsWith('.app') || path.posix.basename(bundle) === '.app') return null
  return bundle
}

// 从磁盘映像或系统的只读临时副本里跑的，trashItem 删不到真正那一份。
function trashableBundle(dependencies: MacUninstallDependencies): string | null {
  const location = inspectMacosInstallLocation({
    platform: dependencies.platform,
    packaged: dependencies.packaged,
    appPath: dependencies.appPath,
    executablePath: dependencies.executablePath,
  })
  if (location) return null
  return resolveMacAppBundlePath(dependencies.executablePath)
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : '未知错误'
}

function report(dependencies: MacUninstallDependencies, line: string): void {
  try { dependencies.report?.(line) } catch { /* Reporting must not change the result. */ }
}

async function attempt(
  dependencies: MacUninstallDependencies,
  label: string,
  step: () => boolean | Promise<boolean>,
): Promise<boolean> {
  try {
    return await step()
  } catch (error) {
    report(dependencies, `${label}: ${describeFailure(error)}`)
    return false
  }
}

export async function runMacUninstall(
  dependencies: MacUninstallDependencies,
  request: AppUninstallRequest,
): Promise<AppUninstallResult> {
  if (dependencies.platform !== 'darwin') throw new Error('这台电脑上请用系统自带的方式卸载星芒')
  // 开发时的 execPath 是 node_modules 里的 Electron.app，移进废纸篓的就是它。
  if (!dependencies.packaged) throw new Error('开发模式不能在这里卸载')
  if (dependencies.installationBusy()) throw new Error('还有安装、卸载或打开工具的任务在进行，等它做完再卸载')
  const leftovers: AppUninstallLeftover[] = []
  try {
    await dependencies.backupCliConfigs()
  } catch (error) {
    // 备份失败不拦卸载：收回的只是星芒自己写进去的几行，删除本身也走两阶段提交。
    report(dependencies, `backup: ${describeFailure(error)}`)
  }
  if (!await attempt(dependencies, 'cli hooks', () => dependencies.removeCliHooks())) leftovers.push('cli-hooks')
  if (!await attempt(dependencies, 'login item', () => dependencies.removeLoginItem())) leftovers.push('login-item')
  if (request.removeManagedTools && !await attempt(dependencies, 'managed tools', () => dependencies.removeManagedTools())) {
    leftovers.push('tools')
  }
  const bundle = trashableBundle(dependencies)
  // 程序还在，人也还要看提示：不退出，登录记录也不清（还开着的窗口会把它写回来）。
  const stayOpen = (): AppUninstallResult => ({
    trashed: false,
    leftovers: request.clearLoginRecords ? [...leftovers, 'records'] : leftovers,
  })
  if (!bundle) return stayOpen()
  // 先断开加速、还原系统代理再挪程序：还原要用的东西可能按安装位置找，挪走以后就找不到了。
  try {
    await dependencies.prepareQuit()
  } catch (error) {
    report(dependencies, `prepare quit: ${describeFailure(error)}`)
  }
  try {
    await dependencies.trashItem(bundle)
  } catch (error) {
    report(dependencies, `trash: ${describeFailure(error)}`)
    dependencies.abortQuit()
    return stayOpen()
  }
  // 程序确实挪走了才删：挪不动时人还要用它，下好的新版留着照样能装。没删掉只记日志，
  // 不算进 leftovers——那只占地方，不值得在提示里多说一句。
  await attempt(dependencies, 'update cache', () => dependencies.removeUpdaterCache())
  if (request.clearLoginRecords && !await attempt(dependencies, 'login records', () => dependencies.clearLoginRecords())) {
    leftovers.push('records')
  }
  dependencies.quit()
  return { trashed: true, leftovers }
}

export function removeMacLoginItem(app: Pick<App, 'setLoginItemSettings' | 'getLoginItemSettings'>): boolean {
  app.setLoginItemSettings({ openAtLogin: false })
  return !app.getLoginItemSettings().openAtLogin
}

/**
 * 「连同星芒替你装的命令行工具一起删」：Mac 上星芒装的 CLI、Node 和 Grok 全在
 * ~/Library/Application Support/XingMangAI 下（managed-cli-paths.ts），客户自己装的不在这里，
 * 一个都不碰。根目录被换成链接时拒绝，不跟过去删（I8）；里面 npm 的 bin 链接由 rm
 * 按链接本身删掉，不跟随。
 */
export async function removeMacManagedTools(
  root: string = managedProductRoot(process.env, 'darwin'),
  report?: (line: string) => void,
): Promise<boolean> {
  let stats: fs.Stats
  try {
    stats = await fs.promises.lstat(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return true
    throw error
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    try { report?.('managed tools: root is not a plain directory; left in place') } catch { /* Reporting must not change the result. */ }
    return false
  }
  await fs.promises.rm(root, { recursive: true, force: true })
  try {
    await fs.promises.lstat(root)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
  }
}
