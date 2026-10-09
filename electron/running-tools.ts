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
  // Mac 上没有「帮我重开」，只点关窗口桌面端还在后台跑、读不到新设置，得说清怎么算关掉（第二十九批 A）。
  if (report.codexDesktopRunning === true && !report.canRestartCodexDesktop) sentences.push('Codex 桌面端只关窗口不算，要在它的窗口里按 Command + Q 完全退出再打开。')
  if (unknown.length) sentences.push(`如果 ${unknown.join('、')} 还开着，${running.length ? '也' : ''}要关掉重开才会${outcome}。`)
  return sentences.join('')
}

/** 界面要不要给「帮我重开」：桌面端确认开着，且这台电脑上能替用户重开。 */
export function offersCodexDesktopRestart(report: RunningToolsReport | null | undefined): boolean {
  return Boolean(report && report.codexDesktopRunning === true && report.canRestartCodexDesktop)
}

/**
 * 连接线路因为连不上换了以后，开着的哪几样要客户重开才会走新线路（xm 三线路 C10、C19）。只列要说的：
 * Claude Code 每次请求都重读配置、codex exec 和生图每次都是新进程，都不用重开，不在这里。
 */
export interface ToolRouteRestartHint {
  /** 这条提示是什么时候出的（毫秒）；渲染层按它只弹一次。 */
  id: number
  codex?: {
    /** Codex 命令行确认开着。 */
    cli: boolean
    /** Codex 桌面端确认开着，按哪个系统说怎么退出；不开或看不出来 = null。 */
    desktop: 'win32' | 'darwin' | null
    /** 能替客户重开桌面端（只有 Windows）。 */
    canRestartDesktop: boolean
  }
  /** launched = 这次运行里从星芒打开过 Gemini 窗口；unknown = 可能开着。 */
  gemini?: 'launched' | 'unknown'
  grok?: 'running' | 'unknown'
}

export const toolRouteRestartHintTitle = '刚才那条连接线路连不上，已经换到另一条。'

/** 提示正文，一样一句。编辑器插件看不出开没开，换了 Codex 就一律提一句「如果…」。 */
export function describeToolRouteRestartHint(hint: ToolRouteRestartHint): string[] {
  const sentences: string[] = []
  if (hint.codex?.cli) sentences.push('Codex 还开着：新建对话就走新线路，已经打开的对话要退出 Codex 再打开。')
  if (hint.codex?.desktop === 'win32') sentences.push('Codex 桌面端还开着：新建对话就走新线路，已经打开的对话要完全退出再打开。')
  if (hint.codex?.desktop === 'darwin') sentences.push('Codex 桌面端还开着：新建对话就走新线路，已经打开的对话要按 Command + Q 完全退出再打开。')
  if (hint.codex) sentences.push('如果在 VS Code 等编辑器里用着 Codex，新建对话就走新线路，已经打开的对话要重新加载窗口。')
  if (hint.gemini === 'launched') sentences.push('从星芒打开的 Gemini 窗口要关掉再打开，才会走新线路。')
  if (hint.gemini === 'unknown') sentences.push('如果 Gemini 还开着，要关掉再打开才会走新线路。')
  if (hint.grok === 'running') sentences.push('Grok 还开着，要退出再打开才会走新线路。')
  if (hint.grok === 'unknown') sentences.push('如果 Grok 还开着，要退出再打开才会走新线路。')
  return sentences
}

/**
 * 改了线路的那几个工具里，哪几个要说一句（C10、C19），说哪一种。Claude Code 每次请求都重读配置，
 * 不在这里；Gemini 从星芒打开过就按「开着」说，命令行进程看得出看不出都一样。
 */
export function toolRouteRestartNeeds(
  rewritten: readonly ProviderId[],
  report: RunningToolsReport,
  options: { geminiLaunched: boolean; platform: NodeJS.Platform },
): Omit<ToolRouteRestartHint, 'id'> {
  const needs: Omit<ToolRouteRestartHint, 'id'> = {}
  if (rewritten.includes('codex')) {
    needs.codex = {
      cli: report.running.includes('codex'),
      desktop: report.codexDesktopRunning === true && (options.platform === 'win32' || options.platform === 'darwin') ? options.platform : null,
      canRestartDesktop: report.canRestartCodexDesktop,
    }
  }
  if (rewritten.includes('gemini')) {
    if (options.geminiLaunched) needs.gemini = 'launched'
    else if (report.running.includes('gemini') || report.unknown.includes('gemini')) needs.gemini = 'unknown'
  }
  if (rewritten.includes('grok')) {
    if (report.running.includes('grok')) needs.grok = 'running'
    else if (report.unknown.includes('grok')) needs.grok = 'unknown'
  }
  return needs
}

/** 提示里要不要给「帮我重开」：桌面端确认开着，且这台电脑上能替客户重开。 */
export function offersToolRouteDesktopRestart(hint: ToolRouteRestartHint | null | undefined): boolean {
  return Boolean(hint?.codex?.desktop && hint.codex.canRestartDesktop)
}
