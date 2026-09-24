import fs from 'node:fs'
import path from 'node:path'
import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { assertNoReparseComponents, ensureSafeDataDirectory, readSafeUtf8File } from './safe-local-data'
import { AiAssetMetadataStore, aiAssetMetadataFileName, aiAssetMetadataMaximumBytes } from './ai-asset-metadata-store'
import { resolveStarterWorkspaceParent, type StarterWorkspaceLocationContext } from './starter-workspace'

/**
 * AI 生成的图片、视频、音频放在「文档」下的这个文件夹里。
 *
 * 以前放在可执行文件旁边的 output：Windows 默认装进 Program Files 时普通权限写不进，
 * 生成完才发现存不下（额度已经扣了）；Mac 上它落在 .app 包里，一更新就跟着旧包没了。
 * 文档是两个平台都有、用户自己找得到、也不随软件更新和卸载变动的位置。名字用英文、
 * 不带空格，理由同 starter-workspace.ts 的 XingmangProjects；不出现站点名。
 */
export const aiOutputFolderName = 'XingmangAI'

const LABEL = 'AI 作品保存位置'

export interface ResolveAiOutputRootOptions {
  isPackaged: boolean
  projectRoot?: string
  /** 系统「文档」目录（app.getPath('documents')）；拿不到时传 null，退到用户主目录。 */
  documentsDirectory: string | null
  location: StarterWorkspaceLocationContext
}

/**
 * 开发环境仍用项目根目录下的 output，免得跑一次 dev 就往开发者自己的文档里写东西。
 * 安装版放「文档/XingmangAI」；文档被云盘同步时和新建项目文件夹一样退到用户主目录
 * （resolveStarterWorkspaceParent），视频动辄几十上百 MB，实时上传会拖慢低配电脑。
 */
export function resolveAiOutputRoot(options: ResolveAiOutputRootOptions): string {
  if (!options.isPackaged) return path.join(path.resolve(options.projectRoot ?? process.cwd()), 'output')
  const impl = options.location.platform === 'win32' ? path.win32 : path.posix
  return impl.join(resolveStarterWorkspaceParent(options.documentsDirectory, options.location), aiOutputFolderName)
}

/** 老版本的保存位置：可执行文件旁边的 output。开发环境没有老位置可搬。 */
export function resolveLegacyAiOutputRoot(options: { isPackaged: boolean, execPath?: string }): string | null {
  if (!options.isPackaged) return null
  return path.join(path.dirname(path.resolve(options.execPath ?? process.execPath)), 'output')
}

export interface AiOutputMigrationResult {
  /** 搬过去的条目数：整个账号文件夹一次改名算一个，逐个搬的文件各算一个。 */
  moved: number
  /** 新位置已有同名文件、或不是普通文件，原样留在老位置的。 */
  kept: number
  /** 搬不过去的；元数据文件合并失败也算这里，原文件留在老位置。 */
  failed: number
}

export interface MigrateLegacyAiOutputOptions {
  randomBytes?: (size: number) => Buffer
  /** 测试注入：模拟跨盘改名失败。 */
  rename?: (from: string, to: string) => Promise<void>
  /**
   * 把老位置某账号的元数据并进新位置。主进程传入正在使用的那个元数据 store 的
   * mergeLegacy，好和收藏、生成这些写入排在同一个队列里；缺省时临时建一个。
   */
  mergeMetadata?: (userId: number, content: string) => Promise<void>
}

const userDirectoryPattern = /^user-[1-9]\d*$/

/**
 * 把老位置里各账号的作品搬到新位置，布局不变（user-<id>/<日期>/xingmang-<编号>.<扩展名>
 * 与 user-<id>/asset-metadata.json）。
 *
 * 画布、聊天记录、视频任务存的都是作品编号，从不存路径（xingmang-asset://<类型>/<编号>
 * 按编号在输出根下查找），所以只要布局不变，搬完之后老作品照样打开，无需改任何引用。
 *
 * Safety: the old root sits next to the executable, which on a per-user install
 * is as writable as the new one. Only real directories named user-<id> are
 * walked and every directory is checked for reparse points before it is
 * entered or renamed. A folder renamed whole keeps its contents as they are
 * (rename never follows a link inside it, and the asset stores refuse links
 * when they read); when files move one by one, only single-link regular files
 * move. An existing file at the destination is never replaced (AGENTS.md I8).
 * Anything refused stays where it was; nothing is ever deleted unless its bytes
 * now exist at the new location. The one exception to "never replace" is each
 * account's metadata file, which is merged record by record into the new one
 * (see mergeMetadataFile). Safe to run again: a finished move leaves nothing to
 * do, and merging the same records twice changes nothing.
 */
