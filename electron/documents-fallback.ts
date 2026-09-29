import fs from 'node:fs'
import path from 'node:path'
import { randomBytes as nodeRandomBytes } from 'node:crypto'
import {
  createStarterWorkspace,
  resolveNewProjectParent,
  resolveStarterWorkspaceParent,
  type StarterWorkspaceLocationContext,
} from './starter-workspace'

/**
 * 「文档」写不进去时，新项目和 AI 作品改放到用户主目录下（和云盘那条退路同一个地方）。
 *
 * 只认「不让写」这一类：Windows 安全中心的「受控文件夹访问」、安全软件的文档保护、
 * Mac 上点过「不允许」访问文稿，Node 看到的都是 EPERM / EACCES（推测：受控文件夹访问
 * 报哪个码没在真机上抓过，两个都认）。磁盘满、只读盘这些换个文件夹也未必好，照原来
 * 报错，不替用户换地方。
 */
const permissionErrorCodes = new Set(['EACCES', 'EPERM'])

/** 顺着 cause 链找系统错误码：包成中文的错误把原始错误挂在 cause 上。 */
export function isWritePermissionError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code
    if (typeof code === 'string' && permissionErrorCodes.has(code)) return true
    current = current.cause
  }
  return false
}

/**
 * 在 directory 里真建一个小文件再删掉。只看权限位回答不了这个问题：受控文件夹访问
 * 放行建文件夹、只拦写文件（推测，没在真机上核实），元数据检查全都能过。
 * 名字随机、用 wx 打开，预先放好的同名文件或链接只会让试写失败，不会被跟过去（I8）。
 */
export function probeDirectoryWritableSync(directory: string, randomBytes: (size: number) => Buffer = nodeRandomBytes): void {
  const probePath = path.join(directory, `.write-check-${randomBytes(16).toString('hex')}.tmp`)
  const handle = fs.openSync(probePath, 'wx', 0o600)
  try {
    fs.writeSync(handle, 'ok')
  } finally {
    fs.closeSync(handle)
    try {
      fs.rmSync(probePath, { force: true })
    } catch {
      // 删不掉只会留一个几字节的空文件，不值得为它让试写算失败。
    }
  }
}

export interface StarterWorkspacePlacement {
  directory: string
  /** 「文档」不让写，改建在了用户主目录下。界面要照实告诉用户项目在哪。 */
  movedFromDocuments: boolean
}

export interface CreateStarterWorkspaceWithFallbackOptions {
  /** 测试注入：模拟受控文件夹访问拦下建文件夹或写文件。 */
  create?: typeof createStarterWorkspace
  probe?: (directory: string) => void
}

/**
 * 新建项目文件夹，「文档」不让写就改建在用户主目录下。
 *
 * 建好之后还要在新文件夹里试写一次：受控文件夹访问可能放行建文件夹、只拦写文件
 * （推测），不试写的话用户拿到的是一个 AI 什么都存不进去的项目。试写不让写时，
 * 刚建的空文件夹顺手删掉（删不掉就留着，它是空的）。试写因为别的原因失败，
 * 照旧交出这个文件夹：以前从不试写，不该因为多了这一步反而建不成。
 */
export function createStarterWorkspaceWithFallback(
  documentsDirectory: string | null,
  context: StarterWorkspaceLocationContext,
  options: CreateStarterWorkspaceWithFallbackOptions = {},
): StarterWorkspacePlacement {
  const create = options.create ?? createStarterWorkspace
  const probe = options.probe ?? probeDirectoryWritableSync
  const parent = resolveNewProjectParent(documentsDirectory, context)
  // 已经在主目录（Mac、云盘、找不到文档）：没有更好的地方可换，照原样报错。
  if (parent === context.home) return { directory: create(parent, context), movedFromDocuments: false }
  let created: string
  try {
    created = create(parent, context)
  } catch (error) {
    if (!isWritePermissionError(error)) throw error
    return { directory: create(context.home, context), movedFromDocuments: true }
  }
  try {
    probe(created)
  } catch (error) {
    if (!isWritePermissionError(error)) return { directory: created, movedFromDocuments: false }
    removeEmptyDirectory(created)
    return { directory: create(context.home, context), movedFromDocuments: true }
  }
  return { directory: created, movedFromDocuments: false }
}

export interface DocumentsFallbackPrompt {
  title: string
  message: string
  detail: string
  buttons: readonly string[]
  openFolderIndex: number
}

/** 项目改建到主目录后弹的那一句：说清楚为什么换、换到了哪，给「打开文件夹」。 */
export function buildDocumentsFallbackPrompt(directory: string, platform: NodeJS.Platform): DocumentsFallbackPrompt {
  const cause = platform === 'win32'
    ? '常见原因是 Windows 安全中心开了「受控文件夹访问」，或者安全软件开了文档保护。'
    : '常见原因是系统或安全软件的文档保护。'
  return {
    title: '项目放在了个人文件夹',
    message: `「文档」文件夹不让写，项目放在了 ${directory}`,
    detail: `${cause}项目照常能用；以后「文档」还是不让写时，新项目也会放在这里。`,
    buttons: ['知道了', '打开文件夹'],
    openFolderIndex: 1,
  }
}

function removeEmptyDirectory(directory: string): void {
  try {
    // rmdir 只删空目录：万一里面已经有东西，原样留着。
    fs.rmdirSync(directory)
  } catch {
    // 受控文件夹访问连删也拦时就留一个空文件夹，不影响换地方。
  }
}

export type DocumentsWritability =
  /** 能写：新项目和 AI 作品照常放在「文档」里。 */
  | { state: 'writable' }
  /** 不让写（权限类）：新项目和 AI 作品已经改放主目录。 */
  | { state: 'denied', reason: string }
  /** 别的原因没写进（磁盘满、只读盘……）：不换地方，照原来的提示。 */
  | { state: 'failed', reason: string }
  /** 本来就不用「文档」：找不到它，或者它在云盘同步里。 */
  | { state: 'not-used', why: 'missing' | 'cloud' }

export interface InspectDocumentsWritabilityOptions {
  probe?: (directory: string) => void
}

/** 检查页「文档文件夹能不能写」：先看会不会用到「文档」，用得到再真写一次。 */
export function inspectDocumentsWritability(
  documentsDirectory: string | null,
  context: StarterWorkspaceLocationContext,
  options: InspectDocumentsWritabilityOptions = {},
): DocumentsWritability {
  const impl = context.platform === 'win32' ? path.win32 : path.posix
  const directoryExists = context.directoryExists ?? isExistingDirectory
  if (!documentsDirectory || !impl.isAbsolute(documentsDirectory) || !directoryExists(documentsDirectory)) {
    return { state: 'not-used', why: 'missing' }
  }
  if (resolveStarterWorkspaceParent(documentsDirectory, context) !== documentsDirectory) return { state: 'not-used', why: 'cloud' }
  try {
    (options.probe ?? probeDirectoryWritableSync)(documentsDirectory)
    return { state: 'writable' }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return isWritePermissionError(error) ? { state: 'denied', reason } : { state: 'failed', reason }
  }
}

function isExistingDirectory(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory()
  } catch {
    return false
  }
}
