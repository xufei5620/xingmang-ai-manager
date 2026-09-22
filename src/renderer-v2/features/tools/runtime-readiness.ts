import type { PlatformCapabilities, SystemSnapshot } from '../../../../electron/ipc-contract'
import { minimumSupportedNodeVersion } from '../../../../electron/versions'

type RuntimeSnapshot = SystemSnapshot['runtime']
type InstallManagement = PlatformCapabilities['nodeRuntimeInstall']

/**
 * The scan reports `tooOld: false` when it cannot read the version string at
 * all: a self-built or patched Node answers `node -v` with something the
 * parser misses, which lands as `versionStatus: 'unknown'` instead of
 * 'too-old'. `versionStatus` is therefore the only field that tells a
 * supported runtime apart from an unreadable one, and the main process already
 * decides by it (system-service.ts). Judging by `tooOld` alone told those users
 * the runtime was ready and then dropped them into an `npm i -g` that fails
 * with no explanation (R-G6).
 */
export function nodeRuntimeReady(runtime: RuntimeSnapshot): boolean {
  return Boolean(runtime.node.installed)
    && runtime.node.tooOld !== true
    && runtime.node.versionStatus !== 'unknown'
    && Boolean(runtime.npm.installed)
}

/** 拦住安装时要说清拦在哪一步，否则用户只看到一个不能点的按钮。 */
export function cliRuntimeBlockMessage(runtime: RuntimeSnapshot): string | null {
  if (nodeRuntimeReady(runtime)) return null
  if (!runtime.node.installed || !runtime.npm.installed) {
    return '请先准备 Node.js 运行环境，再安装命令行工具。'
  }
  if (runtime.node.tooOld === true || runtime.node.versionStatus === 'too-old') {
    return `Node.js 版本过低（当前 ${runtime.node.version ?? '未知'}），请升级到 v${minimumSupportedNodeVersion.major} 或更高版本，再安装命令行工具。`
  }
  return '已检测到 Node.js，但版本无法识别。请按首页运行环境卡里的步骤重新装一遍，再安装命令行工具。'
}

export function pythonRuntimeReady(runtime: RuntimeSnapshot): boolean {
  return Boolean(runtime.python.installed) && !runtime.python.detectionFailed
}

export type InstallRuntimeId = 'node' | 'python'

export interface CliInstallPlan {
  /** 装工具之前要先代装的运行环境，按顺序跑。 */
  prepare: InstallRuntimeId[]
  /** 这台电脑上应用代装不了、又缺着的时候，说清拦在哪一步。 */
  blocked: string | null
}

/**
 * 以前缺 Node.js 时「安装」直接报错，用户得先去点运行环境那颗按钮、等它装完，
 * 再回来点一次「安装」，Gemini 还要多点一次 Python（第十一批 2）。能代装的平台
 * （Windows，platform-capabilities 的 'managed'）把缺的环境排进同一次安装里；
 * 代装不了的平台（macOS）仍旧拦下，由运行环境卡给出装法。版本过低、版本认不出
 * 同样归「缺」：重新准备一遍就是修法，用户不需要知道 PATH 是什么。
 */
export function planCliInstall(input: {
  runtime: RuntimeSnapshot
  needsPython: boolean
  nodeInstall: InstallManagement | undefined
  pythonInstall: InstallManagement | undefined
}): CliInstallPlan {
  const prepare: InstallRuntimeId[] = []
  if (!nodeRuntimeReady(input.runtime)) {
    if (input.nodeInstall !== 'managed') return { prepare: [], blocked: cliRuntimeBlockMessage(input.runtime) }
    prepare.push('node')
  }
  if (input.needsPython && !pythonRuntimeReady(input.runtime)) {
    if (input.pythonInstall !== 'managed') return { prepare: [], blocked: 'Gemini 还需要 Python 环境。请先在运行环境卡中准备 Python，再安装工具。' }
    prepare.push('python')
  }
  return { prepare, blocked: null }
}

/** 串起来的安装里每一段在工具行上的那句话：让用户知道现在在第几步、一共几步。 */
export function cliInstallStageLabel(stage: InstallRuntimeId | 'tool', index: number, total: number, toolName: string): string {
  const what = stage === 'node' ? '正在准备 Node.js 运行环境' : stage === 'python' ? '正在准备 Python 运行环境' : `正在安装 ${toolName}`
  return `${what}（${index + 1}/${total}）`
}

/**
 * 运行环境那一段失败时，前缀要让人一眼分清「环境没装上」还是「工具没装上」；
 * 主进程原话留在后面，错误分类（下载超时、磁盘满……）照旧认得出来。
 */
export function runtimeStageFailureMessage(runtime: InstallRuntimeId, toolName: string, detail: string): string {
  const name = runtime === 'node' ? 'Node.js' : 'Python'
  return `${name} 运行环境没装上，${toolName} 还没开始安装。${detail}`.trim()
}
