import path from 'node:path'
import { providerConfigDirectoryNames } from './catalog'

/**
 * 「打开」进 CLI 的目录会被整个当成一个项目：本软件会替用户把它写进 CLI 的信任
 * 名单（workspace-trust），还会在里面生成一份 AGENTS.md（project-instructions），
 * 而 Claude Code 读工作目录**及其上层**的每一份 AGENTS.md。所以一旦选中的是主目录、
 * 盘根、桌面、下载或文档，这两件事就不再是「给这个项目配一下」，而是给整台电脑
 * 配了一次，用户以后在任何子目录打开都被它管着，还看不出来它在哪。系统目录与
 * 四家工具存 Key 的目录更进一步：agent 在那里能改系统文件、能读到明文 Key。
 *
 * 这个模块只负责判定，不读磁盘也不看注册表：判定要能在两个平台上被单测覆盖，
 * 而 Windows 的已知文件夹重定向（OneDrive）只能靠路径形状识别。判不准时一律
 * 判成普通目录——误判成敏感目录会让正常项目丢掉信任写入，代价比少拦一次大。
 *
 * 所有类别都只认那个目录本身：`文档\XingmangProjects\my-project`、
 * `OneDrive\文档\我的项目` 这类子目录是正常的项目位置，一律放行。
 */
export type SensitiveWorkspaceKind =
  | 'home'
  | 'drive-root'
  | 'desktop'
  | 'downloads'
  | 'documents'
  | 'users-root'
  | 'onedrive-root'
  | 'app-data'
  | 'system'
  | 'provider-config'

/**
 * once：沿用 #321，提示一次，用户点「仍然打开」后这个目录照常被记住。
 * every-time：每次打开都提醒，也不记住。系统目录与四家工具存密钥的目录没有正当
 * 理由拿来当项目，在里面开 agent 等于把系统文件或明文 Key 交给它。
 */
export type SensitiveWorkspacePolicy = 'once' | 'every-time'

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

// 系统自带、不该拿来当项目的顶层目录。只认盘根 / 根下的这一层，
// `C:\Program Files\某软件` 这类更深的路径不在判定范围内。
const windowsSystemFolders = ['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData']
const darwinSystemFolders = ['System', 'Library', 'Applications', 'usr', 'bin', 'sbin', 'etc', 'private', 'var', 'opt']

// 主目录下各软件存放自身数据的位置：Windows 是 AppData 及其下的 Roaming
// （%APPDATA%）/ Local（%LOCALAPPDATA%）/ LocalLow，macOS 是 ~/Library。
const windowsAppDataFolders = ['Roaming', 'Local', 'LocalLow']

const sensitiveWorkspaceLabels: Record<SensitiveWorkspaceKind, string> = {
  home: '用户主目录',
  'drive-root': '整个磁盘的根目录',
  desktop: '桌面',
  downloads: '下载文件夹',
  documents: '文档文件夹',
  'users-root': '存放所有用户资料的文件夹',
  'onedrive-root': '整个 OneDrive 同步文件夹',
  'app-data': '各个软件存放自己数据的文件夹',
  system: '系统文件夹',
  'provider-config': 'AI 工具保存登录信息和密钥的文件夹',
}

const sensitiveWorkspacePolicies: Record<SensitiveWorkspaceKind, SensitiveWorkspacePolicy> = {
  home: 'once',
  'drive-root': 'once',
  desktop: 'once',
  downloads: 'once',
  documents: 'once',
  'users-root': 'once',
  'onedrive-root': 'once',
  'app-data': 'once',
  system: 'every-time',
  'provider-config': 'every-time',
}

export function sensitiveWorkspaceLabel(kind: SensitiveWorkspaceKind): string {
  return sensitiveWorkspaceLabels[kind]
}

export function sensitiveWorkspacePolicy(kind: SensitiveWorkspaceKind): SensitiveWorkspacePolicy {
  return sensitiveWorkspacePolicies[kind]
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
  const caseInsensitive = context.platform === 'win32' || context.platform === 'darwin'
  const segments = splitSegments(target, impl)
  // macOS 上外接盘与其他卷挂在 /Volumes/<卷名> 下，它们的根与 / 是一回事。
  if (context.platform === 'darwin' && segments.length === 2 && segments[0] === 'Volumes') return 'drive-root'
  if (segments.length === 1 && isSystemFolder(segments[0], context.platform)) return 'system'
  const home = usableHome(context.home, impl)
  // 所有用户的主目录都放在这一层（C:\Users、/Users）。主目录读不到时仍按名字认，
  // 这两个名字在两个平台上都是固定的。
  if (segments.length === 1 && caseInsensitive && samePath(segments[0], 'Users', true)) return 'users-root'
  if (!home) return null
  if (samePath(target, home, caseInsensitive)) return 'home'
  if (samePath(target, impl.dirname(home), caseInsensitive)) return 'users-root'
  const relative = relativeSegments(home, target, impl, caseInsensitive)
  if (!relative) return null
  if (relative.length === 1) {
    const name = relative[0]
    if (isProviderConfigFolder(name, caseInsensitive)) return 'provider-config'
    if (context.platform === 'win32' && samePath(name, 'AppData', true)) return 'app-data'
    if (context.platform === 'darwin' && samePath(name, 'Library', true)) return 'app-data'
    // 整个 OneDrive 当工作区，CLI 装的依赖和生成的文件会被一起同步上云。
    if (isOneDriveContainer(name, caseInsensitive)) return 'onedrive-root'
    return matchWellKnownFolder(name, caseInsensitive)
  }
  if (relative.length === 2) {
    if (
      context.platform === 'win32'
      && samePath(relative[0], 'AppData', true)
      && windowsAppDataFolders.some((folder) => samePath(relative[1], folder, true))
    ) return 'app-data'
    // OneDrive 的已知文件夹重定向：主目录下多一层 OneDrive（企业版是
    // 「OneDrive - 公司名」），桌面 / 文档 / 下载搬进它里面，路径形状不变。
    if (isOneDriveContainer(relative[0], caseInsensitive)) return matchWellKnownFolder(relative[1], caseInsensitive)
  }
  return null
}

