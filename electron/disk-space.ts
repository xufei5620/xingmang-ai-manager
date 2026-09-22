import fs from 'node:fs'
import path from 'node:path'

/**
 * 装一个 CLI 要的不止一份空间：托管 npm 布局是「先在临时目录装完整份，再原子
 * 替换旧的那份」（system-service.ts 的 createInstallTemporaryDirectory 一带），
 * 峰值同时存在两份，再加上 npm 缓存。磁盘只剩几百兆时 npm 会跑到一半才报
 * ENOSPC，用户已经等了几分钟、旧版本也可能被动过——所以宁可在一个字节都还没下
 * 之前就拦住。
 */
export const installMinimumFreeBytes = 1024 ** 3
/**
 * 检查页的提醒线比安装门槛高一档：这一项的作用是「还没出事就先说一声」，
 * 卡在门槛上才报等于没提醒。
 */
export const lowDiskSpaceBytes = 2 * 1024 ** 3

export interface DiskSpaceReading {
  /** 普通用户真正能用掉的字节数（statfs 的 bavail，不含只留给 root 的那部分）。*/
  availableBytes: number
  totalBytes: number
  /** 实际问到空间的那一级目录：目标目录还没建出来时会一路向上退。*/
  measuredPath: string
  /**
   * 设备号，用来判断两个路径是不是同一块盘。statfs 本身不带设备标识，所以另外
   * stat 一次；拿不到就当作未知，宁可多报一项也不合并两块不同的盘。
   */
  deviceId: number | null
}

export interface DiskSpaceProbeOptions {
  statfs?: (target: string) => Promise<Pick<fs.StatsFs, 'bavail' | 'bsize' | 'blocks'>>
  stat?: (target: string) => Promise<Pick<fs.Stats, 'dev'>>
}

function parentOf(target: string): string | null {
  const parent = path.dirname(target)
  return parent && parent !== target ? parent : null
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * 读一个路径所在盘的剩余空间。**读不到一律返回 null**（fail-open）：网络盘、
 * 交接点、权限受限的目录上 statfs 都可能失败，为了一个查不到的数字把安装拦下来
 * 是把小毛病变成大故障。首装时目标目录往往还不存在，所以向上退到最近一级存在
 * 的目录再问——同一块盘上，哪一级问都是同一个数字。
 */
export async function readDiskSpace(
  target: string,
  options: DiskSpaceProbeOptions = {},
): Promise<DiskSpaceReading | null> {
  const statfs = options.statfs ?? ((candidate: string) => fs.promises.statfs(candidate))
  const stat = options.stat ?? ((candidate: string) => fs.promises.stat(candidate))
  let candidate: string | null = path.resolve(target)
  while (candidate) {
    let stats: Pick<fs.StatsFs, 'bavail' | 'bsize' | 'blocks'>
    try {
      stats = await statfs(candidate)
    } catch (error) {
      if (!isMissingPathError(error)) return null
      candidate = parentOf(candidate)
      continue
    }
    if (!Number.isFinite(stats.bavail) || !Number.isFinite(stats.bsize) || stats.bsize <= 0) return null
    let deviceId: number | null = null
    try {
      const entry = await stat(candidate)
      deviceId = Number.isFinite(entry.dev) ? entry.dev : null
    } catch {
      // 设备号只用来合并同盘的重复项，拿不到不影响剩余空间这个数字。
    }
    return {
      availableBytes: Math.max(0, Math.floor(stats.bavail * stats.bsize)),
      totalBytes: Math.max(0, Math.floor(stats.blocks * stats.bsize)),
      measuredPath: candidate,
      deviceId,
    }
  }
  return null
}

/** 给用户看的剩余空间：到了 GB 量级说 GB，不足 1 GB 说 MB，都不出现小数点后第二位。*/
export function formatFreeSpace(bytes: number): string {
  const safe = Math.max(0, bytes)
  if (safe >= 1024 ** 3) return `${(safe / 1024 ** 3).toFixed(1)} GB`
  const megabytes = safe / 1024 ** 2
  if (megabytes >= 1) return `${Math.round(megabytes)} MB`
  return '不足 1 MB'
}

/** 同一块盘只留一条：Windows 上托管目录和用户数据目录几乎总在 C 盘。*/
export function mergeSameDeviceReadings<T extends DiskSpaceReading>(readings: readonly T[]): T[] {
  const merged: T[] = []
  const byDevice = new Map<number, T>()
  for (const reading of readings) {
    if (reading.deviceId === null) {
      merged.push(reading)
      continue
    }
    const seen = byDevice.get(reading.deviceId)
    if (seen) continue
    byDevice.set(reading.deviceId, reading)
    merged.push(reading)
  }
  return merged
}

/**
 * 一次安装会落在好几个目录上（临时事务目录、托管目录、npm 缓存），拦不拦得看
 * 最紧的那一块盘。读不到的那些直接略过，一个都读不到就返回 null。
 */
export function tightestDiskSpace(
  readings: readonly (DiskSpaceReading | null)[],
): DiskSpaceReading | null {
  let tightest: DiskSpaceReading | null = null
  for (const reading of readings) {
    if (!reading) continue
    if (!tightest || reading.availableBytes < tightest.availableBytes) tightest = reading
  }
  return tightest
}

/**
 * 安装前的判断。读不到空间返回 null（放行），只有确实低于门槛才给出那句拦住
 * 安装的话。措辞里的「磁盘空间不足」是刻意的：渲染层 operation-error.ts 靠它
 * 把这次失败归进已有的「磁盘空间不够」一类，不另立新类。
 */
export function describeInsufficientDiskSpace(
  reading: DiskSpaceReading | null,
  minimumBytes: number = installMinimumFreeBytes,
): string | null {
  if (!reading) return null
  if (reading.availableBytes >= minimumBytes) return null
  return `安装目录所在磁盘空间不足，只剩 ${formatFreeSpace(reading.availableBytes)}，`
    + `至少需要 ${formatFreeSpace(minimumBytes)}，请先清理磁盘再试`
}
