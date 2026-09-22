import path from 'node:path'

/**
 * 「打开」进 CLI 的目录会被整个当成一个项目：本软件会替用户把它写进 CLI 的信任
 * 名单（workspace-trust），还会在里面生成一份 AGENTS.md（project-instructions），
 * 而 Claude Code 读工作目录**及其上层**的每一份 AGENTS.md。所以一旦选中的是主目录、
 * 盘根、桌面、下载或文档，这两件事就不再是「给这个项目配一下」，而是给整台电脑
 * 配了一次，用户以后在任何子目录打开都被它管着，还看不出来它在哪。
 *
 * 这个模块只负责判定，不读磁盘也不看注册表：判定要能在两个平台上被单测覆盖，
 * 而 Windows 的已知文件夹重定向（OneDrive）只能靠路径形状识别。判不准时一律
 * 判成普通目录——误判成敏感目录会让正常项目丢掉信任写入，代价比少拦一次大。
 */
export type SensitiveWorkspaceKind = 'home' | 'drive-root' | 'desktop' | 'downloads' | 'documents'

export interface WorkspaceGuardContext {
  platform: NodeJS.Platform
  home: string
}

interface WellKnownFolder {
  kind: SensitiveWorkspaceKind
  names: readonly string[]
}

// 磁盘上的英文名是 Windows 与 macOS 的事实名称（中文只是显示名）；中文名出现在
// 简体中文 OneDrive 里，那边的桌面 / 文档 / 下载在磁盘上就叫中文。
const wellKnownFolders: readonly WellKnownFolder[] = [
  { kind: 'desktop', names: ['Desktop', '桌面'] },
  { kind: 'downloads', names: ['Downloads', '下载'] },
  { kind: 'documents', names: ['Documents', '文档'] },
]

const sensitiveWorkspaceLabels: Record<SensitiveWorkspaceKind, string> = {
  home: '用户主目录',
  'drive-root': '整个磁盘的根目录',
  desktop: '桌面',
  downloads: '下载文件夹',
  documents: '文档文件夹',
}

export function sensitiveWorkspaceLabel(kind: SensitiveWorkspaceKind): string {
  return sensitiveWorkspaceLabels[kind]
}

/**
 * 选中的目录是不是「一份配置管全电脑」的那几类。返回 null 表示普通目录，
 * 按原有行为处理。
 */
export function classifyWorkspace(workspace: string, context: WorkspaceGuardContext): SensitiveWorkspaceKind | null {
  const impl = context.platform === 'win32' ? path.win32 : path.posix
  if (typeof workspace !== 'string' || workspace.trim() === '') return null
  if (!impl.isAbsolute(workspace)) return null
  const target = normalizeDirectory(workspace, impl)
  if (impl.parse(target).root === target) return 'drive-root'
  // macOS 上外接盘与其他卷挂在 /Volumes/<卷名> 下，它们的根与 / 是一回事。
  if (context.platform === 'darwin') {
    const segments = splitSegments(target, impl)
    if (segments.length === 2 && segments[0] === 'Volumes') return 'drive-root'
  }
  const caseInsensitive = context.platform === 'win32' || context.platform === 'darwin'
  const home = usableHome(context.home, impl)
  if (!home) return null
  if (samePath(target, home, caseInsensitive)) return 'home'
  const relative = relativeSegments(home, target, impl, caseInsensitive)
  if (!relative) return null
  if (relative.length === 1) return matchWellKnownFolder(relative[0], caseInsensitive)
  // OneDrive 的已知文件夹重定向：主目录下多一层 OneDrive（企业版是
  // 「OneDrive - 公司名」），桌面 / 文档 / 下载搬进它里面，路径形状不变。
  if (relative.length === 2 && isOneDriveContainer(relative[0], caseInsensitive)) {
    return matchWellKnownFolder(relative[1], caseInsensitive)
  }
  return null
}

function usableHome(home: string, impl: path.PlatformPath): string | null {
  if (typeof home !== 'string' || home.trim() === '' || !impl.isAbsolute(home)) return null
  return normalizeDirectory(home, impl)
}

