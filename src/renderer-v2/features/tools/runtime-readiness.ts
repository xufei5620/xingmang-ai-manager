import type { SystemSnapshot } from '../../../../electron/ipc-contract'
import { minimumSupportedNodeVersion } from '../../../../electron/versions'

type RuntimeSnapshot = SystemSnapshot['runtime']

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
  return '已检测到 Node.js，但版本无法识别。请重新安装 Node.js LTS 并确认已加入 PATH，再安装命令行工具。'
}
