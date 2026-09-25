import fs from 'node:fs'
import path from 'node:path'
import { assertNoReparseComponents, ensureSafeDataDirectory } from './safe-local-data'
import { classifyWorkspace, isOneDriveContainer, type WorkspaceGuardContext } from './workspace-guard'

/**
 * 新手没有「项目」这个概念，选到桌面或整个文档被 workspace-guard 拦下之后，
 * 最需要的是有人替他建一个。Windows 建在「文档」下面的一层容器里，那是用户找得到的
 * 位置；macOS 建在个人文件夹下（原因见 resolveNewProjectParent）。多一层容器是为了不把一串项目直接撒进文档里，也让以后再建的
 * 几个挨在一起。
 *
 * 名字刻意用英文、不带空格和括号。本产品的客户多用中文 Windows，用户名本身常是
 * 中文，工作目录会被原样交给 CLI、npm、Python 类 MCP、node-gyp 之类的下游；这些
 * 下游在非 ASCII 或带括号的路径下出问题的历史不少，而我们没法在真机上把四家 CLI
 * 加各种 MCP 全部验一遍。英文名的代价只是文件夹名不是中文，界面上仍用中文描述。
 * 名字里不出现站点名。
 */
export const starterWorkspaceContainerName = 'XingmangProjects'
export const starterWorkspaceBaseName = 'my-project'

// 同名顺延到这里还没有空位，多半是某种循环在反复建，停下来让用户自己选。
const maxStarterWorkspaceIndex = 99

/** 第 1 个叫 my-project，之后是 my-project-2、my-project-3…… */
export function buildStarterWorkspaceName(index: number): string {
  return index <= 1 ? starterWorkspaceBaseName : `${starterWorkspaceBaseName}-${index}`
}

export interface StarterWorkspaceLocationContext extends WorkspaceGuardContext {
  env: NodeJS.ProcessEnv
  /** 判断某个目录是否存在；缺省读磁盘，测试注入。 */
  directoryExists?: (directory: string) => boolean
}

/**
 * 新项目放在哪个目录下面：优先系统「文档」，文档在被云盘同步时退到用户主目录。
 *
 * 云盘同步的文档里建项目，AI 写的每个文件、装下来的依赖（node_modules 动辄几万个
 * 小文件）都会被实时上传，低配电脑会明显变卡，两台电脑还会互相冲突。
 * - Windows：OneDrive 的「已知文件夹备份」会把文档搬进 OneDrive 目录，路径里带一段
 *   `OneDrive` / `OneDrive - 公司名`，或者落在 OneDrive 环境变量指的目录里。
 * - macOS：iCloud 的「桌面与文稿」打开后，iCloud 云盘容器里会出现 Documents。
 * 判不准一律退到主目录：主目录本身两个平台都不同步，放错的代价只是位置不在文档里。
 */
export function resolveStarterWorkspaceParent(documentsDirectory: string | null, context: StarterWorkspaceLocationContext): string {
  const impl = context.platform === 'win32' ? path.win32 : path.posix
  const directoryExists = context.directoryExists ?? isExistingDirectory
  if (!documentsDirectory || !impl.isAbsolute(documentsDirectory) || !directoryExists(documentsDirectory)) return context.home
  if (context.platform === 'win32' && isInsideOneDrive(documentsDirectory, context.env)) return context.home
  if (context.platform === 'darwin') {
    const iCloudDocuments = impl.join(context.home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Documents')
    if (directoryExists(iCloudDocuments)) return context.home
  }
  return documentsDirectory
}

/**
 * 「新建项目文件夹」放在哪个目录下面：Windows 照 resolveStarterWorkspaceParent，
 * macOS 一律放用户主目录。
 *
 * macOS 把「文稿」「桌面」「下载」当受保护文件夹，授权是按程序给的：星芒能读，
 * 不代表替它跑 CLI 的「终端」能读。第一次读会弹「“终端”想访问“文稿”文件夹中的文件」，
 * 小白不认识「终端」、容易点「不允许」，之后系统不再问，AI 在项目里什么都读不到，
 * 要去系统设置里找回来（推测，没在真机上复现弹框时机与报错原文）。主目录本身不受
 * 这层保护，项目放这里就用不着这份授权。
 *
 * 只管新建的位置：已经建在「文稿」里的项目不搬。AI 生成的图片视频（ai-output-location.ts）
 * 由星芒自己写，不经过终端，仍照 resolveStarterWorkspaceParent 放，免得老用户的作品
 * 换了地方。
 */
export function resolveNewProjectParent(documentsDirectory: string | null, context: StarterWorkspaceLocationContext): string {
  if (context.platform === 'darwin') return context.home
  return resolveStarterWorkspaceParent(documentsDirectory, context)
}

function isInsideOneDrive(directory: string, env: NodeJS.ProcessEnv): boolean {
  const impl = path.win32
  const normalized = impl.normalize(directory)
  const segments = normalized.slice(impl.parse(normalized).root.length).split(/[\\/]+/)
  if (segments.some((segment) => isOneDriveContainer(segment, true))) return true
  // OneDrive 可以被挪到别的盘、别的名字，那时只有这几个变量知道它在哪。
  for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const root = env[key]
    if (!root || !impl.isAbsolute(root)) continue
    const relative = impl.relative(impl.normalize(root).toLowerCase(), normalized.toLowerCase())
    if (relative === '' || (!relative.startsWith('..') && !impl.isAbsolute(relative))) return true
  }
  return false
}