function isSystemFolder(name: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return windowsSystemFolders.some((folder) => samePath(name, folder, true))
  if (platform === 'darwin') return darwinSystemFolders.some((folder) => samePath(name, folder, true))
  return false
}

// 目录名从 catalog 取：本软件往哪写 Key，这里就拦哪，改名时两边不会走散。
function isProviderConfigFolder(name: string, caseInsensitive: boolean): boolean {
  return Object.values(providerConfigDirectoryNames).some((folder) => samePath(name, folder, caseInsensitive))
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

// 新增几类各自一句「为什么不建议」，给小白看：不出现 AppData、配置目录这类词。
// 没列的五类（#321）共用「范围太大」那一句。
const sensitiveWorkspaceReasons: Partial<Record<SensitiveWorkspaceKind, string>> = {
  'users-root': '这里装着这台电脑上每个人的个人资料，工具第一次打开要扫很久，也可能读到别人或你自己不想给它看的资料。建议改选一个具体的项目文件夹。',
  'onedrive-root': '这里的文件会自动同步到云端，工具干活时装的依赖和生成的临时文件也会被一起上传，占满网盘还拖慢电脑。建议改选一个具体的项目文件夹。',
  'app-data': '这里放着各个软件自己的数据和登录信息，与这次工作无关，也可能被工具读到你不想给它看的内容。建议改选一个具体的项目文件夹。',
  system: '这里放着电脑和其他软件正常运行需要的文件，AI 工具在里面改动或删掉东西，可能让电脑或别的软件出问题。建议换一个你自己建的文件夹。',
  'provider-config': '这里存着 AI 工具的登录信息和密钥。在这里打开，等于把密钥摊开给 AI 看，它可能被写进对话记录甚至发出去。建议换一个你自己建的文件夹。',
}

export interface SensitiveWorkspacePrompt {
  title: string
  message: string
  detail: string
  buttons: readonly string[]
  /** 「仍然打开」在 buttons 里的下标。 */
  continueIndex: number
  /**
   * 「新建一个项目文件夹」在 buttons 里的下标，也是默认按钮（starter-workspace.ts）。
   * 续接对话时没有这一项（新建的空目录接不上那条对话），为 null。
   */
  createIndex: number | null
  /** 「换一个文件夹」（或「先不打开」）在 buttons 里的下标，同时是对话框被直接关掉时的取值。 */
  cancelIndex: number
}

export interface SensitiveWorkspacePromptOptions {
  /**
   * 缺省 true。续接上一条对话时换目录就接不上了，那时取消键只能是「先不打开」。
   */
  allowChooseAnother?: boolean
}

/**
 * 提示只说清三件事：为什么不建议、还没有项目文件夹时怎么办、坚持打开会少做什么。
 * 不劝退——有人确实把项目直接放在桌面上。
 */
export function buildSensitiveWorkspacePrompt(
  kind: SensitiveWorkspaceKind,
  options: SensitiveWorkspacePromptOptions = {},
): SensitiveWorkspacePrompt {
  const label = sensitiveWorkspaceLabel(kind)
  const reason = sensitiveWorkspaceReasons[kind]
    ?? `${label}里通常放着与这次工作无关的大量文件，工具第一次打开要扫很久，也可能读到你不想给它看的资料。建议改选一个具体的项目文件夹。`
  const everyTime = sensitiveWorkspacePolicy(kind) === 'every-time'
  const allowChooseAnother = options.allowChooseAnother !== false
  return {
    title: everyTime ? '不建议在这个文件夹里打开' : '这个文件夹范围太大',
    message: `你选的是${label}，AI 工具会把它整个当成一个项目。`,
    detail: [
      reason,
      ...(allowChooseAnother
        ? ['还没有项目文件夹的话，点「新建一个项目文件夹」，会替你建一个空的项目文件夹并直接打开，不用再选、不用起名。']
        : []),
      everyTime
        ? '仍然打开也可以，但不会记住这个文件夹，下次打开还会再提醒你；也不会替你把它标成「可信」或在里面生成项目说明文件。'
        : '仍然打开也可以，只是这一次不会替你把它标成「可信」，也不会在里面生成项目说明文件（AGENTS.md）——那份说明会对它下面的所有项目生效。',
    ].join('\n\n'),
    ...(allowChooseAnother
      ? {
        // 客户多是新手，少让他做决定：「新建」放第一个并作为默认按钮（回车即选，
        // macOS 上是高亮的那个），另外两个退成次要。
        buttons: ['新建一个项目文件夹', '换一个文件夹', '仍然打开'],
        createIndex: 0,
        cancelIndex: 1,
        continueIndex: 2,
      }
      : {
        buttons: ['先不打开', '仍然打开'],
        createIndex: null,
        cancelIndex: 0,
        continueIndex: 1,
      }),
  }
}
