import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { sameLocalPathIdentity } from './path-identity'

function existingPathIsReparsePoint(filePath: string): boolean {
  try {
    const realPath = fs.realpathSync(filePath)
    return !sameLocalPathIdentity(realPath, filePath)
  } catch {
    return true
  }
}

export function assertNoReparseComponents(targetPath: string, label: string): void {
  const resolved = path.resolve(targetPath)
  const parsed = path.parse(resolved)
  const relative = resolved.slice(parsed.root.length)
  let current = parsed.root
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      fs.lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw new Error(`${label}无法验证路径组件`)
    }
    if (existingPathIsReparsePoint(current)) {
      throw new Error(`${label}不能经过符号链接或目录联接`)
    }
  }
}

export function ensureSafeDataDirectory(directory: string, label: string): void {
  assertNoReparseComponents(path.dirname(path.resolve(directory)), label)
  fs.mkdirSync(directory, { recursive: true })
  assertNoReparseComponents(directory, label)
  const stats = fs.lstatSync(directory)
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${label}必须是普通目录`)
}

export function assertSafeDataFile(filePath: string, label: string): boolean {
  assertNoReparseComponents(path.dirname(path.resolve(filePath)), label)
  try {
    const stats = fs.lstatSync(filePath)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw new Error(`${label}必须是单链接普通文件`)
    }
    const realPath = fs.realpathSync(filePath)
    if (!sameLocalPathIdentity(realPath, filePath)) {
      throw new Error(`${label}不能经过符号链接或目录联接`)
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function validateReadLimit(maximumBytes: number | undefined, label: string): void {
  if (maximumBytes !== undefined && (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0)) {
    throw new Error(`${label}读取上限无效`)
  }
}

function assertWithinReadLimit(size: number, maximumBytes: number | undefined, label: string): void {
  if (maximumBytes !== undefined && size > maximumBytes) {
    throw new Error(`${label}超过 ${Math.floor(maximumBytes / 1024)} KB 安全上限`)
  }
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

function safeNumericSize(size: bigint, label: string): number {
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label}大小超出安全范围`)
  return Number(size)
}

function validateOpenedSafeDataFile(
  filePath: string,
  opened: fs.BigIntStats,
  label: string,
): void {
  const current = fs.lstatSync(filePath, { bigint: true })
  const realPath = fs.realpathSync(filePath)
  if (
    !opened.isFile()
    || !current.isFile()
    || current.isSymbolicLink()
    || opened.nlink !== 1n
    || current.nlink !== 1n
    || !sameFileIdentity(opened, current)
    || !sameLocalPathIdentity(realPath, filePath)
  ) {
    throw new Error(`${label}在打开期间发生变化`)
  }
}

function openSafeDataFileSync(filePath: string, label: string): number | null {
  if (!assertSafeDataFile(filePath, label)) return null
  const descriptor = fs.openSync(filePath, 'r')
  try {
    validateOpenedSafeDataFile(filePath, fs.fstatSync(descriptor, { bigint: true }), label)
    return descriptor
  } catch (error) {
    fs.closeSync(descriptor)
    throw error
  }
}

