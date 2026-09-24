import { cliCatalog, type ProviderId } from './catalog'
import type { CliProcessProbe } from './cli-process-probe'
import type { CliInstallation } from './tool-installation'

/**
 * 换账号之后，已经开着的 CLI 和 Codex 桌面端还拿着旧 Key（进程启动时读一次配置，
 * 之后只用内存里那份），继续扣的是旧账号的钱。这里只回答「哪几个真的还开着」，
 * 好让提示只对它们说，而不是每次都念一遍「关掉重开」——念多了用户就不看了。
 *
 * 渲染层直接用这里的文案函数，所以本模块只许值引用 catalog 这类零依赖模块，
 * 真正起进程的检测由调用方注入（scripts/verify-renderer-boundary.test.cjs 钉住）。
 */
export interface RunningToolsReport {
  /** 确认还开着的工具。 */
  running: ProviderId[]
  /** 这台电脑上看不出来开没开（进程检测被拒、超时或平台不支持）。 */
  unknown: ProviderId[]
  /** Codex 桌面端还开着；null = 看不出来。没问 Codex 时恒为 false。 */
  codexDesktopRunning: boolean | null
  /** 能不能替用户重开桌面端（只有 Windows 能，Mac 上要用户自己退出再打开）。 */
  canRestartCodexDesktop: boolean
}

export interface RunningToolsProbeDependencies {
  /** 这个工具的进程该按哪些路径认；没装 = 空数组，读不到安装信息就抛错。 */
  probeRoots(provider: ProviderId): Promise<string[]>
  probe(root: string): Promise<CliProcessProbe>
  /** 查 Codex 桌面端是否开着；null = 看不出来。 */
  codexDesktopRunning(): Promise<boolean | null>
  canRestartCodexDesktop: boolean
}

export const emptyRunningToolsReport: RunningToolsReport = {
  running: [], unknown: [], codexDesktopRunning: false, canRestartCodexDesktop: false,
}

/**
 * 进程要按哪几条路径认。npm 装的看包目录（cli-process-probe.ts 为什么不看共享的
 * bin 目录，那边有长注释）；原生二进制没有包目录，就认它自己那个文件。
 *
 * macOS 上多认一条命令文件本身：npm 的 bin 是指向 `#!/usr/bin/env node` 脚本的
 * 链接，从终端敲 `claude` 启动时 ps 里看到的是「node /…/bin/claude」，包目录根本
 * 不出现。Windows 的 .cmd 垫片会把包内脚本的完整路径写进 node 的命令行，不需要。
 * 认的是那一个文件，不是它所在的目录，所以不会把同目录别的工具算进来（ps 那边
 * 按子串比，名字以它开头的另一个命令会被多算一次，代价只是多一句提醒）。
 */
export function cliProcessProbeRoots(installation: CliInstallation | null, platform: NodeJS.Platform): string[] {
  if (!installation) return []
  const roots: string[] = []
  if (installation.packageRoot) roots.push(installation.packageRoot)
  if (!installation.packageRoot || platform === 'darwin') roots.push(installation.commandPath)
  return [...new Set(roots.filter(Boolean))]
}

/**
 * 一个一个查，不并发：Windows 上每次检测都要起一个 PowerShell，低配电脑同时起
 * 四五个会明显卡一下，而换账号之后晚半秒出提示没人在意。检测失败永远不抛，
 * 落到 unknown，由提示改成「如果还开着」的说法。
 */
export async function inspectRunningTools(
  providers: readonly ProviderId[],
  deps: RunningToolsProbeDependencies,
): Promise<RunningToolsReport> {
  const report: RunningToolsReport = {
    running: [], unknown: [], codexDesktopRunning: false, canRestartCodexDesktop: deps.canRestartCodexDesktop,
  }
  for (const provider of [...new Set(providers)]) {
    let roots: string[]
    try {
      roots = await deps.probeRoots(provider)
    } catch {
      report.unknown.push(provider)
      continue
    }
    let verdict: 'running' | 'stopped' | 'unknown' = 'stopped'
    for (const root of roots) {
      const probe = await deps.probe(root)
      if (probe.status === 'checked' && probe.processes.length > 0) { verdict = 'running'; break }
      if (probe.status !== 'checked') verdict = 'unknown'
    }
    if (verdict === 'running') report.running.push(provider)
    else if (verdict === 'unknown') report.unknown.push(provider)
  }
  if (providers.includes('codex')) {
    try {
      report.codexDesktopRunning = await deps.codexDesktopRunning()
    } catch {
      report.codexDesktopRunning = null
    }
  }
  return report
}

/** 提示里说的「换过来」到底换到哪。 */
export type RunningToolsGoal = 'account' | 'official'

/**
 * 只对确认开着的点名；看不出来的用「如果还开着」的说法，不能说成开着，也不能
 * 当成没开就一字不提。都没开就是空串，调用方什么也不补。
 */
export function describeRunningTools(report: RunningToolsReport, goal: RunningToolsGoal): string {
  const outcome = goal === 'official' ? '换回官方账号' : '用上当前账号'
  const running = report.running.map((provider) => cliCatalog[provider].name)
  if (report.codexDesktopRunning === true) running.push('Codex 桌面端')
  const unknown = report.unknown.map((provider) => cliCatalog[provider].name)
  if (report.codexDesktopRunning === null) unknown.push('Codex 桌面端')
  const sentences: string[] = []
  if (running.length) sentences.push(`${running.join('、')} 还开着，要关掉重开才会${outcome}。`)
  if (unknown.length) sentences.push(`如果 ${unknown.join('、')} 还开着，${running.length ? '也' : ''}要关掉重开才会${outcome}。`)
  return sentences.join('')
}

/** 界面要不要给「帮我重开」：桌面端确认开着，且这台电脑上能替用户重开。 */
export function offersCodexDesktopRestart(report: RunningToolsReport | null | undefined): boolean {
  return Boolean(report && report.codexDesktopRunning === true && report.canRestartCodexDesktop)
}