export function resolveStarterWorkspaceContainer(parentDirectory: string, platform: NodeJS.Platform): string {
  const impl = platform === 'win32' ? path.win32 : path.posix
  if (typeof parentDirectory !== 'string' || !impl.isAbsolute(parentDirectory)) {
    throw new Error('找不到可以放项目的文件夹')
  }
  return impl.join(parentDirectory, starterWorkspaceContainerName)
}

/**
 * 在 parentDirectory 下的容器里新建一个空的项目文件夹并返回它的路径。
 *
 * 目录落在用户可写区，所以照 I8 的写法走：容器目录经 ensureSafeDataDirectory 建，
 * 每个候选名用不带 recursive 的 mkdir 抢——撞名就是 EEXIST，顺延下一个序号，
 * 不存在「先看有没有再建」的窗口；建成后再把整条路径复核一遍，中途被换成联接的
 * 容器会在这里被拒。已经存在的同名文件夹一律不拿来用，哪怕它是空的：那可能是
 * 用户自己建的，里面随时会有东西。
 */
export function createStarterWorkspace(parentDirectory: string, context: WorkspaceGuardContext): string {
  const container = resolveStarterWorkspaceContainer(parentDirectory, context.platform)
  // 新建出来的目录要走完整的信任写入与 AGENTS.md 生成，它自己绝不能又落进
  // 敏感名单（比如「文档」读成了盘根）。每个序号深度相同，判第一个就够。
  if (classifyWorkspace(path.join(container, buildStarterWorkspaceName(1)), context) !== null) {
    throw new Error('这个位置不适合放项目')
  }
  // 上层目录本身不替用户建：它不存在说明系统报的位置不对，建出来的东西用户也找不到。
  if (!isExistingDirectory(parentDirectory)) throw new Error('找不到可以放项目的文件夹')
  try {
    ensureSafeDataDirectory(container, '项目文件夹')
    for (let index = 1; index <= maxStarterWorkspaceIndex; index += 1) {
      const candidate = path.join(container, buildStarterWorkspaceName(index))
      try {
        fs.mkdirSync(candidate)
      } catch (error) {
        if (isSystemError(error) && error.code === 'EEXIST') continue
        throw error
      }
      assertNoReparseComponents(candidate, '项目文件夹')
      const stats = fs.lstatSync(candidate)
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('项目文件夹必须是普通目录')
      return candidate
    }
  } catch (error) {
    // 系统错误（没权限、盘满、只读）的原文是英文，换成一句能上屏的中文；
    // 自己抛的中文校验错误原样上屏。
    if (isSystemError(error)) throw new Error('可能是没有写入权限，或者磁盘已满')
    throw error
  }
  throw new Error(`「${starterWorkspaceContainerName}」里的同名文件夹太多了`)
}

function isExistingDirectory(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory()
  } catch {
    return false
  }
}

function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string'
}
