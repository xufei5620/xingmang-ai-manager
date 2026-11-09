import type { PlatformCapabilities, ProviderId, SystemSnapshot } from '../../../../electron/ipc-contract'
import { minimumSupportedNodeVersion } from '../../../../electron/versions'
import { rawErrorMessage } from '../../business-common'

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

// 命令行工具装之前要先代装的只有 Node.js：要 Python 的只有已下线的 Gemini CLI。
export type InstallRuntimeId = 'node'

const installRuntimeNames: Record<InstallRuntimeId, string> = { node: 'Node.js' }

/**
 * Windows 版 Grok 是独立程序，不用 Node.js（platform-capabilities 的 cliNeedsNodeRuntime）。
 * 以前只想装 Grok 的客户也得先等一遍 Node.js 和一次系统管理员确认（第十八批 8）。
 * 主进程没报这张表（旧版本）时按「要」处理，就是原来的行为。
 */
export function cliNeedsNodeRuntime(platform: Pick<PlatformCapabilities, 'cliNeedsNodeRuntime'> | null | undefined, provider: ProviderId): boolean {
  return platform?.cliNeedsNodeRuntime?.[provider] ?? true
}

export interface CliInstallPlan {
  /** 装工具之前要先代装的运行环境，按顺序跑。 */
  prepare: InstallRuntimeId[]
  /** 这台电脑上应用代装不了、又缺着的时候，说清拦在哪一步。 */
  blocked: string | null
}

/**
 * 以前缺 Node.js 时「安装」直接报错，用户得先去点运行环境那颗按钮、等它装完，
 * 再回来点一次「安装」（第十一批 2）。能代装的（platform-capabilities 的 'managed'，
 * Node.js 三个平台都是）把缺的环境排进同一次安装里；代装不了的仍旧拦下，由运行环境卡给出装法。版本过低、
 * 版本认不出同样归「缺」：重新准备一遍就是修法，用户不需要知道 PATH 是什么。Mac 上
 * 客户自己那份太旧时，准备好的那份当场就用上，以后不再重下（第三十四批 A）。
 */
export function planCliInstall(input: {
  runtime: RuntimeSnapshot
  /** 缺省 = 要（旧行为）。 */
  needsNode?: boolean
  nodeInstall: InstallManagement | undefined
}): CliInstallPlan {
  const prepare: InstallRuntimeId[] = []
  if (input.needsNode !== false && !nodeRuntimeReady(input.runtime)) {
    if (input.nodeInstall !== 'managed') return { prepare: [], blocked: cliRuntimeBlockMessage(input.runtime) }
    prepare.push('node')
  }
  return { prepare, blocked: null }
}

/** 串起来的安装里每一段在工具行上的那句话：让用户知道现在在第几步、一共几步。 */
export function cliInstallStageLabel(stage: InstallRuntimeId | 'tool', index: number, total: number, toolName: string): string {
  const what = stage === 'tool' ? `正在安装 ${toolName}` : `正在准备 ${installRuntimeNames[stage]} 运行环境`
  return `${what}（${index + 1}/${total}）`
}

/**
 * 装工具前那一段运行环境准备。claim 是「占住运行环境那一行再跑」（首页的 toolbox.run），
 * 占不到说明先点的另一个工具、运行环境卡或「换成新版 Node.js」正在装同一份。以前这里
 * 直接报「运行环境正在准备」，外面再包成「Node.js 运行环境没装上，Codex CLI 还没开始安装」，
 * 新电脑上挨个点两个工具的「安装」，第二个立刻变红，说的跟事实正好相反（并发竞态 BF3）。
 * 主进程按 runtime:node 一个键排队，同一个键复用同一次安装（installation-queue.ts），
 * 所以占不到时再要一次，等到的就是那一次的结果，不会装两遍；那一次刚好已经装完，
 * 再要一次也只是查一下、回「本来就装好了」。这几行任务都不能取消，占不到只会是被占着。
 */
export async function prepareSharedRuntime<T>(
  claim: (work: () => Promise<void>) => Promise<boolean>,
  prepare: () => Promise<T>,
): Promise<T> {
  const done: { result?: { value: T } } = {}
  const claimed = await claim(async () => { done.result = { value: await prepare() } })
  if (claimed && done.result) return done.result.value
  return prepare()
}

/**
 * 运行环境那一段失败时，前缀要让人一眼分清「环境没装上」还是「工具没装上」；
 * 主进程原话留在后面，错误分类（下载超时、磁盘满……）照旧认得出来。
 * 原话要先剥掉 Electron 那层「Error invoking remote method '…': Error:」再接上：
 * 拼进句子中间以后，上屏前的 errorMessage 只剥开头，这串英文就原样进了错误框。
 */
export function runtimeStageFailureMessage(runtime: InstallRuntimeId, toolName: string, cause: unknown): string {
  return `${installRuntimeNames[runtime]} 运行环境没装上，${toolName} 还没开始安装。${rawErrorMessage(cause)}`.trim()
}
