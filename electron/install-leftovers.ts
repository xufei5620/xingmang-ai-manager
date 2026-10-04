import fs from 'node:fs'
import path from 'node:path'

/**
 * 装工具时下载的包、npm 的临时缓存和解出来的安装包都放在每次安装自己的临时目录里，
 * 装完（成功或失败）在 finally 里删掉。删不掉的只有两种：安装中途星芒被关掉、电脑
 * 断电或重启，finally 根本没跑；或者删的那一刻文件被杀毒软件扫着，rm 失败被吞掉。
 * 这些目录没人认领，一个就是几十到几百 MB，低配电脑的 C 盘就这样越用越小。
 *
 * 这里只认星芒自己建的临时目录：名字前缀逐个列出（和 mkdtemp 的调用处一一对应），
 * 后面必须正好是 mkdtemp 生成的 6 位随机串。客户自己的文件、npm 自己的默认缓存、
 * 已经装好的工具目录一概不碰——「退回更新前的版本」本来就是重新下载，不靠这些。
 */

/** mkdtemp 在前缀后面追加的 6 位随机串。 */
const mkdtempSuffixPattern = /^[A-Za-z0-9]{6}$/

/** 普通权限运行时各安装流程在系统临时目录里建的目录前缀。 */
export const userTemporaryLeftoverPrefixes: readonly string[] = [
  'xingmang-npm-transaction-',
  'xingmang-grok-binary-',
  'xingmang-codex-desktop-',
  'xingmang-claude-desktop-',
  'xingmang-node-runtime-',
  'xingmang-git-runtime-',
  'xingmang-python-runtime-',
  'xingmang-workbuddy-',
]

/** createTrustedTemporaryDirectory 在安装缓存根目录下建的目录前缀。 */
export const trustedCacheLeftoverPrefixes: readonly string[] = [
  'npm-transaction-',
  'grok-binary-',
  'codex-desktop-',
  'claude-desktop-',
  'node-runtime-',
  'git-runtime-',
  'python-runtime-',
  'workbuddy-',
]

/**
 * 装进托管目录的工具（Mac、Linux，以及按管理员身份运行的 Windows）每次装或更新，都在托管 npm
 * 缓存目录（managedNpmCacheRoot）里建一个这样的事务目录，下到一半就退出时留下的也在这里。
 */
export const managedNpmTransactionLeftoverPrefixes: readonly string[] = ['npm-transaction-']

/**
 * 托管 npm 事务里带着这两个名字的，再旧也不删，留给下次装工具开头的恢复（managed-cli.ts）：
 * previous-prefix 是新版检查通过之前就断掉时要退回的旧版，换目录换到一半时它是唯一的一份；
 * interrupted-prefix 是恢复失败时留下的，可能是唯一的一份新版。新版检查通过后 previous-prefix
 * 已改名成 superseded-prefix，那样的事务和下到一半的一样，过了 6 小时就删。
 */
export const managedNpmTransactionPreservedEntries: readonly string[] = ['previous-prefix', 'interrupted-prefix']

/**
 * 最近改动过的目录一律不动。清理本身排在安装队列里，不会和星芒的安装撞上；这段
 * 时间留给队列之外的情况（例如另一个星芒进程刚好在装），远长于任何一次安装。
 */
export const installLeftoverMinimumAgeMs = 6 * 60 * 60 * 1000

/** 启动后（开机安静期结束后）再等这么久才清，让开机那一阵的检测先跑完。 */
export const installLeftoverStartupDelayMs = 2 * 60 * 1000

/** 量大小只为写日志，遇到异常巨大的目录树就不再往下数，免得清理本身拖慢电脑。 */
const maximumMeasuredEntries = 200_000

export interface InstallLeftoverLocation {
  directory: string
  prefixes: readonly string[]
  /** 候选目录里有这些名字之一（不论是文件、目录还是链接）就整个留着。 */
  preserveIfContains?: readonly string[]
}

export interface InstallLeftoverLocationOptions {
  platform: NodeJS.Platform
  windowsExecutionMode: 'same-user' | 'trusted-only'
  temporaryDirectory: string
  /** trustedInstallerCacheRoot() 的结果；解析不出来时传 null。 */
  trustedCacheRoot: string | null
  /** managedNpmCacheRoot() 的结果；不传或解析不出来（null）时不扫那里。 */
  managedNpmCacheRoot?: string | null
}

/**
 * 按管理员身份处理（trusted-only）时，安装用的临时目录都在 ProgramData 里只有管理员
 * 能写的那一处；这时绝不去系统临时目录里删东西——那里任何普通进程都能提前摆好目录
 * 或联接，诱导管理员权限的删除落到别处（同 I8）。普通权限运行时反过来，只扫自己的
 * 临时目录：ProgramData 里那些是以前管理员运行时留下的，普通权限本来也删不动。
 */
