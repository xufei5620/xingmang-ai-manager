// 卸载命令行工具（Claude Code、Codex、Grok）的那一段（#1070 第 3 步，从 system-service.ts 的 createSystemService 原样
// 搬来）：按安装来源定卸法（npm 包、官方安装器装的 Claude Code、Grok 原生程序，Mac 上先核 xAI 签名再删）、卸之前
// 看工具是不是还开着、卸完核对命令真的没了、记下删不掉的文件供「帮我清理」用。
//
// 各簇共用的那份在 system-service-context.ts；归首页检测和 Codex 型号名单的几样由 createSystemService 传进来
// （CliUninstallServiceDependencies）。这里只 import system-service.ts 的类型。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cliCatalog, type ProviderId } from './catalog'
import { isChineseSentence } from './chinese-sentence'
import {
  buildClaudeNativeLayout,
  buildClaudeRetainedFiles,
  buildClaudeRetainedVersionFilesCommand,
  buildClaudeRetainedVersionFilesReason,
  type ClaudeRetainedFiles,
  uninstallVerifiedClaudeNativeInstallation,
} from './claude-native-uninstall'
import {
  commandEnvironment,
  findExecutable,
  redactCommandText,
  runCommand,
  trustedCommandEnvironment,
} from './command-runner'
import { isDarwinForeignWritablePath } from './darwin-path-trust'
import { npmFailureSentence, npmSourceFailure } from './failure-wording'
import {
  buildLinuxGrokRetainedFilesCommand,
  buildLinuxGrokRetainedFilesReason,
  uninstallVerifiedLinuxGrokInstallation,
} from './linux-grok'
import {
  listDarwinGrokHistoricalQuarantineFiles,
  listDarwinGrokOrphanedDownloads,
  verifyDarwinGrokUninstallPlan,
} from './macos-grok'
import { createManagedNpmCache, ensureManagedNpmLayout } from './managed-cli'
import { managedNativeProviderRoot } from './managed-cli-paths'
import { uninstallVerifiedNativeCliFiles } from './native-cli-uninstall'
import { describeNpmUninstallFailure, isNpmExitFailure } from './npm-command-failure'
import { redactHomeDirectory } from './startup-log'
import type { CliLeftoverCleanupResult, CliUninstallOptions, ToolStatus, ToolUninstallResult } from './system-service'
import { buildDarwinTrustedVerificationRunner, type ServiceContext } from './system-service-context'
import { type CliInstallation, cliUninstallCapability, findNpmExecutable } from './tool-installation'
import {
  captureUninstallLeftovers,
  removeUninstallLeftovers,
  type UninstallLeftover,
  type UninstallLeftoverOptions,
} from './uninstall-leftovers'
import { launchUnelevatedCommandWindow } from './windows-elevation'
import { resolveWindowsMachinePaths } from './windows-machine-paths'

export interface UninstallVerifiedDarwinGrokInstallationOptions {
  homeDirectory: string
  installDirectory: string
  runCommand: (
    spec: { executable: string; argv: readonly string[] },
  ) => Promise<{ stdout: string; stderr: string }>
}

