import fs from 'node:fs'
import path from 'node:path'

function normalizedPath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
}

function sameFileSnapshot(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function assertSingleLinkRegularFile(stats: fs.BigIntStats, label: string): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) {
    throw new Error(`${label}必须是单链接普通文件`)
  }
}

function pathSnapshotSync(filePath: string, label: string): fs.BigIntStats {
  const before = fs.lstatSync(filePath, { bigint: true })
  assertSingleLinkRegularFile(before, label)
  const canonical = fs.realpathSync.native(filePath)
  const after = fs.lstatSync(filePath, { bigint: true })
  assertSingleLinkRegularFile(after, label)
  if (!sameFileSnapshot(before, after)) throw new Error(`${label}在路径校验期间发生变化`)
  if (normalizedPath(canonical) !== normalizedPath(filePath)) {
    throw new Error(`${label}不能经过符号链接或目录联接`)
  }
  return after
}

async function pathSnapshot(filePath: string, label: string): Promise<fs.BigIntStats> {
  const before = await fs.promises.lstat(filePath, { bigint: true })
  assertSingleLinkRegularFile(before, label)
  const canonical = await fs.promises.realpath(filePath)
  const after = await fs.promises.lstat(filePath, { bigint: true })
  assertSingleLinkRegularFile(after, label)
  if (!sameFileSnapshot(before, after)) throw new Error(`${label}在路径校验期间发生变化`)
  if (normalizedPath(canonical) !== normalizedPath(filePath)) {
    throw new Error(`${label}不能经过符号链接或目录联接`)
  }
  return after
}

function readBufferSize(stats: fs.BigIntStats, maximumBytes: number, label: string): number {
  if (stats.size > BigInt(maximumBytes)) {
    throw new Error(`${label}超过 ${Math.floor(maximumBytes / 1024)} KB 安全上限`)
  }
  return Number(stats.size)
}

export function readBoundedUtf8FileSync(
  filePath: string,
  maximumBytes: number,
  label: string,
): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error(`${label}读取上限无效`)
  }
  const pathBeforeOpen = pathSnapshotSync(filePath, label)
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  )
  try {
    const before = fs.fstatSync(descriptor, { bigint: true })
    assertSingleLinkRegularFile(before, label)
    if (!sameFileSnapshot(pathBeforeOpen, before)) throw new Error(`${label}在打开期间发生变化`)
    const buffer = Buffer.allocUnsafe(readBufferSize(before, maximumBytes, label))
    let offset = 0
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const after = fs.fstatSync(descriptor, { bigint: true })
    const pathAfterRead = pathSnapshotSync(filePath, label)
    if (
      offset !== buffer.length
      || !sameFileSnapshot(before, after)
      || !sameFileSnapshot(after, pathAfterRead)
    ) {
      throw new Error(`${label}在读取过程中发生变化`)
    }
    return buffer.toString('utf8')
  } finally {
    fs.closeSync(descriptor)
  }
}

export async function readBoundedUtf8File(
  filePath: string,
  maximumBytes: number,
  label: string,
): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error(`${label}读取上限无效`)
  }
  const pathBeforeOpen = await pathSnapshot(filePath, label)
  const handle = await fs.promises.open(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  )
  try {
    const before = await handle.stat({ bigint: true })
    assertSingleLinkRegularFile(before, label)
    if (!sameFileSnapshot(pathBeforeOpen, before)) throw new Error(`${label}在打开期间发生变化`)
    const buffer = Buffer.allocUnsafe(readBufferSize(before, maximumBytes, label))
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const pathAfterRead = await pathSnapshot(filePath, label)
    if (
      offset !== buffer.length
      || !sameFileSnapshot(before, after)
      || !sameFileSnapshot(after, pathAfterRead)
    ) {
      throw new Error(`${label}在读取过程中发生变化`)
    }
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}