export function buildInstallLeftoverLocations(options: InstallLeftoverLocationOptions): InstallLeftoverLocation[] {
  // 托管 npm 缓存目录同样只有当前用户（Windows 上只有管理员）能写。普通权限的 Windows 不用
  // 托管目录，那里有的只会是以前按管理员身份运行时留下的，普通权限删不动，不扫。
  const managedNpmCache: InstallLeftoverLocation[] = options.managedNpmCacheRoot
    ? [{
        directory: options.managedNpmCacheRoot,
        prefixes: managedNpmTransactionLeftoverPrefixes,
        preserveIfContains: managedNpmTransactionPreservedEntries,
      }]
    : []
  if (options.platform === 'win32') {
    if (options.windowsExecutionMode === 'trusted-only') {
      return [
        ...(options.trustedCacheRoot
          ? [{ directory: options.trustedCacheRoot, prefixes: trustedCacheLeftoverPrefixes }]
          : []),
        ...managedNpmCache,
      ]
    }
    return [{ directory: options.temporaryDirectory, prefixes: userTemporaryLeftoverPrefixes }]
  }
  // macOS 从不提权；受信缓存根也在当前用户自己的临时目录下（0700）。它不属于自己时
  // 会退到 InstallerCache-XXXXXX 这样的随机名根，那整个根也是星芒自己建的。
  const locations: InstallLeftoverLocation[] = [{
    directory: options.temporaryDirectory,
    prefixes: [...userTemporaryLeftoverPrefixes, 'InstallerCache-'],
  }]
  if (options.trustedCacheRoot) {
    locations.push({ directory: options.trustedCacheRoot, prefixes: trustedCacheLeftoverPrefixes })
  }
  locations.push(...managedNpmCache)
  return locations
}

export function isInstallLeftoverName(name: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => name.startsWith(prefix)
    && mkdtempSuffixPattern.test(name.slice(prefix.length)))
}

export interface InstallLeftoverSweepResult {
  removed: number
  /** 删掉的大致字节数；数到上限就停，所以只会少算。 */
  freedBytes: number
  /** 认出来但没删掉的（被占用、没权限）。下次再试，不报错。 */
  failed: number
}

export interface InstallLeftoverSweepOptions {
  now?: number
  minimumAgeMs?: number
}

async function measureDirectoryBytes(directory: string): Promise<number> {
  let total = 0
  let visited = 0
  const stack = [directory]
  while (stack.length && visited < maximumMeasuredEntries) {
    const current = stack.pop()
    if (current === undefined) break
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      visited++
      if (visited >= maximumMeasuredEntries) break
      const child = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(child)
      } else if (entry.isFile()) {
        try {
          total += (await fs.promises.lstat(child)).size
        } catch {
          // 数不到就少算一点，只影响日志里的数字。
        }
      }
    }
  }
  return total
}

/**
 * 候选目录必须是普通目录、解析后仍落在原处（不是符号链接或目录联接），且足够旧。
 * fs.rm 递归删除时对里面的链接只删链接本身、不跟过去。
 */
async function inspectCandidate(
  root: string,
  resolvedRoot: string,
  name: string,
  cutoff: number,
): Promise<string | null> {
  const candidate = path.join(root, name)
  let stats: fs.Stats
  try {
    stats = await fs.promises.lstat(candidate)
  } catch {
    return null
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return null
  if (stats.mtimeMs > cutoff) return null
  try {
    const resolved = await fs.promises.realpath(candidate)
    if (resolved !== path.join(resolvedRoot, name)) return null
  } catch {
    return null
  }
  return candidate
}

/** 读不出来（没权限、被占用）也当作有：宁可这次留着，下次再看。 */
async function containsAnyEntry(directory: string, names: readonly string[]): Promise<boolean> {
  for (const name of names) {
    try {
      await fs.promises.lstat(path.join(directory, name))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true
    }
  }
  return false
}

export async function sweepInstallLeftovers(
  locations: readonly InstallLeftoverLocation[],
  options: InstallLeftoverSweepOptions = {},
): Promise<InstallLeftoverSweepResult> {
  const cutoff = (options.now ?? Date.now()) - (options.minimumAgeMs ?? installLeftoverMinimumAgeMs)
  const result: InstallLeftoverSweepResult = { removed: 0, freedBytes: 0, failed: 0 }
  for (const location of locations) {
    let rootStats: fs.Stats
    let resolvedRoot: string
    let names: string[]
    try {
      rootStats = await fs.promises.lstat(location.directory)
      if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) continue
      resolvedRoot = await fs.promises.realpath(location.directory)
      names = await fs.promises.readdir(location.directory)
    } catch {
      continue
    }
    for (const name of names) {
      if (!isInstallLeftoverName(name, location.prefixes)) continue
      const candidate = await inspectCandidate(location.directory, resolvedRoot, name, cutoff)
      if (!candidate) continue
      if (location.preserveIfContains && await containsAnyEntry(candidate, location.preserveIfContains)) continue
      const bytes = await measureDirectoryBytes(candidate)
      try {
        await fs.promises.rm(candidate, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 })
      } catch {
        result.failed++
        continue
      }
      result.removed++
      result.freedBytes += bytes
    }
  }
  return result
}