export async function migrateLegacyAiOutput(
  from: string,
  to: string,
  options: MigrateLegacyAiOutputOptions = {},
): Promise<AiOutputMigrationResult> {
  const result: AiOutputMigrationResult = { moved: 0, kept: 0, failed: 0 }
  const source = path.resolve(from)
  const target = path.resolve(to)
  if (overlaps(source, target)) return result
  let entries: fs.Dirent[]
  try {
    const stats = await fs.promises.lstat(source)
    if (!stats.isDirectory() || stats.isSymbolicLink()) return result
    assertNoReparseComponents(source, LABEL)
    entries = await fs.promises.readdir(source, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
    throw error
  }
  const users = entries.filter((entry) => entry.isDirectory() && userDirectoryPattern.test(entry.name))
  if (users.length) {
    ensureSafeDataDirectory(target, LABEL)
    const mergeMetadata = options.mergeMetadata ?? createDefaultMetadataMerge(target)
    for (const entry of users) {
      const userId = Number(entry.name.slice('user-'.length))
      await moveTree(path.join(source, entry.name), path.join(target, entry.name), result, options, { userId, mergeMetadata })
    }
  }
  await removeIfEmpty(source)
  return result
}

function overlaps(left: string, right: string): boolean {
  return isSameOrInside(left, right) || isSameOrInside(right, left)
}

function isSameOrInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function createDefaultMetadataMerge(target: string): (userId: number, content: string) => Promise<void> {
  const store = new AiAssetMetadataStore({ outputRoot: target })
  return (userId, content) => store.mergeLegacy(userId, content)
}

interface AccountFolder {
  userId: number
  mergeMetadata: (userId: number, content: string) => Promise<void>
}

async function moveTree(
  source: string,
  target: string,
  result: AiOutputMigrationResult,
  options: MigrateLegacyAiOutputOptions,
  account: AccountFolder | null,
): Promise<void> {
  try {
    assertNoReparseComponents(source, LABEL)
    assertNoReparseComponents(path.dirname(target), LABEL)
  } catch {
    result.failed += 1
    return
  }
  // Same volume and nothing there yet: one rename moves the whole folder and
  // keeps every file's creation time, which the media library sorts by.
  if (!(await pathExists(target))) {
    try {
      await (options.rename ?? fs.promises.rename)(source, target)
      result.moved += 1
      return
    } catch {
      // Another volume, a folder that appeared meanwhile, or a locked file:
      // fall back to moving file by file so whatever can move does.
    }
  }
  let entries: fs.Dirent[]
  try {
    ensureSafeDataDirectory(target, LABEL)
    entries = await fs.promises.readdir(source, { withFileTypes: true })
  } catch {
    result.failed += 1
    return
  }
  for (const entry of entries) {
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) await moveTree(from, to, result, options, null)
    else if (entry.isFile() && account && entry.name === aiAssetMetadataFileName) await mergeMetadataFile(from, account, result)
    else if (entry.isFile()) await moveFile(from, to, result, options)
    else result.kept += 1
  }
  await removeIfEmpty(source)
}

async function moveFile(
  source: string,
  target: string,
  result: AiOutputMigrationResult,
  options: MigrateLegacyAiOutputOptions,
): Promise<void> {
  let temporary: string | null = null
  try {
    const stats = await fs.promises.lstat(source)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || await pathExists(target)) {
      result.kept += 1
      return
    }
    try {
      await (options.rename ?? fs.promises.rename)(source, target)
      result.moved += 1
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    }
    // Across volumes: copy under a name the asset stores never match, then give
    // it its real name, so an interrupted copy can never be served as a
    // truncated asset. The source goes only after the copy is complete.
    const suffix = (options.randomBytes ?? nodeRandomBytes)(8).toString('hex')
    temporary = path.join(path.dirname(target), `.moving-${suffix}.tmp`)
    await fs.promises.copyFile(source, temporary, fs.constants.COPYFILE_EXCL)
    if (await pathExists(target)) {
      result.kept += 1
      return
    }
    await fs.promises.rename(temporary, target)
    temporary = null
    await fs.promises.utimes(target, stats.atime, stats.mtime).catch(() => undefined)
    await fs.promises.rm(source, { force: true })
    result.moved += 1
  } catch {
    result.failed += 1
  } finally {
    if (temporary) await fs.promises.rm(temporary, { force: true }).catch(() => undefined)
  }
}

/**
 * The account's metadata file carries favorites, tags, prompts and recycle-bin
 * state keyed by asset id. Skipping it when the new folder already has one
 * (as plain files are skipped) would move the assets but leave their records
 * behind, so trashed assets would reappear and favorites vanish. It is merged
 * instead, and the old copy goes only after the merged state is written; a file
 * that cannot be read or merged stays where it was.
 */
async function mergeMetadataFile(source: string, account: AccountFolder, result: AiOutputMigrationResult): Promise<void> {
  try {
    const stats = await fs.promises.lstat(source)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      result.kept += 1
      return
    }
    const content = await readSafeUtf8File(source, LABEL, aiAssetMetadataMaximumBytes)
    if (content === null) return
    await account.mergeMetadata(account.userId, content)
    await fs.promises.rm(source, { force: true })
    result.moved += 1
  } catch {
    result.failed += 1
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.promises.lstat(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    // Cannot tell: treat it as taken so nothing is moved over it.
    return true
  }
}

async function removeIfEmpty(directory: string): Promise<void> {
  // rmdir only succeeds on an empty directory, so a folder that still holds
  // something that could not be moved stays exactly as it was.
  await fs.promises.rmdir(directory).catch(() => undefined)
}