function matchWellKnownFolder(name: string, caseInsensitive: boolean): SensitiveWorkspaceKind | null {
  for (const folder of wellKnownFolders) {
    if (folder.names.some((candidate) => samePath(name, candidate, caseInsensitive))) return folder.kind
  }
  return null
}

export function isOneDriveContainer(name: string, caseInsensitive: boolean): boolean {
  if (samePath(name, 'OneDrive', caseInsensitive)) return true
  const prefix = 'OneDrive - '
  return name.length > prefix.length && samePath(name.slice(0, prefix.length), prefix, caseInsensitive)
}

function normalizeDirectory(value: string, impl: path.PlatformPath): string {
  const normalized = impl.normalize(value)
  const root = impl.parse(normalized).root
  let trimmed = normalized
  while (trimmed.length > root.length && (trimmed.endsWith('\\') || trimmed.endsWith('/'))) {
    trimmed = trimmed.slice(0, -1)
  }
  return trimmed
}

function splitSegments(target: string, impl: path.PlatformPath): string[] {
  const root = impl.parse(target).root
  return target.slice(root.length).split(/[\\/]+/).filter((segment) => segment !== '')
}

function samePath(left: string, right: string, caseInsensitive: boolean): boolean {
  return caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * target 相对 home 的层级；不在 home 下面返回 null。前缀比较按整段走，
 * 免得 `C:\Users\ab` 被当成 `C:\Users\a` 的子目录。
 */
function relativeSegments(
  home: string,
  target: string,
  impl: path.PlatformPath,
  caseInsensitive: boolean,
): string[] | null {
  if (!samePath(impl.parse(home).root, impl.parse(target).root, caseInsensitive)) return null
  const homeSegments = splitSegments(home, impl)
  const targetSegments = splitSegments(target, impl)
  if (targetSegments.length <= homeSegments.length) return null
  for (let index = 0; index < homeSegments.length; index += 1) {
    if (!samePath(homeSegments[index], targetSegments[index], caseInsensitive)) return null
  }
  return targetSegments.slice(homeSegments.length)
}

export interface SensitiveWorkspacePrompt {
  title: string
  message: string
  detail: string
  buttons: readonly string[]
  /** 「仍然打开」在 buttons 里的下标。 */
  continueIndex: number
  /** 「新建一个项目文件夹」在 buttons 里的下标，也是默认按钮（starter-workspace.ts）。 */
  createIndex: number
  /** 「换一个文件夹」在 buttons 里的下标，同时是对话框被直接关掉时的取值。 */
  cancelIndex: number
}

/**
 * 提示只说清三件事：为什么不建议、还没有项目文件夹时怎么办、坚持打开会少做什么。
 * 不劝退——有人确实把项目直接放在桌面上。
 */
export function buildSensitiveWorkspacePrompt(kind: SensitiveWorkspaceKind): SensitiveWorkspacePrompt {
  const label = sensitiveWorkspaceLabel(kind)
  return {
    title: '这个文件夹范围太大',
    message: `你选的是${label}，AI 工具会把它整个当成一个项目。`,
    detail: [
      `${label}里通常放着与这次工作无关的大量文件，工具第一次打开要扫很久，也可能读到你不想给它看的资料。建议改选一个具体的项目文件夹。`,
      '还没有项目文件夹的话，点「新建一个项目文件夹」，会替你建一个空的项目文件夹并直接打开，不用再选、不用起名。',
      '仍然打开也可以，只是这一次不会替你把它标成「可信」，也不会在里面生成项目说明文件（AGENTS.md）——那份说明会对它下面的所有项目生效。',
    ].join('\n\n'),
    // 客户多是新手，少让他做决定：「新建」放第一个并作为默认按钮（回车即选，
    // macOS 上是高亮的那个），另外两个退成次要。
    buttons: ['新建一个项目文件夹', '换一个文件夹', '仍然打开'],
    createIndex: 0,
    cancelIndex: 1,
    continueIndex: 2,
  }
}