/** Single-quotes a path so a copied command pastes safely even if $HOME contains spaces or quotes. */
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function formatMebibytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MiB`
}

/** One rm -f target per line so the copy-command dialog's <pre> block stays readable for more than a couple of paths. */
function buildDarwinGrokCleanupCommand(paths: readonly string[]): string {
  const quoted = paths.map(shellSingleQuote)
  if (quoted.length <= 1) return `rm -f ${quoted[0] ?? ''}`
  return [
    'rm -f \\',
    ...quoted.map((value, index) => `  ${value}${index < quoted.length - 1 ? ' \\' : ''}`),
  ].join('\n')
}

/**
 * internal #18: on darwin, uninstallVerifiedNativeCliFiles never deletes a
 * quarantined symlink's renamed file (Node has no inode-bound unlink on
 * macOS — see its comment at the retainedQuarantineFiles push), so every
 * darwin Grok uninstall ends up here; this is the routine last step, not a
 * rare edge case. grokManualUninstallResult recognizes this type to hand back
 * a fully re-verified, ready-to-run manualCommand instead of the generic null
 * it falls back to for an actual security-verification failure, where no
 * command can safely be guessed.
 */
export class DarwinGrokRetainedPathsError extends Error {
  readonly manualCommand: string
  /** Exactly the paths manualCommand names, for the 「帮我清理」 record. */
  readonly retainedPaths: readonly string[]

  constructor(message: string, manualCommand: string, retainedPaths: readonly string[]) {
    super(message)
    this.name = 'DarwinGrokRetainedPathsError'
    this.manualCommand = manualCommand
    this.retainedPaths = retainedPaths
  }
}

/** Verifies the official link layout, then removes only the exact planned links. */
export async function uninstallVerifiedDarwinGrokInstallation(
  options: UninstallVerifiedDarwinGrokInstallationOptions,
) {
  const plan = await verifyDarwinGrokUninstallPlan({
    homeDirectory: options.homeDirectory,
    runCommand: options.runCommand,
  })
  if (!plan.expectedSymbolicLinks.grok) {
    throw new Error('Grok automatic uninstall requires a verified grok symbolic link; use the official manual uninstall instructions')
  }
  // internal #16: agent is best-effort here, not required. Installs made
  // before ensureDarwinGrokAgentLink existed (or a user who removed the link
  // by hand) can legitimately lack it, and uninstalling grok alone still
  // leaves a consistent, fully-uninstalled state — so a missing agent only
  // narrows what gets removed instead of blocking the whole operation.
  // verifyDarwinGrokUninstallPlan above already fully re-verified whichever
  // links are actually present; this just decides which ones to act on.
  const hasAgentLink = Boolean(plan.expectedSymbolicLinks.agent)
  const result = await uninstallVerifiedNativeCliFiles({
    actualDirectory: options.installDirectory,
    expectedDirectory: plan.directory,
    expectedDirectoryIdentity: plan.directoryIdentity,
    fileNames: hasAgentLink ? ['grok', 'agent'] : ['grok'],
    label: 'Grok CLI',
    platform: 'darwin',
    expectedSymbolicLinks: plan.expectedSymbolicLinks,
    expectedSymbolicLinkIdentities: plan.expectedSymbolicLinkIdentities,
    expectedSymbolicLinkRootDirectory: plan.rootDirectory,
    expectedSymbolicLinkRootDirectoryIdentity: plan.rootDirectoryIdentity,
    expectedResolvedSymbolicLinkTargets: plan.expectedResolvedSymbolicLinkTargets,
    expectedOwnerUid: plan.expectedOwnerUid,
    removeDirectoryWhenEmpty: false,
  })
  // internal #16 (real-hardware regression): grok and agent can resolve to
  // the exact same underlying binary once both links target the same
  // release, so summing every entry in expectedResolvedSymbolicLinkTargets
  // without deduping double-counted that one shared file's size (measured
  // 251 MiB reported for a 125.7 MiB binary). These are already realpath'd
  // absolute paths, so plain string-identity dedup is exact.
  const retainedProgramPaths = [...new Set(
    Object.values(plan.expectedResolvedSymbolicLinkTargets)
      .map((target) => target.path)
      .filter((filePath) => fs.existsSync(filePath)),
  )]
  // internal #20: fold in every earlier round's own leftover .removing files
  // too — see listDarwinGrokHistoricalQuarantineFiles for why a name match
  // alone is trustworthy here. Excluding this round's own paths keeps the
  // variable's name honest; the Set below would dedupe them either way.
  const currentQuarantineFiles = new Set(result.retainedQuarantineFiles)
  const historicalQuarantineFiles = listDarwinGrokHistoricalQuarantineFiles(options.homeDirectory)
    .filter((filePath) => !currentQuarantineFiles.has(filePath))
  const retainedPaths = [...new Set([
    ...result.retainedQuarantineFiles,
    ...retainedProgramPaths,
    ...historicalQuarantineFiles,
  ])]
  if (retainedPaths.length > 0) {
    const displayPath = (filePath: string) => `~/.grok/${path.relative(plan.rootDirectory, filePath)}`
    // Quarantine paths (this round's and historical) are deliberately left
    // out of this sum: they are this app's own tiny renamed symlinks, not
    // the "程序文件" this figure describes, and a quarantine symlink's target
    // text still resolves after the rename — summing it too would reopen
    // this same function's #16 double-count across rounds that happened to
    // reinstall the same release.
    const retainedBytes = retainedProgramPaths.reduce((total, filePath) => {
      try {
        return total + fs.statSync(filePath).size
      } catch {
        return total
      }
    }, 0)
    const messageParts = [
      'Grok CLI 命令入口已移除，但自动卸载未完整完成。',
      `为避免 macOS 按路径删除时误删被并发替换的文件，以下 ${retainedPaths.length} 个文件未自动删除：`,
      retainedPaths.map(displayPath).join('；'),
      retainedBytes > 0 ? `（其中程序文件共约 ${formatMebibytes(retainedBytes)}）。` : '。',
      historicalQuarantineFiles.length > 0
        ? `它们包含本次卸载的符号链接改名残留、已失去命令入口的旧程序文件，以及 ${historicalQuarantineFiles.length} 个以前几次卸载遗留的隔离文件；Grok 命令已不可用，确认没有进程占用后即可删除，下方是可直接复制执行的清理命令。`
        : '它们是卸载时符号链接改名后的残留、以及已失去命令入口的旧程序文件；Grok 命令已不可用，确认没有进程占用后即可删除，下方是可直接复制执行的清理命令。',
    ]
    // internal #18: these accumulate silently across every version this
    // machine has ever installed — mention them so a user cleaning up notices
    // them, without ever deleting them ourselves (out of scope for #18).
    const orphans = listDarwinGrokOrphanedDownloads(options.homeDirectory, retainedProgramPaths)
    if (orphans.length > 0) {
      const orphanBytes = orphans.reduce((total, orphan) => total + orphan.size, 0)
      const orphanNames = orphans.slice(0, 5).map((orphan) => path.basename(orphan.path))
      const orphanNamesText = orphans.length > 5 ? `${orphanNames.join('；')} 等` : orphanNames.join('；')
      messageParts.push(
        `另在 ~/.grok/downloads/ 检测到 ${orphans.length} 个未被当前 grok/agent 引用的历史版本安装包`
          + `（共约 ${formatMebibytes(orphanBytes)}：${orphanNamesText}），如确认不再需要可一并手动清理，本工具不会自动删除它们。`,
      )
    }
    throw new DarwinGrokRetainedPathsError(messageParts.join(''), buildDarwinGrokCleanupCommand(retainedPaths), retainedPaths)
  }
  return result
}

export function grokManualUninstallResult(
  previousVersion: string | null,
  error: unknown,
): Extract<ToolUninstallResult, { outcome: 'manual-required' }> {
  if (error instanceof DarwinGrokRetainedPathsError) {
    // Built entirely in-house from a small, already-bounded set of verified
    // paths (the orphan list above is itself capped for display), unlike an
    // arbitrary caught Error, so this skips the generic control-character
    // stripping below and keeps more of its own text. The command itself
    // always comes straight from the error's own property, never from this
    // truncated string, so a long reason can never truncate mid-path.
    const reason = error.message.trim().slice(0, 2000) || 'Grok CLI 自动卸载安全验证失败'
    return {
      outcome: 'manual-required',
      previousVersion,
      error: reason,
      manualHelp: {
        reason,
        manualCommand: error.manualCommand,
      },
    }
  }
  const fallback = 'Grok CLI 自动卸载安全验证失败'
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500)
  return {
    outcome: 'manual-required',
    previousVersion,
    // 原话留在这里，卸载日志记的就是它。
    error: message || fallback,
    manualHelp: {
      // 安全核对里不少是英文原话（链接、目录不合规矩的那几句），Mac 上卸不了时整句英文上屏（已知48）。
      // 英文只进日志，屏上换成现成的那句；中文原话照旧接在后面。
      reason: message && isChineseSentence(message) ? `自动卸载安全验证失败：${message}` : fallback,
      manualCommand: null,
    },
  }
}

export type CliUninstallPlan =
  | {
      kind: 'npm-uninstall'
      executable: string
      argv: string[]
      windowsPackageManager: 'npm'
      packageRoot: string
    }
  | { kind: 'grok-native' | 'claude-native' }

export function buildCliUninstallPlan(
  provider: ProviderId,
  installation: CliInstallation,
  npmExecutable: string | null,
): CliUninstallPlan {
  if (installation.source === 'npm' && installation.packageRoot) {
    if (!npmExecutable || !installation.npmPrefix) {
      throw new Error(`无法确定 ${cliCatalog[provider].name} 所属的 npm 和安装前缀`)
    }
    return {
      kind: 'npm-uninstall',
      executable: npmExecutable,
      argv: [
        'uninstall',
        '--global',
        `--prefix=${installation.npmPrefix}`,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        cliCatalog[provider].packageName,
      ],
      windowsPackageManager: 'npm',
      packageRoot: installation.packageRoot,
    }
  }
  if (provider === 'grok' && installation.source === 'native') return { kind: 'grok-native' }
  if (provider === 'claude' && installation.source === 'native') return { kind: 'claude-native' }
  throw new Error(`当前 ${cliCatalog[provider].name} 不是 npm 安装，无法确认安全卸载方式`)
}

/** 卸载要用、但归首页检测和 Codex 型号名单那两块管的几样，由 createSystemService 传进来。 */
export interface CliUninstallServiceDependencies {
  inspectCliTool: (
    provider: ProviderId,
    npmExecutable?: string | null,
    npmGlobalRoot?: string | null,
    executablePath?: string | null,
  ) => Promise<{ status: ToolStatus; installation: CliInstallation | null }>
  invalidateCliUpdateCache: (provider: ProviderId) => void
  /** 卸了 Codex 以后，核型号名单时要重新找它在哪。 */
  forgetCodexModelCatalogReaders: () => void
}

export function createCliUninstallService(context: ServiceContext, dependencies: CliUninstallServiceDependencies) {
  const {
    windowsExecutionMode, platform, providerRoots, runtimeLog, executeCommand, installing, installationQueue,
    assertInstallDiskSpace, findInstalledExecutable, resolveServiceNpmGlobalRoot, isManagedNpmInstallation,
    cliTerminalAccess, describeOccupiedCliFailure,
  } = context
  const {
    inspectCliTool,
    invalidateCliUpdateCache,
    forgetCodexModelCatalogReaders,
  } = dependencies

  /** 返回命令入口已经删掉、但没能删掉的程序文件（只有 Linux 会有）。 */
  async function uninstallNativeGrok(installation: CliInstallation): Promise<string[]> {
    const cliEnvironment = commandEnvironment()
    const homeDirectory = cliEnvironment.HOME?.trim() || os.homedir()
    const userDirectory = path.resolve(homeDirectory, '.grok', 'bin')
    if (platform === 'darwin') {
      await uninstallVerifiedDarwinGrokInstallation({
        homeDirectory,
        installDirectory: installation.installDirectory,
        runCommand: buildDarwinTrustedVerificationRunner(executeCommand),
      })
      return []
    }
    if (platform === 'linux') {
      // npm postinstall 留下的是指向 grok-<版本> 的链接，按普通文件卸会被拒（Linux 版拆分 ③）。
      const result = await uninstallVerifiedLinuxGrokInstallation({
        homeDirectory,
        installDirectory: installation.installDirectory,
      })
      return result.retainedFiles
    }
    const managedDirectory = process.platform === 'win32'
      ? path.resolve(managedNativeProviderRoot('grok'))
      : null
    const actualKey = path.resolve(installation.installDirectory).toLowerCase()
    const managed = Boolean(managedDirectory && actualKey === managedDirectory.toLowerCase())
    const expectedDirectory = managed ? managedDirectory! : userDirectory
    const result = await uninstallVerifiedNativeCliFiles({
      actualDirectory: installation.installDirectory,
      expectedDirectory,
      fileNames: process.platform === 'win32'
        ? ['grok.exe', 'agent.exe', 'version.json']
        : ['grok', 'agent'],
      label: 'Grok CLI',
      platform: process.platform,
    })
    // 官方安装脚本把 ~/.grok/bin 加进了当前用户的 PATH，卸完顺手拿掉。程序文件这时已经删完，所以不等它、
    // 也不算进卸载结果：以前等着它、只给 8 秒，慢机器上 PowerShell 冷启动一超时就把卸完的说成失败（已知48）。
    if (!managed) cliTerminalAccess.forgetUserPath('grok', result.directory)
    return []
  }

  // Q14：官方脚本装的 ~/.local/bin/claude 在 macOS/Linux 上是指向
  // ~/.local/share/claude/versions/<版本> 的符号链接，旧实现按普通文件校验直接拒绝；
  // 两个平台也都把 versions 里的程序本体留在了磁盘上。
  async function uninstallNativeClaude(installation: CliInstallation): Promise<ClaudeRetainedFiles> {
    const result = await uninstallVerifiedClaudeNativeInstallation({
      homeDirectory: os.homedir(),
      installDirectory: installation.installDirectory,
      platform: process.platform,
    })
    return buildClaudeRetainedFiles(result, process.platform)
  }

  // 「帮我清理」只删卸载那一刻记下的文件（已知48）：界面只说是哪个工具，路径永远由这里给，
  // 不收界面传来的。下一次卸这个工具时清掉，清干净了也清掉。
  const uninstallLeftovers = new Map<ProviderId, UninstallLeftover[]>()

  function uninstallLeftoverOptions(): UninstallLeftoverOptions {
    return {
      platform: process.platform,
      ownerUid: process.platform === 'win32' ? undefined : process.getuid?.(),
      // Mac 上卸载本来不按路径删改名后的链接，「帮我清理」要删（yoyo 2026-10-06「Mac 也帮我清理」）：
      // 只在别的账户改不了的目录里删，核对和删除之间就只剩客户自己能动它。
      isForeignWritableDirectory: process.platform === 'darwin'
        ? (directory) => isDarwinForeignWritablePath(directory)
        : undefined,
    }
  }

  /** 记下这次卸载留下的文件；一个都核对不了就不记，界面也就不给「帮我清理」。 */
  function rememberUninstallLeftovers(provider: ProviderId, filePaths: readonly string[]): boolean {
    const leftovers = captureUninstallLeftovers(filePaths, uninstallLeftoverOptions())
    if (!leftovers.some((leftover) => leftover.kind === 'pinned')) {
      uninstallLeftovers.delete(provider)
      return false
    }
    uninstallLeftovers.set(provider, leftovers)
    return true
  }

  /**
   * 这个工具重新装上后会运行的那个文件。Grok 的 npm 安装脚本见到同版本的 grok-<版本> 已经在
   * ~/.grok/bin 里就直接沿用、只把链接指回去，卸载时记下的程序文件就又成了正在用的那一份。
   */
  function liveCommandLinks(provider: ProviderId): string[] {
    // 卸载 Grok 时按 HOME 找、Linux 上还先解开主目录的链接（同 npm 安装脚本），这里几种写法都看。
    const homes = new Set<string>()
    for (const home of [commandEnvironment().HOME?.trim() || os.homedir(), os.homedir()]) {
      homes.add(home)
      try {
        homes.add(fs.realpathSync(home))
      } catch {
        // 主目录读不了就只按原样找。
      }
    }
    return [...homes].flatMap((home) => {
      if (provider === 'claude') return [buildClaudeNativeLayout(home, process.platform).commandPath]
      if (provider === 'grok') return ['grok', 'agent'].map((name) => path.join(home, '.grok', 'bin', name))
      return []
    })
  }

  function cleanUninstallLeftovers(provider: ProviderId): Promise<CliLeftoverCleanupResult> {
    // 和卸载、安装排同一个队：删的是工具目录里的文件，不能和正在装的那一份同时动。
    return installationQueue.enqueue(`cli:clean-leftovers:${provider}`, async () => {
      const leftovers = uninstallLeftovers.get(provider)
      // 界面只在卸载记下了文件时给「帮我清理」，清干净以后框就关了；走到这里只会是连点。
      if (!leftovers) return { remaining: 0 }
      const cleanup = await removeUninstallLeftovers(leftovers, {
        ...uninstallLeftoverOptions(),
        liveCommandLinks: liveCommandLinks(provider),
      })
      if (cleanup.kept.length > 0) uninstallLeftovers.set(provider, cleanup.kept.map((entry) => entry.leftover))
      else uninstallLeftovers.delete(provider)
      if (cleanup.kept.length > 0 || cleanup.reused > 0) {
        runtimeLog?.log(cleanup.kept.length > 0 ? 'warn' : 'info', 'install', 'cli.uninstall-leftovers.cleaned',
          `${cliCatalog[provider].name} 卸载残留删掉 ${cleanup.removed} 个，还剩 ${cleanup.kept.length} 个`, {
            provider,
            removed: cleanup.removed,
            reused: cleanup.reused,
            kept: cleanup.kept.map((entry) => ({
              file: redactHomeDirectory(entry.leftover.path, providerRoots.userHome),
              reason: entry.reason,
              ...(entry.code ? { code: entry.code } : {}),
            })),
          })
      }
      return { remaining: cleanup.kept.length }
    })
  }

  async function uninstallCliOperation(provider: ProviderId, options: CliUninstallOptions = {}): Promise<ToolUninstallResult> {
    if (installing.has(provider)) throw new Error(`${cliCatalog[provider].name} 正在安装、更新或卸载中`)
    installing.add(provider)
    uninstallLeftovers.delete(provider)
    try {
      // 同 inspectCliUpdate：卸载只用得上 npm 在哪，不为它的版本号多起一次 `npm --version`。
      const npmPath = await findInstalledExecutable('npm')
      const npmGlobalRoot = await resolveServiceNpmGlobalRoot(npmPath)
      const initial = await inspectCliTool(provider, npmPath, npmGlobalRoot)
      if (!initial.status.installed || !initial.installation) {
        return { outcome: 'not-installed', previousVersion: null }
      }
      // 和装的时候问同一句、用同一个门槛（installCliOperation），只是提前到动手卸之前。
      if (options.reinstall) await assertInstallDiskSpace(`${cliCatalog[provider].name} 安装失败`)
      let current = initial
      const removedInstallations: string[] = []
      const retainedClaudeCommandFiles: string[] = []
      const retainedClaudeVersionFiles: string[] = []
      const retainedGrokFiles: string[] = []
      for (let attempt = 0; attempt < 8 && current.installation; attempt += 1) {
        const installation = current.installation
        const uninstall = current.status.uninstall
          ?? cliUninstallCapability(provider, installation, { platform, windowsExecutionMode })
        if (!uninstall.available) {
          throw new Error([
            uninstall.reason,
            uninstall.manualCommand ? `请在${platform === 'win32' ? '普通 PowerShell' : '终端'}中运行：${uninstall.manualCommand}` : null,
          ].filter(Boolean).join('；'))
        }
        if (uninstall.delegated) {
          // 包自带的卸载脚本位于用户可写目录，绝不能拿主进程的管理员令牌去跑。
          if (!uninstall.manualCommand) throw new Error('缺少可执行的卸载命令')
          const name = cliCatalog[provider].name
          await launchUnelevatedCommandWindow({
            commandLine: uninstall.manualCommand,
            // 窗口里的字说中文（已知33）；中间卸载程序自己吐的几行还是英文。
            text: {
              title: `星芒：卸载 ${name}`,
              running: `正在卸载 ${name}，请稍等，别关这个窗口。`,
              succeeded: '卸载完成。现在可以关掉这个窗口，回星芒点「重新检测」。',
              failed: '卸载没有完成（错误代码 {code}）。关掉这个窗口，回星芒点「重新检测」看看；还不行请找客服。',
            },
            machinePaths: resolveWindowsMachinePaths(),
          })
          return { outcome: 'delegated', previousVersion: initial.status.version }
        }
        const managedInstallation = isManagedNpmInstallation(installation)
        // isManagedNpmInstallation admits darwin, but the trusted resolution below is
        // Windows-only in effect: findExecutable drops additionalPaths on the trusted
        // branch, and the darwin trusted PATH is whatever the caller inherited — for a
        // Finder-launched build that is launchd's, which contains no npm. The managed
        // uninstall then failed to resolve npm at all. The sibling call twelve lines
        // below already gates on win32; this one now matches it.
        const npmExecutable = managedInstallation && platform === 'win32'
          ? await findExecutable('npm', {
              env: trustedCommandEnvironment(),
              windowsPackageManagers: ['npm'],
              trustedOnly: true,
            })
          : await findNpmExecutable(commandEnvironment(), [installation.commandPath])
            ?? npmPath
        const plan = buildCliUninstallPlan(provider, installation, npmExecutable)
        if (plan.kind === 'npm-uninstall') {
          const layout = managedInstallation ? await ensureManagedNpmLayout() : null
          const cache = layout ? await createManagedNpmCache(layout) : null
          try {
            const trustedOnly = process.platform === 'win32' && windowsExecutionMode === 'trusted-only'
            await runCommand({
              executable: plan.executable,
              argv: layout && cache
                ? [
                    ...plan.argv,
                    `--cache=${cache}`,
                    `--userconfig=${layout.userConfig}`,
                    '--audit=false',
                    '--fund=false',
                  ]
                : plan.argv,
              windowsPackageManager: plan.windowsPackageManager,
            }, {
              env: trustedOnly ? trustedCommandEnvironment() : commandEnvironment(),
              trustedOnly,
              trustedPaths: layout && cache ? [layout.userConfig, cache] : undefined,
              timeoutMs: 2 * 60_000,
              maxOutputBytes: 4 * 1024 * 1024,
            })
          } catch (error) {
            // 工具开着时 Windows 锁着它自己的文件，npm 挪不开包目录，报 EPERM / EBUSY 后原样退回。
            // 原话只剩「命令执行失败（退出码 1）：node.exe」，客户看不出是工具开着（第三十三批 C），
            // 所以和安装、更新一样接上 npm 的要点，再数一遍这个工具的进程。cause 用 Object.assign
            // 挂成可枚举的：运行日志只记错误的可枚举字段（runtime-log.ts 的 sanitizeValue），
            // npm 的原始输出要跟着进日志给客服看。
            // Mac 不数：那边挪得动、删得掉正开着的程序文件，EPERM / EACCES 只会是权限不够（比如
            // 用 sudo 装进 /usr/local 的那份），这时数到进程就会叫客户去关窗口，关了照样卸不掉。
            // Linux 的进程检测本来就回 unsupported。
            const detail = describeNpmUninstallFailure(error)
            const occupied = await describeOccupiedCliFailure(
              provider,
              detail,
              detail,
              platform === 'darwin' ? null : plan.packageRoot,
              '卸载',
            )
            // 不是开着的话只说中文原因和错误码（EPERM、EACCES 说成文件删不掉），原话照旧在 cause 里（#1100 第1条）。
            const reason = npmSourceFailure(redactCommandText(detail), { commandFailed: isNpmExitFailure(error), uninstall: true })
            throw Object.assign(new Error(occupied ?? npmFailureSentence(`${cliCatalog[provider].name} 卸载失败：`, [{ reason }])), { cause: error })
          } finally {
            if (cache) await fs.promises.rm(cache, { recursive: true, force: true }).catch(() => undefined)
          }
          if (fs.existsSync(plan.packageRoot)) {
            throw new Error(`${cliCatalog[provider].name} 的 npm 包目录仍然存在，卸载未完成`)
          }
        } else if (plan.kind === 'grok-native') {
          try {
            retainedGrokFiles.push(...await uninstallNativeGrok(installation))
          } catch (error) {
            // Linux 和 macOS 一样：安全核对没过就交给客户手动卸，并说清为什么。
            if (platform === 'darwin' || platform === 'linux') {
              const manual = grokManualUninstallResult(initial.status.version, error)
              // Mac 上每次都走到这里：命令入口删了，改名后的链接和程序文件按规矩留着。
              if (!(error instanceof DarwinGrokRetainedPathsError) || !rememberUninstallLeftovers(provider, error.retainedPaths)) {
                return manual
              }
              return { ...manual, manualHelp: { ...manual.manualHelp, cleanUpAvailable: true } }
            }
            throw error
          }
        } else {
          const retained = await uninstallNativeClaude(installation)
          retainedClaudeCommandFiles.push(...retained.commandFiles)
          retainedClaudeVersionFiles.push(...retained.versionFiles)
        }
        removedInstallations.push(installation.installDirectory)
        current = await inspectCliTool(provider, npmPath, npmGlobalRoot)
      }
      if (current.status.installed) {
        const removed = removedInstallations.length
          ? `已移除 ${removedInstallations.length} 个安装：${removedInstallations.join('；')}。`
          : '未移除任何安装。'
        const remaining = current.installation?.installDirectory ?? current.status.path ?? '未知目录'
        throw new Error(`${removed}仍检测到 ${cliCatalog[provider].name}：${remaining}`)
      }
      invalidateCliUpdateCache(provider)
      // Linux：删掉这个工具的小启动器，星芒装的一个都不剩时把终端启动设置里加的几行也去掉。
      void cliTerminalAccess.release(provider)
      const retainedReason = buildClaudeRetainedVersionFilesReason(
        retainedClaudeVersionFiles,
        process.platform,
        retainedClaudeCommandFiles,
      )
      if (retainedReason) {
        const retainedClaudeFiles = [...retainedClaudeCommandFiles, ...retainedClaudeVersionFiles]
        const cleanUpAvailable = rememberUninstallLeftovers(provider, retainedClaudeFiles)
        return {
          outcome: 'manual-required',
          previousVersion: initial.status.version,
          error: retainedReason,
          manualHelp: {
            reason: retainedReason,
            manualCommand: buildClaudeRetainedVersionFilesCommand(retainedClaudeFiles, process.platform),
            ...(cleanUpAvailable ? { cleanUpAvailable } : {}),
          },
        }
      }
      const retainedGrokReason = buildLinuxGrokRetainedFilesReason(retainedGrokFiles)
      if (retainedGrokReason) {
        const cleanUpAvailable = rememberUninstallLeftovers(provider, retainedGrokFiles)
        return {
          outcome: 'manual-required',
          previousVersion: initial.status.version,
          error: retainedGrokReason,
          manualHelp: {
            reason: retainedGrokReason,
            manualCommand: buildLinuxGrokRetainedFilesCommand(retainedGrokFiles),
            ...(cleanUpAvailable ? { cleanUpAvailable } : {}),
          },
        }
      }
      return { outcome: 'uninstalled', previousVersion: initial.status.version }
    } finally {
      installing.delete(provider)
    }
  }

  function uninstallCli(provider: ProviderId, options: CliUninstallOptions = {}): Promise<ToolUninstallResult> {
    const finished = installationQueue.enqueue(`cli:uninstall:${provider}`, () => uninstallCliOperation(provider, options))
    // 卸掉命令行不会让谁读不进型号名单，只是下次写名单时要重新看装没装。
    if (provider === 'codex') void finished.then(forgetCodexModelCatalogReaders, forgetCodexModelCatalogReaders)
    return finished
  }

  return { uninstallCli, cleanUninstallLeftovers }
}
