import path from 'node:path'

/**
 * A packaged build started from the disk image it shipped in looks perfectly
 * healthy: the window opens, the account signs in, nothing crashes. What does
 * not work is everything that needs a writable, stable home on the machine --
 * acceleration above all, whose core is launched from inside the bundle and is
 * killed by Gatekeeper the moment the volume is ejected or the randomized
 * read-only copy behind App Translocation is discarded. The user sees only
 * "acceleration cannot connect" and concludes the product is broken, which is
 * exactly what happened on a customer Mac on 2026-09-20.
 *
 * Path inspection is the whole detection: both answers macOS gives here are
 * positional, so the decision is a pure function of the two paths the main
 * process already knows and can be tested without a mounted volume.
 */
export type MacosInstallLocation = 'mounted-volume' | 'translocated'

export interface MacosInstallLocationInput {
  platform: NodeJS.Platform
  /** `app.isPackaged`. A development run lives in the checkout, never in either place. */
  packaged: boolean
  /** `app.getAppPath()`. */
  appPath: string
  /** `process.execPath`. */
  executablePath: string
}

export interface MacosInstallLocationNotice {
  title: string
  message: string
  detail: string
  buttons: readonly string[]
  defaultId: number
  cancelId: number
}

const translocationDirectoryName = 'AppTranslocation'
const volumesDirectoryName = 'Volumes'
const applicationBundleSuffix = '.app'

function pathSegments(value: string): readonly string[] {
  if (typeof value !== 'string' || value.length === 0) return []
  const normalized = path.posix.normalize(value)
  if (!normalized.startsWith('/')) return []
  return normalized.split('/').filter((segment) => segment.length > 0)
}

function classifyPath(value: string): MacosInstallLocation | null {
  const segments = pathSegments(value)
  if (segments.length === 0) return null
  // Gatekeeper 的随机只读副本：/private/var/folders/<…>/AppTranslocation/<UUID>/d/<应用>.app
  if (segments.includes(translocationDirectoryName)) return 'translocated'
  if (segments[0] !== volumesDirectoryName) return null
  const bundleIndex = segments.findIndex((segment) => segment.endsWith(applicationBundleSuffix))
  // 装在移动硬盘上的应用同样挂在 /Volumes 下，那是用户自己选的安装位置，不该拦。
  // 磁盘映像的区别在于版式固定：.app 就躺在卷根上，与「应用程序」替身并排。
  // 所以只有 /Volumes/<卷名>/<应用>.app 这一层才判成从映像里运行。
  if (bundleIndex >= 0 && bundleIndex !== 2) return null
  return 'mounted-volume'
}

/**
 * Returns the location that needs a warning, or null when the app is running
 * from somewhere it can actually work. Both paths are consulted because a
 * translocated launch rewrites `process.execPath` while the asar path may or
 * may not follow, depending on how the bundle was opened.
 */
export function inspectMacosInstallLocation(
  input: MacosInstallLocationInput,
): MacosInstallLocation | null {
  if (input.platform !== 'darwin') return null
  if (!input.packaged) return null
  return classifyPath(input.appPath) ?? classifyPath(input.executablePath)
}

export function buildMacosInstallLocationNotice(
  location: MacosInstallLocation,
): MacosInstallLocationNotice {
  const detail = location === 'mounted-volume'
    ? '从磁盘映像里直接打开时，程序没有固定的安装位置，加速、自动更新等功能无法正常工作。'
      + '\n\n请点「退出」，把「星芒AI管理工具」拖到「应用程序」文件夹，再从「应用程序」里启动。'
    : '首次打开时系统会把未放进「应用程序」的程序复制到一个只读的临时位置运行，'
      + '加速、自动更新等功能在那里无法正常工作。'
      + '\n\n请点「退出」，把「星芒AI管理工具」拖到「应用程序」文件夹，再从「应用程序」里启动。'
  return {
    title: '请先把程序放进「应用程序」',
    message: location === 'mounted-volume'
      ? '星芒AI管理工具正在从磁盘映像里运行'
      : '星芒AI管理工具正在从系统的临时副本里运行',
    detail,
    buttons: ['退出', '仍要继续'],
    defaultId: 0,
    cancelId: 0,
  }
}