async function openSafeDataFile(filePath: string, label: string): Promise<fs.promises.FileHandle | null> {
  if (!assertSafeDataFile(filePath, label)) return null
  const handle = await fs.promises.open(filePath, 'r')
  try {
    validateOpenedSafeDataFile(filePath, await handle.stat({ bigint: true }), label)
    return handle
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function openSafeDataFileForAppend(
  filePath: string,
  label: string,
): Promise<{ handle: fs.promises.FileHandle; snapshot: fs.BigIntStats }> {
  assertNoReparseComponents(path.dirname(path.resolve(filePath)), label)
  const existed = assertSafeDataFile(filePath, label)
  let handle: fs.promises.FileHandle
  try {
    handle = await fs.promises.open(filePath, existed ? 'r+' : 'wx', 0o600)
  } catch (error) {
    if (existed || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!assertSafeDataFile(filePath, label)) throw error
    handle = await fs.promises.open(filePath, 'r+', 0o600)
  }
  try {
    const opened = await handle.stat({ bigint: true })
    validateOpenedSafeDataFile(filePath, opened, label)
    safeNumericSize(opened.size, label)
    return { handle, snapshot: opened }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

export function readSafeUtf8FileSync(
  filePath: string,
  label: string,
  maximumBytes?: number,
): string | null {
  validateReadLimit(maximumBytes, label)
  const descriptor = openSafeDataFileSync(filePath, label)
  if (descriptor === null) return null
  try {
    const before = fs.fstatSync(descriptor, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n) throw new Error(`${label}在读取前发生变化`)
    const size = safeNumericSize(before.size, label)
    assertWithinReadLimit(size, maximumBytes, label)
    const buffer = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const after = fs.fstatSync(descriptor, { bigint: true })
    if (offset !== buffer.length || !sameFileSnapshot(before, after)) {
      throw new Error(`${label}在读取过程中发生变化`)
    }
    validateOpenedSafeDataFile(filePath, after, label)
    return buffer.toString('utf8')
  } finally {
    fs.closeSync(descriptor)
  }
}

export async function readSafeUtf8File(
  filePath: string,
  label: string,
  maximumBytes?: number,
): Promise<string | null> {
  validateReadLimit(maximumBytes, label)
  const handle = await openSafeDataFile(filePath, label)
  if (!handle) return null
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n) throw new Error(`${label}在读取前发生变化`)
    const size = safeNumericSize(before.size, label)
    assertWithinReadLimit(size, maximumBytes, label)
    const buffer = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (offset !== buffer.length || !sameFileSnapshot(before, after)) {
      throw new Error(`${label}在读取过程中发生变化`)
    }
    validateOpenedSafeDataFile(filePath, after, label)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

export async function appendSafeUtf8File(filePath: string, content: string, label: string): Promise<void> {
  const { handle, snapshot } = await openSafeDataFileForAppend(filePath, label)
  try {
    const buffer = Buffer.from(content, 'utf8')
    const position = safeNumericSize(snapshot.size, label)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesWritten } = await handle.write(
        buffer,
        offset,
        buffer.length - offset,
        position + offset,
      )
      if (bytesWritten === 0) throw new Error(`${label}追加写入不完整`)
      offset += bytesWritten
    }
    const after = await handle.stat({ bigint: true })
    if (
      !sameFileIdentity(snapshot, after)
      || after.size !== snapshot.size + BigInt(buffer.length)
    ) {
      throw new Error(`${label}在追加写入过程中发生变化`)
    }
    validateOpenedSafeDataFile(filePath, after, label)
  } finally {
    await handle.close()
  }
}

export async function removeSafeDataFile(filePath: string, label: string): Promise<void> {
  if (!assertSafeDataFile(filePath, label)) return
  await fs.promises.rm(filePath)
}

export async function writeAtomicSafeUtf8File(
  filePath: string,
  content: string,
  label: string,
): Promise<void> {
  return writeAtomicSafeFile(filePath, content, 'utf8', label)
}

export async function writeAtomicSafeBinaryFile(
  filePath: string,
  content: Buffer,
  label: string,
): Promise<void> {
  return writeAtomicSafeFile(filePath, content, null, label)
}

async function writeAtomicSafeFile(
  filePath: string,
  content: string | Buffer,
  encoding: BufferEncoding | null,
  label: string,
): Promise<void> {
  const directory = path.dirname(path.resolve(filePath))
  assertNoReparseComponents(directory, label)
  const directoryStats = fs.lstatSync(directory)
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error(`${label}所在目录不是普通目录`)
  }
  assertSafeDataFile(filePath, label)
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  let handle: fs.promises.FileHandle | null = null
  try {
    handle = await fs.promises.open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(content, { encoding })
    await handle.sync()
    await handle.close()
    handle = null
    assertSafeDataFile(filePath, label)
    await fs.promises.rename(temporaryPath, filePath)
  } finally {
    await handle?.close().catch(() => undefined)
    await removeSafeDataFile(temporaryPath, `${label}临时文件`).catch(() => undefined)
  }
}
