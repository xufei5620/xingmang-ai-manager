import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface NativeCliUninstallOptions {
  actualDirectory: string
  expectedDirectory: string
  fileNames: readonly string[]
  label: string
  platform?: NodeJS.Platform
  removeDirectoryWhenEmpty?: boolean
}

export interface NativeCliUninstallResult {
  directory: string
  removedFiles: string[]
  retainedQuarantineFiles: string[]
  directoryRemoved: boolean
}

function normalizedPath(value: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(value).replace(/[\\/]$/, '')
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

function requirePlainDirectory(
  actualDirectory: string,
  expectedDirectory: string,
  label: string,
  platform: NodeJS.Platform,
): string {
  const actual = path.resolve(actualDirectory)
  const expected = path.resolve(expectedDirectory)
  if (normalizedPath(actual, platform) !== normalizedPath(expected, platform)) {
    throw new Error(`检测到非标准 ${label} 安装目录 ${actual}，为避免误删，请使用该发行版自带的卸载方式`)
  }
  let stats: fs.Stats
  try {
    stats = fs.lstatSync(actual)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} 安装目录已不存在，请刷新后重试`)
    }
    throw error
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} 安装目录被链接替换，已停止卸载`)
  }
  const realDirectory = fs.realpathSync.native?.(actual) ?? fs.realpathSync(actual)
  if (normalizedPath(realDirectory, platform) !== normalizedPath(actual, platform)) {
    throw new Error(`${label} 安装目录经过了符号链接或目录联接，已停止卸载`)
  }
  return realDirectory
}

function requireSafeFileName(fileName: string): void {
  if (!fileName || fileName.includes('\0') || path.basename(fileName) !== fileName) {
    throw new Error('原生 CLI 卸载文件名无效')
  }
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.nlink === right.nlink
}

interface VerifiedUninstallFile {
  fileName: string
  filePath: string
  quarantinePath: string
  identity: fs.Stats
  moved: boolean
}

async function prepareVerifiedFile(
  directory: string,
  fileName: string,
  label: string,
  platform: NodeJS.Platform,
  required: boolean,
): Promise<VerifiedUninstallFile | null> {
  requireSafeFileName(fileName)
  const filePath = path.join(directory, fileName)
  let before: fs.Stats
  try {
    before = await fs.promises.lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !required) return null
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} 主程序 ${fileName} 已不存在，请刷新后重试`)
    }
    throw error
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error(`${label} 文件 ${fileName} 不是单链接普通文件，已停止卸载`)
  }
  const realFile = fs.realpathSync.native?.(filePath) ?? fs.realpathSync(filePath)
  if (normalizedPath(realFile, platform) !== normalizedPath(filePath, platform)) {
    throw new Error(`${label} 文件 ${fileName} 被链接替换，已停止卸载`)
  }
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const opened = await handle.stat()
    const current = await fs.promises.lstat(filePath)
    if (!sameFile(before, opened) || !sameFile(opened, current)) {
      throw new Error(`${label} 文件 ${fileName} 在卸载前发生变化，已停止卸载`)
    }
  } finally {
    await handle.close()
  }
  return {
    fileName,
    filePath,
    quarantinePath: path.join(directory, `.${fileName}-${randomUUID()}.removing`),
    identity: before,
    moved: false,
  }
}

async function moveVerifiedFilesToQuarantine(
  files: VerifiedUninstallFile[],
  label: string,
): Promise<void> {
  try {
    for (const file of files) {
      await fs.promises.rename(file.filePath, file.quarantinePath)
      file.moved = true
      const quarantined = await fs.promises.lstat(file.quarantinePath)
      if (!quarantined.isFile() || quarantined.isSymbolicLink() || !sameFile(file.identity, quarantined)) {
        throw new Error(`${label} 文件 ${file.fileName} 在卸载提交时发生变化`)
      }
    }
  } catch (error) {
    const rollbackErrors: string[] = []
    for (const file of [...files].reverse()) {
      if (!file.moved || !fs.existsSync(file.quarantinePath)) continue
      try {
        if (fs.existsSync(file.filePath)) {
          throw new Error('原路径已被其他文件占用')
        }
        await fs.promises.rename(file.quarantinePath, file.filePath)
      } catch (rollbackError) {
        rollbackErrors.push(`${file.fileName}：${String(rollbackError)}`)
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`${label} 卸载失败且文件回滚不完整：${rollbackErrors.join('；')}`, { cause: error })
    }
    throw error
  }
}

/** The first file name is the required primary executable; later entries are optional helpers. */
export async function uninstallVerifiedNativeCliFiles(
  options: NativeCliUninstallOptions,
): Promise<NativeCliUninstallResult> {
  if (!options.fileNames.length) throw new Error('原生 CLI 卸载清单为空')
  const platform = options.platform ?? process.platform
  const directory = requirePlainDirectory(
    options.actualDirectory,
    options.expectedDirectory,
    options.label,
    platform,
  )
  const files: VerifiedUninstallFile[] = []
  for (const [index, fileName] of options.fileNames.entries()) {
    const file = await prepareVerifiedFile(directory, fileName, options.label, platform, index === 0)
    if (file) files.push(file)
  }
  await moveVerifiedFilesToQuarantine(files, options.label)

  const retainedQuarantineFiles: string[] = []
  for (const file of files) {
    try {
      await fs.promises.rm(file.quarantinePath, { force: true })
    } catch {
      // The declared command paths are already gone. A locked quarantine file
      // is harmless; expose its path so callers can report deferred cleanup.
      retainedQuarantineFiles.push(file.quarantinePath)
    }
  }
  const removedFiles = files.map((file) => file.fileName)
  let directoryRemoved = false
  if (options.removeDirectoryWhenEmpty !== false) {
    try {
      await fs.promises.rmdir(directory)
      directoryRemoved = true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOTEMPTY' && code !== 'ENOENT') throw error
    }
  }
  return { directory, removedFiles, retainedQuarantineFiles, directoryRemoved }
}
