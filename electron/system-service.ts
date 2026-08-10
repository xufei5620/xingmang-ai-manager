import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { isIP } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { type AppSettings, type AppSettingsUpdate, AppSettingsStore, type MirrorPolicy } from './app-settings'
import { cliCatalog, providerIds, type ProviderId } from './catalog'
import {
  defaultProviderConfigRoots,
  type ProviderConfigRoots,
} from './codex-home'
import {
  cleanCommandOutput,
  commandEnvironment,
  findExecutable,
  isTrustedHighIntegrityExecutable,
  isUserWritablePath,
  redactCommandText,
  runCommand,
  trustedCommandEnvironment,
  type WindowsPackageManager,
} from './command-runner'
import { isCodexDesktopExecutable } from './codex-desktop'
import {
  createCodexDesktopService,
  desktopUpdateFields,
  type CodexDesktopInstallResult,
} from './codex-desktop-service'
import {
  inspectProviderConfig,
  saveProviderConfig,
  toNativeConfigSummary,
  type NativeConfigSaveMode,
  type NativeConfigSummary,
} from './config-files'
import { parseModelIds } from './models'
import { describeProbeFailure } from './probe-failure'
import {
  cliUninstallCapability,
  findNpmExecutable,
  resolveCliCommand,
  resolveCliInstallation,
  resolveNpmGlobalRoot,
  type CliInstallation,
  type CliUninstallCapability,
} from './tool-installation'
import { isNewerVersion, nodeVersionStatus, type NodeVersionStatus } from './versions'
import {
  installNodeRuntime as installNodeRuntimeLts,
  type NodeRuntimeInstallResult,
} from './node-runtime'
import { InstallationQueue } from './installation-queue'
import {
  assertTrustedElevatedCliCommand,
  launchCliPowerShell,
  launchUnelevatedCommandWindow,
  resolveWindowsPowerShellExecutable,
  type WindowsCliExecutionMode,
} from './windows-elevation'
import { createTrustedTemporaryDirectory } from './trusted-temp'
import { resolveWindowsMachinePaths } from './windows-machine-paths'
import { createManagedNpmCache, ensureManagedNpmLayout, type ManagedNpmLayout } from './managed-cli'
import { managedNativeProviderRoot, managedNpmPrefix } from './managed-cli-paths'
import { fetchGrokStableVersion } from './grok-update'
import { readBoundedUtf8File } from './bounded-file'
import { readBoundedResponseText } from './bounded-response'
import { launchMacosTerminal, type MacosTerminalLaunchPlan } from './macos-platform'
import { relayApiProbeBaseUrl, resolveRelaySite } from './relay-sites'
import {
  ensureDarwinGrokAgentLink,
  inspectDarwinGrokVerifiedSelection,
  listDarwinGrokHistoricalQuarantineFiles,
  listDarwinGrokOrphanedDownloads,
  resolveDarwinGrokCanonicalSelection,
  runDarwinGrokPostInstallTransaction,
  verifyDarwinGrokUninstallPlan,
} from './macos-grok'
import { inspectMacosCodexApp, type MacosCodexAppInfo } from './macos-codex-app'
import { uninstallVerifiedNativeCliFiles } from './native-cli-uninstall'
import { sameLocalPathIdentity } from './path-identity'
import {
  cleanupDownloadedGrokBinary,
  downloadLatestGrokBinary,
  installDownloadedGrokBinary,
  type DownloadedGrokBinary,
} from './grok-installer'

const execFileAsync = promisify(execFile)
const npmLatestCacheTtlMs = 10 * 60_000
const npmLatestFailureCacheTtlMs = 2 * 60_000
// Version checks run during the dashboard's initial scan. Keep each registry
// attempt bounded so an offline machine reaches the UI with an explicit
// "检查失败" state instead of appearing frozen for a minute or longer.
const npmLatestQueryTimeoutMs = 10_000
const maximumNpmRegistryResponseBytes = 256 * 1024
const maximumNpmPackageLockBytes = 16 * 1024 * 1024
export const networkLocationCacheTtlMs = 10 * 60_000
const npmOfficialRegistry = 'https://registry.npmjs.org'
const npmMirrorRegistry = 'https://registry.npmmirror.com'
const networkLocationUrl = 'https://www.cloudflare.com/cdn-cgi/trace'
const maximumModelResponseBytes = 1024 * 1024
const modelAccessCacheMaxEntries = 32
const maximumRuntimeManifestBytes = 256 * 1024
const maximumGrokVersionMetadataBytes = 16 * 1024
const semanticVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z](?:[0-9A-Za-z.-]{0,126})?)?(?:\+[0-9A-Za-z](?:[0-9A-Za-z.-]{0,126})?)?$/

export type UpdateCheckStatus = 'checked' | 'failed' | 'skipped'
export type UpdateState = 'available' | 'latest' | 'unknown'
export type UpdateSource = 'npm' | 'native' | 'windows-appx' | 'official-manifest' | 'winget' | null

export interface VersionUpdateStatus {
  latestVersion: string | null
  updateAvailable: boolean | null
  updateSource: UpdateSource
  updateCheck: UpdateCheckStatus
  updateState: UpdateState
  updateCheckedAt: string | null
  updateError: string | null
}

export interface ToolStatus {
  installed: boolean
  version: string | null
  path: string | null
  installDirectory: string | null
  tooOld?: boolean
  versionStatus?: NodeVersionStatus
  uninstall?: CliUninstallCapability
  /**
   * Set when the probe itself threw instead of concluding "not installed".
   * Must stay distinguishable from `installed: false` so the renderer never
   * tells a user to install something that may already be on their machine.
   */
  detectionFailed?: boolean
  detectionError?: string | null
}

export interface CliStatus extends ToolStatus {
  latestVersion: string | null
  updateAvailable: boolean
  updateSource?: UpdateSource
  updateCheck?: UpdateCheckStatus
  updateState?: UpdateState
  updateCheckedAt?: string | null
  updateError?: string | null
  uninstall: CliUninstallCapability
}

export interface DesktopAppStatus extends ToolStatus, Partial<VersionUpdateStatus> {
  appVersion: string | null
  mirrorVersion: string | null
  mirrorUpdateAvailable: boolean | null
  mirrorError: string | null
  running: boolean
}

export interface LatestVersionProbe {
  status: UpdateCheckStatus
  version: string | null
  source: 'npm' | 'native' | 'official-manifest'
  checkedAt: string
  error: string | null
}

/**
 * The color layer must sit on top of a caller-selected base. An elevated
 * terminal has to start from `trustedCommandEnvironment`, but that base cannot
 * be applied unconditionally: callers that stay at the current integrity level
 * would lose every user-writable PATH entry for no security gain. Sanitizing
 * after the color layer is not an option either, because the sanitizer strips
 * TERM/COLORTERM/FORCE_COLOR and would leave the terminal monochrome.
 */
export function interactiveTerminalEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env,
  buildBaseEnvironment: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv = commandEnvironment,
): NodeJS.ProcessEnv {
  const env = buildBaseEnvironment(baseEnv)
  const colorKeys = new Set([
    'term',
    'colorterm',
    'force_color',
    'no_color',
    'node_disable_colors',
    'clicolor',
    'clicolor_force',
  ])
  for (const key of Object.keys(env)) {
    if (colorKeys.has(key.toLowerCase())) delete env[key]
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.FORCE_COLOR = '3'
  env.CLICOLOR = '1'
  env.CLICOLOR_FORCE = '1'
  return env
}

/** Keeps service-level macOS launching bound to the command already verified by CLI resolution. */
export function buildDarwinCliLaunchPlan(
  command: { executable: string; argv: readonly string[] },
  workspace: string,
  env: NodeJS.ProcessEnv,
): MacosTerminalLaunchPlan {
  if (!path.isAbsolute(command.executable)) {
    throw new Error('macOS CLI executable must be an absolute resolved path')
  }
  if (!path.isAbsolute(workspace)) throw new Error('macOS workspace must be an absolute path')
  return { executable: command.executable, argv: [...command.argv], workspace, env }
}

export interface SystemSnapshot {
  checkedAt: string
  network: NetworkLocationStatus
  runtime: {
    node: ToolStatus
    npm: ToolStatus
    python: ToolStatus
  }
  clis: Record<ProviderId, CliStatus>
  desktopApps: {
    codex: DesktopAppStatus
  }
}

export interface CodexDesktopLaunchResult {
  restarted: boolean
  status: DesktopAppStatus
}

export type ToolUninstallResult =
  | {
      /** delegated：已交给以登录用户身份运行的窗口执行，结果需用户完成后刷新确认。 */
      outcome: 'uninstalled' | 'not-installed' | 'delegated'
      previousVersion: string | null
    }
  | {
      outcome: 'manual-required'
      previousVersion: string | null
      error: string
      manualHelp: {
        reason: string
        /**
         * null when a plain, unverified guess would be unsafe to hand back
         * (e.g. a security check itself failed, so the file identities behind
         * a command can no longer be trusted). Non-null only where the
         * producer already fully re-verified every path it names — see
         * DarwinGrokRetainedPathsError below for the one current source.
         */
        manualCommand: string | null
      }
    }

export interface CodexSetupStatus {
  checkedAt: string
  runtime: {
    node: ToolStatus
    npm: ToolStatus
  }
  cli: ToolStatus
  desktop: DesktopAppStatus
}

export interface ConfigSavePayload {
  provider: ProviderId
  apiKey: string
  model: string
  mode: NativeConfigSaveMode
}

export interface AppConfigSummary {
  workspace: string
  providers: Record<ProviderId, NativeConfigSummary>
}

export interface CodexReadinessStatus {
  hasApiKey: boolean
  matchesRelay: boolean
}

export interface RendererMessageTarget {
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
}

export type CodexDesktopLaunchMode = 'open' | 'restart'

/**
 * Every darwin Grok post-install and uninstall codesign verification runs through
 * this rather than the plain commandEnvironment() baseline used elsewhere to locate an
 * installation. The result decides whether a just-installed or about-to-be-removed
 * Grok binary is the genuine xAI build, so it must not run in an environment the
 * caller can still shape after the fact — the same reasoning macos-codex-app.ts and
 * resolveCliCommand's darwin staging path already apply for Codex.
 *
 * executeCommand is threaded through explicitly, rather than closed over, so this
 * stays a top-level function callable — and testable — from outside
 * createSystemService's closure.
 */
export function buildDarwinTrustedVerificationRunner(
  executeCommand: typeof runCommand,
): (spec: { executable: string; argv: readonly string[] }) => Promise<{ stdout: string; stderr: string }> {
  return async (spec) => {
    const result = await executeCommand(spec, {
      env: trustedCommandEnvironment(),
      timeoutMs: 8_000,
      maxOutputBytes: 1024 * 1024,
    })
    return { stdout: result.stdout, stderr: result.stderr }
  }
}

export interface UninstallVerifiedDarwinGrokInstallationOptions {
  homeDirectory: string
  installDirectory: string
  runCommand: (
    spec: { executable: string; argv: readonly string[] },
  ) => Promise<{ stdout: string; stderr: string }>
}

export interface InspectVerifiedDarwinGrokPostInstallOptions {
  homeDirectory: string
  expectedVersion: string
  runCommand: (
    spec: { executable: string; argv: readonly string[] },
  ) => Promise<{ stdout: string; stderr: string }>
}

/** Verifies and inspects only a private staged copy, then describes the bound canonical install. */
export async function inspectVerifiedDarwinGrokPostInstall(
  options: InspectVerifiedDarwinGrokPostInstallOptions,
): Promise<{ status: ToolStatus; installation: CliInstallation }> {
  const selection = resolveDarwinGrokCanonicalSelection(options.homeDirectory)
  // internal #16: the npm lifecycle script driving this install only ever
  // recreates the `grok` link on real hardware. Ensuring `agent` here — inside
  // the same post-install transaction — means a failure rolls back the whole
  // install exactly like a codesign or version mismatch would, instead of
  // quietly shipping an install this app's own automatic uninstall can't
  // later complete (see uninstallVerifiedDarwinGrokInstallation below).
  await ensureDarwinGrokAgentLink(options.homeDirectory, selection)
  return inspectDarwinGrokVerifiedSelection({
    homeDirectory: options.homeDirectory,
    selection,
    expectedVersion: options.expectedVersion,
    runCommand: options.runCommand,
    inspect: async (executablePath) => {
      const stats = await fs.promises.lstat(executablePath)
      if (
        !path.isAbsolute(executablePath)
        || executablePath === selection.executablePath
        || !stats.isFile()
        || stats.isSymbolicLink()
        || (stats.mode & 0o111) === 0
      ) {
        throw new Error('Grok postinstall inspection requires a private staged executable')
      }
      const installDirectory = fs.realpathSync(path.dirname(selection.canonicalLinkPath))
      return {
        status: {
          installed: true,
          version: options.expectedVersion,
          path: selection.executablePath,
          installDirectory,
        },
        installation: {
          commandPath: selection.canonicalLinkPath,
          installDirectory,
          packageRoot: null,
          npmPrefix: null,
          packageVersion: null,
          source: 'native',
        },
      }
    },
  })
}

/**
 * internal #20 (second-round darwin verification): every entry point that
 * decides whether to run a fresh install — the dashboard's per-card button,
 * "安装全部缺失项", and the maintenance page's batch action — gates purely on
 * `status.installed`, which has only ever come from the canonical `grok`
 * link (resolveDarwinGrokCanonicalSelection); `agent` has never been part of
 * that determination (see inspectCliTool below). So once grok reads as
 * installed, nothing user-reachable ever re-invokes ensureDarwinGrokAgentLink
 * for it again — the only thing that does is a fresh
 * runDarwinGrokPostInstallTransaction, which only runs when npm actually has
 * something to (re)install. Folding the same idempotent, non-destructive
 * ensure into every "is grok in place" probe means the very next scan or
 * update check repairs the gap on its own, regardless of how grok ended up
 * without its companion link — independent of, and in addition to, the
 * transaction every install/reinstall already runs.
 *
 * Best-effort by design: a failure here (permissions, a mid-scan uninstall,
 * a non-canonical install) must never turn a healthy "installed" status into
 * a false "not installed" — inspectCliTool's contract is to probe state, not
 * throw, so this swallows everything.
 */
async function ensureDarwinGrokAgentLinkQuietly(homeDirectory: string): Promise<void> {
  try {
    const selection = resolveDarwinGrokCanonicalSelection(homeDirectory)
    await ensureDarwinGrokAgentLink(homeDirectory, selection)
  } catch {
    // Best effort — see docstring above. The next successful probe, or an
    // explicit reinstall, gets another chance.
  }
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

  constructor(message: string, manualCommand: string) {
    super(message)
    this.name = 'DarwinGrokRetainedPathsError'
    this.manualCommand = manualCommand
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
    throw new DarwinGrokRetainedPathsError(messageParts.join(''), buildDarwinGrokCleanupCommand(retainedPaths))
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
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500)
    || 'Grok CLI 自动卸载安全验证失败'
  return {
    outcome: 'manual-required',
    previousVersion,
    error: message,
    manualHelp: {
      reason: `自动卸载安全验证失败：${message}`,
      manualCommand: null,
    },
  }
}

export interface SystemService {
  readStoredConfig(): AppSettings
  updateStoredConfig(update: AppSettingsUpdate): Promise<AppSettings>
  inspectCodexReadiness(previewOnboarding: boolean): CodexReadinessStatus
  getConfig(previewOnboarding: boolean): AppConfigSummary
  revealApiKey(provider: ProviderId, previewOnboarding: boolean): string
  saveConfig(
    payload: ConfigSavePayload,
    previewOnboarding: boolean,
  ): Promise<ReturnType<typeof saveProviderConfig>>
  scanSystem(forceRefresh?: boolean): Promise<SystemSnapshot>
  inspectCodexSetupStatus(): Promise<CodexSetupStatus>
  installNodeRuntime(target: RendererMessageTarget): Promise<NodeRuntimeInstallResult>
  installCli(provider: ProviderId, target: RendererMessageTarget): Promise<void>
  uninstallCli(provider: ProviderId): Promise<ToolUninstallResult>
  inspectCliUpdate(provider: ProviderId, forceRefresh?: boolean): Promise<CliStatus>
  installCodexDesktop(target: RendererMessageTarget): Promise<CodexDesktopInstallResult>
  uninstallCodexDesktop(): Promise<ToolUninstallResult>
  inspectCodexDesktopUpdate(forceRefresh?: boolean): Promise<DesktopAppStatus>
  launchProvider(provider: ProviderId, workspace: string): Promise<void>
  inspectCodexDesktop(): Promise<DesktopAppStatus>
  launchCodexDesktop(
    mode: CodexDesktopLaunchMode,
    target: RendererMessageTarget,
  ): Promise<CodexDesktopLaunchResult>
  fetchAvailableModels(apiKey: string): Promise<string[]>
}

function firstOutputLine(stdout: string, stderr: string): string | null {
  return `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '') ?? null
}

export function parseLatestNpmVersion(output: string): string | null {
  const trimmed = output.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    const candidate = typeof parsed === 'string'
      ? parsed
      : parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).version
        : null
    return typeof candidate === 'string' && semanticVersionPattern.test(candidate.trim())
      ? candidate.trim()
      : null
  } catch {
    return semanticVersionPattern.test(trimmed) ? trimmed : null
  }
}

export function parseGrokLocalVersion(input: string): string | null {
  try {
    const parsed = JSON.parse(input) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    for (const key of ['version', 'stable_version']) {
      const value = record[key]
      if (typeof value === 'string' && semanticVersionPattern.test(value.trim())) {
        return value.trim()
      }
    }
  } catch {
    // Invalid or partially written metadata is ignored; the caller can use a
    // separately verified executable or report an unknown version.
  }
  return null
}

interface GrokLocalVersionOptions {
  platform?: NodeJS.Platform
  homeDirectory?: string
  managedDirectory?: string | null
}

export async function readGrokLocalVersionForExecutable(
  executablePath: string,
  options: GrokLocalVersionOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform
  if (platform === 'darwin') {
    try {
      return resolveDarwinGrokCanonicalSelection(
        options.homeDirectory ?? os.homedir(),
        executablePath,
      ).version
    } catch {
      return null
    }
  }
  const executableDirectory = path.dirname(executablePath)
  const candidates = new Set<string>([
    // The managed installer writes metadata beside grok.exe. Keep this first so
    // an older xAI root-level version.json cannot override a completed update.
    path.join(executableDirectory, 'version.json'),
  ])
  if (path.basename(executableDirectory).toLowerCase() === 'bin') {
    candidates.add(path.join(path.dirname(executableDirectory), 'version.json'))
  }
  if (platform === 'win32') {
    const managedDirectory = options.managedDirectory === undefined
      ? managedNativeProviderRoot('grok')
      : options.managedDirectory
    if (managedDirectory) candidates.add(path.join(managedDirectory, 'version.json'))
  }
  candidates.add(path.join(options.homeDirectory ?? os.homedir(), '.grok', 'version.json'))

  for (const candidate of candidates) {
    try {
      const version = parseGrokLocalVersion(await readBoundedUtf8File(
        candidate,
        maximumGrokVersionMetadataBytes,
        'Grok version.json',
      ))
      if (version) return version
    } catch {
      // Continue through the bounded list of known metadata locations.
    }
  }
  return null
}

function normalizeRuntimeVersion(command: string, value: string | null): string | null {
  if (!value) return null
  const match = value.trim().match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)
  if (!match) return null
  const version = match[0]
  const normalizedCommand = command.toLowerCase()
  if (normalizedCommand === 'node') return `v${version}`
  if (normalizedCommand === 'python' || normalizedCommand === 'python3' || normalizedCommand === 'py') {
    return `Python ${version}`
  }
  return version
}

async function readPackageManifestVersion(filePath: string, label: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readBoundedUtf8File(
      filePath,
      maximumRuntimeManifestBytes,
      label,
    )) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const version = (parsed as Record<string, unknown>).version
    return typeof version === 'string' && semanticVersionPattern.test(version.trim())
      ? version.trim()
      : null
  } catch {
    return null
  }
}

async function readNpmPackageVersion(executable: string): Promise<string | null> {
  const executableDirectory = path.dirname(executable)
  const candidates = [
    path.join(executableDirectory, 'node_modules', 'npm', 'package.json'),
    path.join(executableDirectory, '..', 'lib', 'node_modules', 'npm', 'package.json'),
  ]
  for (const candidate of candidates) {
    const version = await readPackageManifestVersion(candidate, 'npm package.json')
    if (version) return version
  }
  return null
}

async function readWindowsExecutableProductVersion(
  executable: string,
  command: string,
): Promise<string | null> {
  if (process.platform !== 'win32' || path.extname(executable).toLowerCase() !== '.exe') return null
  try {
    const stats = await fs.promises.stat(executable)
    if (!stats.isFile()) return null
    const script = [
      '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      '$ErrorActionPreference = "Stop"',
      '$value = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:XINGMANG_VERSION_TARGET).ProductVersion',
      'if ($value) { [Console]::Out.Write([string]$value) }',
    ].join('; ')
    const { stdout } = await execFileAsync(resolveWindowsPowerShellExecutable(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], {
      env: {
        ...trustedCommandEnvironment(),
        XINGMANG_VERSION_TARGET: executable,
      },
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 64 * 1024,
    })
    return normalizeRuntimeVersion(command, cleanCommandOutput(stdout))
  } catch {
    return null
  }
}

function isWindowsAppExecutionAlias(filePath: string | null): boolean {
  return process.platform === 'win32'
    && Boolean(filePath && /\\AppData\\Local\\Microsoft\\WindowsApps\\/i.test(filePath))
}

export type NetworkRegion = 'mainland-china' | 'outside-mainland-china' | 'unknown'

export interface NetworkLocationStatus {
  publicIp: string | null
  countryCode: string | null
  region: NetworkRegion
  checkedAt: string
  error: string | null
}

export function parseCloudflareNetworkLocation(
  input: string,
  checkedAt = new Date().toISOString(),
): NetworkLocationStatus {
  if (!input.trim() || Buffer.byteLength(input, 'utf8') > 32 * 1024) {
    return {
      publicIp: null,
      countryCode: null,
      region: 'unknown',
      checkedAt,
      error: '网络位置响应为空或超过安全上限',
    }
  }
  const fields = new Map<string, string>()
  for (const rawLine of input.split(/\r?\n/)) {
    const separator = rawLine.indexOf('=')
    if (separator <= 0) continue
    const key = rawLine.slice(0, separator).trim().toLowerCase()
    const value = rawLine.slice(separator + 1).trim()
    if (key && value && !fields.has(key)) fields.set(key, value)
  }
  const ipCandidate = fields.get('ip') ?? ''
  const publicIp = isIP(ipCandidate) ? ipCandidate : null
  const countryCandidate = (fields.get('loc') ?? '').toUpperCase()
  const countryCode = /^[A-Z]{2}$/.test(countryCandidate) ? countryCandidate : null
  const region: NetworkRegion = countryCode === 'CN'
    ? 'mainland-china'
    : countryCode ? 'outside-mainland-china' : 'unknown'
  return {
    publicIp,
    countryCode,
    region,
    checkedAt,
    error: publicIp || countryCode ? null : '网络位置响应缺少有效 IP 和国家代码',
  }
}

export function parseCloudflareNetworkRegion(input: string): NetworkRegion {
  return parseCloudflareNetworkLocation(input).region
}

export async function detectNetworkLocation(
  fetchImplementation: typeof fetch = fetch,
  timeoutMs = 2_500,
): Promise<NetworkLocationStatus> {
  const checkedAt = new Date().toISOString()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()
  try {
    const response = await fetchImplementation(networkLocationUrl, {
      method: 'GET',
      headers: { Accept: 'text/plain' },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) {
      return {
        publicIp: null,
        countryCode: null,
        region: 'unknown',
        checkedAt,
        error: `网络位置服务返回 HTTP ${response.status}`,
      }
    }
    const body = await readBoundedResponseText(response, 32 * 1024, '网络位置')
    return parseCloudflareNetworkLocation(body, checkedAt)
  } catch (error) {
    return {
      publicIp: null,
      countryCode: null,
      region: 'unknown',
      checkedAt,
      error: error instanceof Error && error.name === 'AbortError'
        ? '网络位置检测超时'
        : error instanceof Error && error.message.includes('安全上限')
          ? error.message
          : '无法连接网络位置服务',
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function detectNetworkRegion(
  fetchImplementation: typeof fetch = fetch,
  timeoutMs = 2_500,
): Promise<NetworkRegion> {
  return (await detectNetworkLocation(fetchImplementation, timeoutMs)).region
}

/**
 * An unknown region means the Cloudflare probe could not complete, and the
 * users whose network blocks that probe are overwhelmingly the ones who also
 * cannot reach registry.npmjs.org. Sending them to the official registry first
 * was exactly backwards.
 *
 * The costs are not symmetric. An overseas user wrongly routed to npmmirror
 * loses a few seconds to a CDN that still serves them; a mainland user wrongly
 * routed to the official registry cannot install at all. Both entries stay in
 * the list either way, so a wrong guess only changes which one is tried first.
 */
export function npmInstallRegistries(region: NetworkRegion): [string, string] {
  return region === 'outside-mainland-china'
    ? [npmOfficialRegistry, npmMirrorRegistry]
    : [npmMirrorRegistry, npmOfficialRegistry]
}

/**
 * IMPROVEMENT-PLAN 2.4: a user-pinned mirror policy overrides the probed
 * region by reducing to the region that yields the desired order. Both
 * npmInstallRegistries and nodeRuntimeDownloadSources branch only on
 * 'outside-mainland-china' vs everything else, so this single reduction
 * covers every source-order decision without touching their signatures --
 * and a pinned policy lets install paths skip the region probe entirely,
 * which in a blocked network is itself the unreliable step.
 *
 * Deliberately NOT applied to the Codex desktop manifest: its bytes are
 * mirror-only, so the manifest must stay mirror-first regardless of policy
 * or the card can advertise a release the install path cannot fetch (see
 * buildCodexDesktopManifestSources).
 */
export function effectiveNetworkRegion(
  policy: MirrorPolicy | undefined,
  detected: NetworkRegion,
): NetworkRegion {
  if (policy === 'mirror-first') return 'mainland-china'
  if (policy === 'official-first') return 'outside-mainland-china'
  return detected
}

export function npmRegistryLabel(registry: string): string {
  return registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'
}

/**
 * The dependency graph must be resolved against the official registry, and a
 * mirror cannot stand in for it. Measured on Windows, all four managed CLIs
 * resolve only 7-12 packages in 1-4s on a healthy connection, so a wait long
 * enough to notice means the connection to registry.npmjs.org is struggling,
 * not that there is a lot of work to do. Ten minutes is a ceiling for that
 * case rather than an expected duration; five was killing connections that
 * were slow but still making progress. npm prints nothing throughout, which
 * is why this step used to look like a hang.
 */
export const npmResolutionTimeoutMs = 10 * 60_000
export const npmDownloadTimeoutMs = 5 * 60_000
export const npmResolutionHeartbeatMs = 15_000

export function formatElapsedDuration(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000))
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`
}

export function npmResolutionStartMessage(registry: string): string {
  return registry === npmOfficialRegistry
    ? '正在从 npm 官方源解析完整依赖图并校验 SHA-512 完整性。这一步必须直连官方源，'
      + '镜像无法代替；网络受限时可能较慢，但不影响后续下载速度，请耐心等待'
    : `正在从${npmRegistryLabel(registry)}解析完整依赖图，准备与官方 SHA-512 对账`
}

export function npmResolutionHeartbeatMessage(registry: string, elapsedMs: number): string {
  return `仍在解析${npmRegistryLabel(registry)}的依赖图…（已用时 ${formatElapsedDuration(elapsedMs)}）`
}

export function npmPackageLatestUrl(registry: string, packageName: string): string {
  return `${registry.replace(/\/+$/, '')}/${encodeURIComponent(packageName)}/latest`
}

export function npmPackageVersionUrl(registry: string, packageName: string, version: string): string {
  return `${registry.replace(/\/+$/, '')}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`
}

export interface NpmPackageReleaseMetadata {
  name: string
  version: string
  integrity: string
}

export function parseNpmPackageReleaseMetadata(
  input: string,
  expectedPackageName: string,
): NpmPackageReleaseMetadata | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(input) as unknown
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const dist = record.dist && typeof record.dist === 'object' && !Array.isArray(record.dist)
    ? record.dist as Record<string, unknown>
    : null
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const version = typeof record.version === 'string' ? record.version.trim() : ''
  const integrity = typeof dist?.integrity === 'string' ? dist.integrity.trim() : ''
  if (name !== expectedPackageName || !semanticVersionPattern.test(version)) return null
  const match = integrity.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/)
  if (!match) return null
  try {
    if (Buffer.from(match[1], 'base64').length !== 64) return null
  } catch {
    return null
  }
  return { name, version, integrity }
}

export async function fetchNpmPackageReleaseMetadata(
  registry: string,
  packageName: string,
  version: string | 'latest',
  fetchImplementation: typeof fetch = fetch,
  timeoutMs = npmLatestQueryTimeoutMs,
): Promise<NpmPackageReleaseMetadata> {
  const sourceLabel = registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()
  try {
    const endpoint = version === 'latest'
      ? npmPackageLatestUrl(registry, packageName)
      : npmPackageVersionUrl(registry, packageName, version)
    const response = await fetchImplementation(endpoint, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`${sourceLabel} HTTP ${response.status}`)
    const body = await readBoundedResponseText(
      response,
      maximumNpmRegistryResponseBytes,
      `${sourceLabel}包元数据`,
    )
    const release = parseNpmPackageReleaseMetadata(body, packageName)
    if (!release || (version !== 'latest' && release.version !== version)) {
      throw new Error(`${sourceLabel}返回的包名、版本或 SHA-512 完整性元数据无效`)
    }
    return release
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${sourceLabel}包元数据查询超时`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export function assertNpmReleaseIntegrityMatches(
  trusted: NpmPackageReleaseMetadata,
  candidate: NpmPackageReleaseMetadata,
): void {
  if (
    candidate.name !== trusted.name
    || candidate.version !== trusted.version
    || candidate.integrity !== trusted.integrity
  ) {
    throw new Error('国内 npm 镜像的包名、版本或 SHA-512 完整性元数据与 npm 官方源不一致')
  }
}

/** Binds registry metadata to the exact direct package record npm resolved from the official registry. */
export function assertNpmReleaseMatchesOfficialLock(
  trustedRelease: NpmPackageReleaseMetadata,
  officialLock: string,
): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(officialLock) as unknown
  } catch {
    throw new Error('npm 官方 package-lock.json 不是有效 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('npm 官方 package-lock.json 根结构无效')
  }
  const packages = (parsed as Record<string, unknown>).packages
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    throw new Error('npm 官方 package-lock.json 缺少 packages 图')
  }
  const packageEntries = packages as Record<string, unknown>
  const root = packageEntries['']
  const rootDependencies = root && typeof root === 'object' && !Array.isArray(root)
    ? (root as Record<string, unknown>).dependencies
    : null
  const directVersion = rootDependencies && typeof rootDependencies === 'object' && !Array.isArray(rootDependencies)
    ? (rootDependencies as Record<string, unknown>)[trustedRelease.name]
    : null
  const directLocation = `node_modules/${trustedRelease.name}`
  const directEntry = packageEntries[directLocation]
  if (
    directVersion !== trustedRelease.version
    || !directEntry
    || typeof directEntry !== 'object'
    || Array.isArray(directEntry)
  ) {
    throw new Error('npm 官方 package-lock.json 的目标直依赖身份或版本与发布元数据不一致')
  }
  const record = directEntry as Record<string, unknown>
  if (
    record.version !== trustedRelease.version
    || record.integrity !== trustedRelease.integrity
  ) {
    throw new Error('npm 官方 package-lock.json 的目标直依赖版本或 SHA-512 与发布元数据不一致')
  }
}

function canonicalNpmPackageLock(
  input: string,
  packageName: string,
  version: string,
): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(input) as unknown
  } catch {
    throw new Error('npm package-lock.json 不是有效 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('npm package-lock.json 根结构无效')
  }
  const lock = parsed as Record<string, unknown>
  const packages = lock.packages
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    throw new Error('npm package-lock.json 缺少 packages 图')
  }
  const packageEntries = packages as Record<string, unknown>
  const root = packageEntries['']
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new Error('npm package-lock.json 缺少根包')
  }
  const rootDependencies = (root as Record<string, unknown>).dependencies
  if (
    !rootDependencies
    || typeof rootDependencies !== 'object'
    || Array.isArray(rootDependencies)
    || (rootDependencies as Record<string, unknown>)[packageName] !== version
  ) {
    throw new Error('npm package-lock.json 没有锁定目标 CLI 的精确版本')
  }
  for (const [location, entry] of Object.entries(packageEntries)) {
    if (!location) continue
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`npm package-lock.json 包记录无效：${location}`)
    }
    const record = entry as Record<string, unknown>
    const entryVersion = typeof record.version === 'string' ? record.version.trim() : ''
    const integrity = typeof record.integrity === 'string' ? record.integrity.trim() : ''
    const integrityMatch = integrity.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/)
    if (!semanticVersionPattern.test(entryVersion) || !integrityMatch) {
      throw new Error(`npm package-lock.json 包版本或 SHA-512 无效：${location}`)
    }
    if (Buffer.from(integrityMatch[1], 'base64').length !== 64) {
      throw new Error(`npm package-lock.json SHA-512 长度无效：${location}`)
    }
  }

  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'resolved')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]))
  }
  return JSON.stringify(canonicalize(lock))
}

export function assertNpmPackageLocksEquivalent(
  officialLock: string,
  candidateLock: string,
  packageName: string,
  version: string,
): void {
  const official = canonicalNpmPackageLock(officialLock, packageName, version)
  const candidate = canonicalNpmPackageLock(candidateLock, packageName, version)
  if (candidate !== official) {
    throw new Error('npm 镜像的完整依赖图、版本或 SHA-512 与官方源不一致')
  }
}

export class ManagedNpmRollbackError extends Error {
  readonly preserveTransaction = true

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ManagedNpmRollbackError'
  }
}

export interface ManagedNpmReplaceOperations {
  rename(source: string, destination: string): Promise<void>
}

export async function replaceManagedNpmPrefixAtomically(
  activePrefix: string,
  stagedPrefix: string,
  transactionDirectory: string,
  verifyPromotedPrefix: () => Promise<void>,
  operations: ManagedNpmReplaceOperations = fs.promises,
): Promise<void> {
  const active = path.resolve(activePrefix)
  const staged = path.resolve(stagedPrefix)
  const transaction = path.resolve(transactionDirectory)
  const relativeStage = path.relative(transaction, staged)
  if (
    active === staged
    || path.parse(active).root.toLowerCase() !== path.parse(staged).root.toLowerCase()
    || relativeStage === ''
    || relativeStage === '..'
    || relativeStage.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeStage)
  ) {
    throw new Error('托管 npm 事务目录无效，未修改当前安装')
  }
  if (!fs.existsSync(active) || !fs.statSync(active).isDirectory()) {
    throw new Error('当前托管 npm 目录不存在，无法执行原子更新')
  }
  if (!fs.existsSync(staged) || !fs.statSync(staged).isDirectory()) {
    throw new Error('暂存 npm 目录不存在，无法执行原子更新')
  }

  const backup = path.join(transaction, 'previous-prefix')
  const rejected = path.join(transaction, 'rejected-prefix')
  await operations.rename(active, backup)
  let promoted = false
  try {
    await operations.rename(staged, active)
    promoted = true
    await verifyPromotedPrefix()
  } catch (error) {
    let rollbackError: unknown = null
    try {
      if (promoted && fs.existsSync(active)) await operations.rename(active, rejected)
      if (fs.existsSync(backup)) await operations.rename(backup, active)
    } catch (cause) {
      rollbackError = cause
    }
    if (rollbackError) {
      const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      throw new ManagedNpmRollbackError(`托管 npm 更新失败，且旧版本回滚失败：${detail}`, { cause: error })
    }
    throw error
  }
}

export function modelAccessCacheKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex')
}

function safeRelayErrorMessage(value: string, apiKey: string): string {
  return redactCommandText(value, [apiKey])
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
}

export interface CliMaintenancePlan {
  kind: 'npm-install'
  executable: string
  argv: string[]
  windowsPackageManager: 'npm'
}

export type GrokInstallStrategy = 'windows-native' | 'darwin-official-npm' | 'external'

export function grokInstallStrategyFor(platform: NodeJS.Platform): GrokInstallStrategy {
  if (platform === 'win32') return 'windows-native'
  if (platform === 'darwin') return 'darwin-official-npm'
  return 'external'
}

export interface CliInstallReleaseOptions {
  fetchGrokStableVersion: () => Promise<{ version: string }>
  fetchNpmRelease: (
    registry: string,
    packageName: string,
    version: string | 'latest',
  ) => Promise<NpmPackageReleaseMetadata>
}

/** Selects the authoritative release before generating an npm dependency lock. */
export async function resolveCliInstallRelease(
  provider: ProviderId,
  grokStrategy: GrokInstallStrategy | null,
  options: CliInstallReleaseOptions = {
    fetchGrokStableVersion,
    fetchNpmRelease: fetchNpmPackageReleaseMetadata,
  },
): Promise<NpmPackageReleaseMetadata> {
  if (provider !== 'grok' || grokStrategy !== 'darwin-official-npm') {
    return options.fetchNpmRelease(npmOfficialRegistry, cliCatalog[provider].packageName, 'latest')
  }
  const stable = await options.fetchGrokStableVersion()
  const release = await options.fetchNpmRelease(
    npmOfficialRegistry,
    cliCatalog.grok.packageName,
    stable.version,
  )
  if (release.version !== stable.version) {
    throw new Error('Grok npm 发布版本与 xAI 官方稳定版本不一致')
  }
  return release
}

export function buildCliMaintenancePlan(
  provider: ProviderId,
  npmExecutable: string | null,
  npmPrefix: string | null = null,
  version = 'latest',
  verifiedLifecycleScripts = false,
  platform: NodeJS.Platform = process.platform,
): CliMaintenancePlan {
  if (provider === 'grok') {
    const strategy = grokInstallStrategyFor(platform)
    if (strategy === 'windows-native') {
      throw new Error('Grok CLI 必须使用 xAI 已签名二进制安装器')
    }
    if (strategy === 'external') {
      throw new Error('当前平台不支持 Grok CLI 一键安装')
    }
    if (!verifiedLifecycleScripts) {
      throw new Error('Grok CLI 生命周期脚本必须先通过完整性校验')
    }
  }
  if (!npmExecutable) throw new Error('未检测到 npm，请先安装 Node.js')
  if (platform === 'darwin' && provider !== 'grok' && !npmPrefix) {
    throw new Error('macOS 用户级 npm 前缀不能为空')
  }
  if (version !== 'latest' && !semanticVersionPattern.test(version)) {
    throw new Error('npm CLI 版本号格式无效')
  }
  if (provider === 'grok') {
    return {
      kind: 'npm-install',
      executable: npmExecutable,
      argv: ['ci', '--omit=dev'],
      windowsPackageManager: 'npm',
    }
  }
  return {
    kind: 'npm-install',
    executable: npmExecutable,
    argv: [
      'install',
      '--global',
      ...(npmPrefix ? [`--prefix=${npmPrefix}`] : []),
      ...(!verifiedLifecycleScripts ? ['--ignore-scripts'] : []),
      '--omit=dev',
      '--package-lock=false',
      `${cliCatalog[provider].packageName}@${version}`,
    ],
    windowsPackageManager: 'npm',
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

function containsComparableVersion(value: string | null): boolean {
  return typeof value === 'string'
    && /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/.test(value)
}

export function buildCliStatus(
  installed: ToolStatus,
  latest: LatestVersionProbe,
): CliStatus {
  const base = {
    ...installed,
    uninstall: installed.uninstall ?? {
      available: false,
      reason: installed.installed ? '未能确认当前安装是否可由本工具安全卸载' : null,
      manualCommand: null,
    },
    latestVersion: latest.version,
    updateAvailable: false,
    updateSource: latest.source,
    updateCheck: latest.status,
    updateState: 'unknown',
    updateCheckedAt: latest.checkedAt,
    updateError: latest.error,
  } satisfies CliStatus

  if (latest.status !== 'checked' || !latest.version) return base
  if (!installed.installed) return base
  if (!containsComparableVersion(installed.version)) {
    return {
      ...base,
      updateCheck: 'failed',
      updateError: '已安装 CLI 的版本号无法解析，不能判断是否有更新',
    }
  }
  if (isNewerVersion(installed.version, latest.version)) {
    return { ...base, updateAvailable: true, updateState: 'available', updateError: null }
  }
  if (isNewerVersion(latest.version, installed.version)) {
    const sourceName = latest.source === 'native' ? '原生更新源' : 'npm latest'
    return {
      ...base,
      updateCheck: 'failed',
      updateError: `已安装版本高于${sourceName}，可能来自其他分发通道，无法可靠比较`,
    }
  }
  return { ...base, updateAvailable: false, updateState: 'latest', updateError: null }
}

function safeVersionCheckError(error: unknown, operation = 'npm latest'): string {
  const candidate = error as { code?: unknown; message?: unknown; name?: unknown }
  if (candidate?.name === 'AbortError') return `${operation} 查询超时`
  if (candidate?.code === 'TIMED_OUT') {
    return operation.startsWith('Grok')
      ? '连接 xAI 更新服务超时，请检查代理或网络后重试'
      : `${operation} 查询超时`
  }
  if (candidate?.code === 'SPAWN_FAILED') return `无法启动 ${operation} 查询`
  if (candidate?.code === 'EXIT_NON_ZERO') return `${operation} 查询失败`
  const message = typeof candidate?.message === 'string' ? candidate.message.trim() : ''
  return message.slice(0, 240) || `${operation} 查询失败`
}

// `describeProbeFailure` (probe-failure.ts) and the `build*FromSettled`
// helpers below keep a rejected probe from masquerading as "not installed".
export function buildToolStatusFromSettled(result: PromiseSettledResult<ToolStatus>): ToolStatus {
  if (result.status === 'fulfilled') return result.value
  return {
    installed: false,
    version: null,
    path: null,
    installDirectory: null,
    detectionFailed: true,
    detectionError: describeProbeFailure(result.reason),
  }
}

export function buildNetworkLocationStatusFromSettled(
  result: PromiseSettledResult<NetworkLocationStatus>,
  checkedAt: string = new Date().toISOString(),
): NetworkLocationStatus {
  if (result.status === 'fulfilled') return result.value
  return {
    publicIp: null,
    countryCode: null,
    region: 'unknown',
    checkedAt,
    error: describeProbeFailure(result.reason),
  }
}

export function buildDesktopAppStatusFromSettled(
  result: PromiseSettledResult<DesktopAppStatus>,
): DesktopAppStatus {
  if (result.status === 'fulfilled') return result.value
  const error = describeProbeFailure(result.reason)
  return {
    installed: false,
    version: null,
    path: null,
    installDirectory: null,
    appVersion: null,
    mirrorVersion: null,
    mirrorUpdateAvailable: null,
    mirrorError: null,
    running: false,
    detectionFailed: true,
    detectionError: error,
    ...desktopUpdateFields('failed', error, null),
  }
}

/**
 * `inspectCliTool` cannot join a `Promise.allSettled` alongside the runtime
 * probes above it: it needs the npm probe's resolved path first. A rejection
 * here must still degrade exactly like the others — distinguishably failed,
 * never silently "not installed" — otherwise onboarding could offer to
 * reinstall a CLI that may already be working.
 */
export function buildCliToolStatusFromSettled(
  result: PromiseSettledResult<{ status: ToolStatus }>,
): ToolStatus {
  return result.status === 'fulfilled' ? result.value.status : buildToolStatusFromSettled(result)
}

export interface SystemServiceOptions {
  /** Defaults to the restrictive mode so tests and non-main callers fail closed. */
  windowsExecutionMode?: WindowsCliExecutionMode
  platform?: NodeJS.Platform
  providerRoots?: ProviderConfigRoots
  codexEnv?: NodeJS.ProcessEnv
  inspectProviderConfig?: typeof inspectProviderConfig
  resolveCliCommand?: typeof resolveCliCommand
  resolveCliInstallation?: typeof resolveCliInstallation
  runCommand?: typeof runCommand
  macosCodexAppDetector?: typeof inspectMacosCodexApp
}

export function providerCommandEnvironment(
  provider: ProviderId,
  processEnv: NodeJS.ProcessEnv,
  codexEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return commandEnvironment(provider === 'codex' ? codexEnv : processEnv)
}

export function createSystemService(
  store: AppSettingsStore,
  serviceOptions: SystemServiceOptions = {},
): SystemService {
  const windowsExecutionMode = serviceOptions.windowsExecutionMode ?? 'trusted-only'
  const platform = serviceOptions.platform ?? process.platform
  const providerRoots = serviceOptions.providerRoots ?? defaultProviderConfigRoots()
  const codexEnv = serviceOptions.codexEnv
    ?? { ...process.env, CODEX_HOME: providerRoots.codexHome }
  // Read fresh at call time (not captured once at service construction) so a
  // settings change takes effect on the very next inspection without
  // requiring a service restart -- same reasoning as saveConfig's activeSite
  // read below.
  const inspectNativeProviderConfig = (provider: ProviderId) =>
    (serviceOptions.inspectProviderConfig ?? inspectProviderConfig)(
      provider,
      providerRoots,
      resolveRelaySite(store.read().relaySiteId).providerBaseUrls,
    )
  const providerEnvironment = (provider: ProviderId): NodeJS.ProcessEnv =>
    providerCommandEnvironment(provider, process.env, codexEnv)
  const resolveVerifiedCliCommand = serviceOptions.resolveCliCommand ?? resolveCliCommand
  const resolveCliInstallationForService = serviceOptions.resolveCliInstallation ?? resolveCliInstallation
  const executeCommand = serviceOptions.runCommand ?? runCommand
  const detectMacosCodexApp = serviceOptions.macosCodexAppDetector ?? inspectMacosCodexApp
  const installing = new Set<ProviderId>()
  const installationQueue = new InstallationQueue()
  let nodeRuntimeInstalling = false
  const npmLatestCache = new Map<string, { expiresAt: number; value: LatestVersionProbe }>()
  // 失效时递增，让失效前发起的在途查询放弃回写过期结果
  let npmLatestCacheGeneration = 0
  const grokLatestInFlight = new Map<string, Promise<LatestVersionProbe>>()
  const modelAccessCache = new Map<string, { expiresAt: number; models: string[] }>()
  let networkLocationCache: { expiresAt: number; value: NetworkLocationStatus } | null = null

  function createInstallTemporaryDirectory(
    label: string,
    options: { baseDirectory?: string } = {},
  ): Promise<string> {
    if (options.baseDirectory) {
      return createTrustedTemporaryDirectory(label, {
        platform,
        env: commandEnvironment(),
        baseDirectory: options.baseDirectory,
      })
    }
    if (process.platform === 'win32' && windowsExecutionMode === 'trusted-only') {
      return createTrustedTemporaryDirectory(label, options)
    }
    const safeLabel = label.replace(/[^a-z0-9-]/gi, '-')
    return fs.promises.mkdtemp(path.join(os.tmpdir(), `xingmang-${safeLabel}-`))
  }

  async function inspectNetworkLocation(): Promise<NetworkLocationStatus> {
    if (networkLocationCache && networkLocationCache.expiresAt > Date.now()) {
      return networkLocationCache.value
    }
    const value = await detectNetworkLocation()
    // A failed probe used to be retried every minute, costing another 2.5s
    // timeout each time on precisely the networks that are already slow. Now
    // that an unknown region routes to the mirror first — the safe default for
    // this product — there is nothing to regain by re-probing sooner. A manual
    // rescan still clears this cache outright via forceRefresh.
    networkLocationCache = { expiresAt: Date.now() + networkLocationCacheTtlMs, value }
    return value
  }

  async function inspectNetworkRegion(): Promise<NetworkRegion> {
    // 2.4：镜像策略被用户钉死时不再探测——直接归约到产生所需源顺序的
    // region。scanSystem 的网络状态卡片仍走真实探测（inspectNetworkLocation），
    // 展示保持诚实，这里只决定安装/版本检查的源顺序。
    const policy = store.read().mirrorPolicy
    if (policy) return effectiveNetworkRegion(policy, 'unknown')
    return (await inspectNetworkLocation()).region
  }

  /**
   * Tool discovery is deliberately not restricted to machine PATH entries.
   * npm global installs and the official Grok/Claude installers live under a
   * user's profile on Windows. Discovery is read-only; an explicitly elevated
   * process still blocks version execution from user-writable paths.
   */
  async function findInstalledExecutable(command: string): Promise<string | null> {
    return findExecutable(command, {
      env: commandEnvironment(),
      windowsPackageManagers: command.toLowerCase() === 'npm' ? ['npm'] : [],
    })
  }

  async function executeVersion(
    executable: string,
    args: string[],
    windowsPackageManager?: WindowsPackageManager,
    baseEnv: NodeJS.ProcessEnv = process.env,
  ): Promise<string | null> {
    try {
      const trustedOnly = platform === 'win32' && windowsExecutionMode === 'trusted-only'
      if (trustedOnly && !isTrustedHighIntegrityExecutable(executable)) return null
      const result = await executeCommand({ executable, argv: args, windowsPackageManager }, {
        env: trustedOnly ? trustedCommandEnvironment(baseEnv) : commandEnvironment(baseEnv),
        trustedOnly,
        timeoutMs: 8_000,
        maxOutputBytes: 1024 * 1024,
      })
      return firstOutputLine(result.stdout, result.stderr)
    } catch (error) {
      const candidate = error as { stdout?: string; stderr?: string }
      return firstOutputLine(candidate.stdout ?? '', candidate.stderr ?? '')
    }
  }

  async function inspectTool(command: string, args = ['--version']): Promise<ToolStatus> {
    const executable = await findInstalledExecutable(command)
    if (!executable) return { installed: false, version: null, path: null, installDirectory: null }
    let version = await executeVersion(
      executable,
      args,
      command.toLowerCase() === 'npm' ? 'npm' : undefined,
    )
    if (!version && command.toLowerCase() === 'npm') {
      version = await readNpmPackageVersion(executable)
    } else if (!version && !isWindowsAppExecutionAlias(executable)) {
      // Reading PE metadata through the trusted inbox PowerShell does not
      // execute a runtime found in a user-writable directory.
      version = await readWindowsExecutableProductVersion(executable, command)
    }
    return {
      installed: true,
      version,
      path: executable,
      installDirectory: path.dirname(executable),
    }
  }

  async function inspectNode(): Promise<ToolStatus> {
    const status = await inspectTool('node')
    if (!status.installed) return { ...status, tooOld: false, versionStatus: 'unknown' }
    const versionStatus = nodeVersionStatus(status.version)
    return { ...status, tooOld: versionStatus === 'too-old', versionStatus }
  }

  async function inspectCliTool(
    provider: ProviderId,
    npmExecutable?: string | null,
    npmGlobalRoot?: string | null,
    executablePath?: string | null,
  ): Promise<{ status: ToolStatus; installation: CliInstallation | null }> {
    const cliEnvironment = providerEnvironment(provider)
    const installation = await resolveCliInstallationForService(provider, {
      env: cliEnvironment,
      executablePath,
      npmExecutable,
      npmGlobalRoot,
      platform,
    })
    if (
      !installation
      || (provider === 'codex' && installation.source === 'native'
        && isCodexDesktopExecutable(installation.commandPath))
    ) {
      return {
        status: { installed: false, version: null, path: null, installDirectory: null },
        installation: null,
      }
    }
    const safeNativeCommand = installation.source === 'native' && provider !== 'grok'
      ? await resolveVerifiedCliCommand(provider, cliEnvironment, windowsExecutionMode, {
          darwinStagingRetention: 'ephemeral',
        }).catch(() => null)
      : null
    try {
      let version = installation.source === 'npm'
        ? installation.packageVersion ?? null
        : platform === 'darwin' && provider === 'codex' && safeNativeCommand?.verifiedDarwinStandalone
          ? safeNativeCommand.verifiedDarwinStandalone.version
          : safeNativeCommand
            ? await executeVersion(
                safeNativeCommand.executable,
                [...safeNativeCommand.argv, ...cliCatalog[provider].versionArgs],
                undefined,
                cliEnvironment,
              )
            : null
      if (provider === 'grok') {
        version = await readGrokLocalVersionForExecutable(installation.commandPath)
        if (platform === 'darwin') {
          await ensureDarwinGrokAgentLinkQuietly(cliEnvironment.HOME?.trim() || os.homedir())
        }
      }
      return { status: {
        installed: true,
        // Reading an npm package manifest avoids unnecessary CLI execution and
        // remains safe even when the app was manually started as administrator.
        version,
        path: installation.source === 'native'
          ? provider === 'grok'
            ? installation.commandPath
            : platform === 'darwin' && safeNativeCommand?.verifiedDarwinStandalone
              ? safeNativeCommand.verifiedDarwinStandalone.executablePath
              : safeNativeCommand?.executable ?? null
          : installation.commandPath,
        installDirectory: installation.installDirectory,
        uninstall: cliUninstallCapability(provider, installation, {
          managedNpmPrefix: (() => {
            try {
              return managedNpmPrefix()
            } catch {
              return null
            }
          })(),
          managedNativeDirectory: process.platform === 'win32' && provider === 'grok'
            ? managedNativeProviderRoot('grok')
            : null,
          homeDirectory: cliEnvironment.HOME?.trim() || os.homedir(),
          platform,
          verifiedDarwinStandalone: safeNativeCommand?.verifiedDarwinStandalone ?? null,
          windowsExecutionMode,
        }),
      }, installation }
    } finally {
      await safeNativeCommand?.release?.()
    }
  }

  async function inspectPython(): Promise<ToolStatus> {
    let fallback: ToolStatus | null = null
    for (const [command, args] of [
      ['python', ['--version']],
      ['python3', ['--version']],
      ['py', ['--version']],
    ] as const) {
      const result = await inspectTool(command, [...args])
      if (!result.installed) continue
      if (result.version) return result
      if (!isWindowsAppExecutionAlias(result.path)) fallback ??= result
    }
    return fallback ?? { installed: false, version: null, path: null, installDirectory: null }
  }

  async function inspectLatestNpmVersion(
    packageName: string,
    networkRegion: NetworkRegion,
  ): Promise<LatestVersionProbe> {
    const cacheKey = `npm:${networkRegion}:${packageName}`
    const cached = npmLatestCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.value

    const generation = npmLatestCacheGeneration
    const checkedAt = new Date().toISOString()
    const query = async (registry: string): Promise<LatestVersionProbe> => {
      const sourceLabel = registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), npmLatestQueryTimeoutMs)
      try {
        const response = await fetch(npmPackageLatestUrl(registry, packageName), {
          headers: { Accept: 'application/json' },
          redirect: 'error',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`${sourceLabel} HTTP ${response.status}`)
        const body = await readBoundedResponseText(
          response,
          maximumNpmRegistryResponseBytes,
          sourceLabel,
        )
        const version = parseLatestNpmVersion(body)
        return version
          ? { status: 'checked', version, source: 'npm', checkedAt, error: null }
          : {
              status: 'failed',
              version: null,
              source: 'npm',
              checkedAt,
              error: `${sourceLabel} 返回了无法解析的版本号`,
            }
      } catch (error) {
        return {
          status: 'failed',
          version: null,
          source: 'npm',
          checkedAt,
          error: safeVersionCheckError(error, sourceLabel),
        }
      } finally {
        clearTimeout(timeout)
      }
    }
    const errors: string[] = []
    let value: LatestVersionProbe | null = null
    for (const registry of npmInstallRegistries(networkRegion)) {
      const result = await query(registry)
      if (result.status === 'checked') {
        value = result
        break
      }
      if (result.error) errors.push(result.error)
    }
    value ??= {
      status: 'failed',
      version: null,
      source: 'npm',
      checkedAt,
      error: errors.join('；') || 'npm 版本查询失败',
    }
    if (generation === npmLatestCacheGeneration) {
      const ttl = value.status === 'checked' ? npmLatestCacheTtlMs : npmLatestFailureCacheTtlMs
      npmLatestCache.set(cacheKey, { expiresAt: Date.now() + ttl, value })
    }
    return value
  }

  async function inspectLatestGrokVersion(): Promise<LatestVersionProbe> {
    const cacheKey = 'official:grok:stable'
    const cached = npmLatestCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const existingProbe = grokLatestInFlight.get(cacheKey)
    if (existingProbe) return existingProbe

    const probe = (async (): Promise<LatestVersionProbe> => {
      const checkedAt = new Date().toISOString()
      try {
        const result = await fetchGrokStableVersion()
        return {
          status: 'checked',
          version: result.version,
          source: 'official-manifest',
          checkedAt,
          error: null,
        }
      } catch (error) {
        return {
          status: 'failed',
          version: null,
          source: 'official-manifest',
          checkedAt,
          error: safeVersionCheckError(error, 'Grok 官方版本'),
        }
      }
    })().then((value) => {
      // invalidate 会清空 in-flight 表，比对可拦住失效前发起的过期回写
      if (grokLatestInFlight.get(cacheKey) === probe) {
        npmLatestCache.set(cacheKey, {
          expiresAt: Date.now() + (value.status === 'checked'
            ? npmLatestCacheTtlMs
            : npmLatestFailureCacheTtlMs),
          value,
        })
      }
      return value
    })
    grokLatestInFlight.set(cacheKey, probe)
    try {
      return await probe
    } finally {
      if (grokLatestInFlight.get(cacheKey) === probe) grokLatestInFlight.delete(cacheKey)
    }
  }

  function invalidateCliUpdateCache(provider: ProviderId): void {
    npmLatestCacheGeneration += 1
    if (provider === 'grok') {
      for (const key of npmLatestCache.keys()) {
        if (key.startsWith('official:grok:')) npmLatestCache.delete(key)
      }
      grokLatestInFlight.clear()
      return
    }
    const packageSuffix = `:${cliCatalog[provider].packageName}`
    for (const key of npmLatestCache.keys()) {
      if (key.endsWith(packageSuffix) || key === cliCatalog[provider].packageName) {
        npmLatestCache.delete(key)
      }
    }
  }

  async function inspectCliLatestVersion(
    provider: ProviderId,
    installed: ToolStatus,
    networkRegion: NetworkRegion,
  ): Promise<LatestVersionProbe> {
    if (!installed.installed) {
      return {
        status: 'skipped',
        version: null,
        source: provider === 'grok' ? 'official-manifest' : 'npm',
        checkedAt: new Date().toISOString(),
        error: null,
      }
    }
    if (provider === 'grok') {
      return inspectLatestGrokVersion()
    }
    return inspectLatestNpmVersion(cliCatalog[provider].packageName, networkRegion)
  }

  async function inspectCliUpdate(
    provider: ProviderId,
    forceRefresh = false,
  ): Promise<CliStatus> {
    if (forceRefresh) invalidateCliUpdateCache(provider)
    const npm = await inspectTool('npm')
    const npmGlobalRoot = await resolveNpmGlobalRoot(npm.path, commandEnvironment())
    const { status } = await inspectCliTool(provider, npm.path, npmGlobalRoot)
    const networkRegion = provider !== 'grok' && status.installed
      ? await inspectNetworkRegion()
      : 'unknown'
    const latest = await inspectCliLatestVersion(provider, status, networkRegion)
    return buildCliStatus(status, latest)
  }

  async function scanSystem(forceRefresh = false): Promise<SystemSnapshot> {
    if (forceRefresh) {
      npmLatestCacheGeneration += 1
      npmLatestCache.clear()
      grokLatestInFlight.clear()
      networkLocationCache = null
    }
    const [nodeResult, npmResult, pythonResult, codexDesktopResult, networkResult] = await Promise.allSettled([
      inspectNode(),
      inspectTool('npm'),
      inspectPython(),
      inspectCodexDesktopUpdate(forceRefresh),
      inspectNetworkLocation(),
    ])
    // 单个探测异常不再丢弃整份快照；失败项降级为可区分的「检测失败」状态
    const node = buildToolStatusFromSettled(nodeResult)
    const npm = buildToolStatusFromSettled(npmResult)
    const python = buildToolStatusFromSettled(pythonResult)
    const codexDesktop = buildDesktopAppStatusFromSettled(codexDesktopResult)
    const network = buildNetworkLocationStatusFromSettled(networkResult)
    const npmGlobalRoot = await resolveNpmGlobalRoot(npm.path, commandEnvironment())
    // 单个 CLI 探测异常时降级为未安装，避免拖垮整份系统快照
    const cliProbes = await Promise.allSettled(
      providerIds.map((id) => inspectCliTool(id, npm.path, npmGlobalRoot)),
    )
    const cliResults: ToolStatus[] = cliProbes.map((probe) => (probe.status === 'fulfilled'
      ? probe.value.status
      : { installed: false, version: null, path: null, installDirectory: null }))
    const networkRegion = network.region

    const latestProbes = await Promise.allSettled(
      providerIds.map((id, index) => inspectCliLatestVersion(
        id,
        cliResults[index],
        networkRegion,
      )),
    )
    const latestVersions: LatestVersionProbe[] = latestProbes.map((probe, index) => (
      probe.status === 'fulfilled'
        ? probe.value
        : {
            status: 'failed',
            version: null,
            source: providerIds[index] === 'grok' ? 'official-manifest' : 'npm',
            checkedAt: new Date().toISOString(),
            error: probe.reason instanceof Error ? probe.reason.message : String(probe.reason),
          }
    ))
    const clis = Object.fromEntries(providerIds.map((id, index) => {
      const status = cliResults[index]
      return [id, buildCliStatus(status, latestVersions[index])]
    })) as Record<ProviderId, CliStatus>

    return {
      checkedAt: new Date().toISOString(),
      network,
      runtime: { node, npm, python },
      clis,
      desktopApps: { codex: codexDesktop },
    }
  }

  async function inspectCodexSetupStatus(): Promise<CodexSetupStatus> {
    const [nodeResult, npmResult, desktopResult] = await Promise.allSettled([
      inspectNode(),
      inspectTool('npm'),
      inspectCodexDesktop(),
    ])
    // 三路探测彼此独立；任一异常都不应连累其余两个已知结果（同 scanSystem，见 317b34f）
    const node = buildToolStatusFromSettled(nodeResult)
    const npm = buildToolStatusFromSettled(npmResult)
    const desktop = buildDesktopAppStatusFromSettled(desktopResult)
    const npmGlobalRoot = await resolveNpmGlobalRoot(npm.path, commandEnvironment())
    // CLI 探测依赖上面 npm 探测的结果，只能顺序执行、无法并入 allSettled；
    // 同样降级为「检测失败」而非「未安装」，避免向导误判并对已在正常工作的 CLI 触发重装
    const [cliSettled] = await Promise.allSettled([inspectCliTool('codex', npm.path, npmGlobalRoot)])
    const cli = buildCliToolStatusFromSettled(cliSettled)
    return { checkedAt: new Date().toISOString(), runtime: { node, npm }, cli, desktop }
  }

  async function installNodeRuntimeOperation(target: RendererMessageTarget): Promise<NodeRuntimeInstallResult> {
    if (nodeRuntimeInstalling) throw new Error('Node.js 正在安装中，请等待当前任务完成')
    nodeRuntimeInstalling = true
    try {
      return await installNodeRuntimeLts({
        networkRegion: await inspectNetworkRegion(),
        temporaryDirectoryMode: windowsExecutionMode,
        onProgress: (progress) => {
          if (!target.isDestroyed()) target.send('runtime:node-install-progress', progress)
        },
      })
    } finally {
      nodeRuntimeInstalling = false
    }
  }

  function installNodeRuntime(target: RendererMessageTarget): Promise<NodeRuntimeInstallResult> {
    return installationQueue.enqueue('runtime:node', () => installNodeRuntimeOperation(target))
  }

  function sendInstallProgress(
    target: RendererMessageTarget,
    provider: ProviderId,
    state: 'started' | 'output' | 'success' | 'error',
    message: string,
  ): void {
    if (!target.isDestroyed()) target.send('cli:install-progress', { provider, state, message })
  }

  async function findNpmForCliInstall(
    provider: ProviderId,
    target: RendererMessageTarget,
  ): Promise<string | null> {
    if (process.platform !== 'win32') {
      return findExecutable('npm', {
        env: commandEnvironment(),
        windowsPackageManagers: ['npm'],
      })
    }

    const trustedOnly = windowsExecutionMode === 'trusted-only'
    const findUsableNpm = () => findExecutable('npm', {
      env: trustedOnly ? trustedCommandEnvironment() : commandEnvironment(),
      windowsPackageManagers: ['npm'],
      trustedOnly,
    })
    let npmExecutable = await findUsableNpm()
    if (npmExecutable) return npmExecutable

    sendInstallProgress(
      target,
      provider,
      'output',
      `未检测到${trustedOnly ? '系统级' : '可用的'} Node.js/npm，正在自动安装 Node.js LTS`,
    )
    if (nodeRuntimeInstalling) throw new Error('Node.js 正在安装中，请等待当前任务完成')
    nodeRuntimeInstalling = true
    try {
      await installNodeRuntimeLts({
        networkRegion: await inspectNetworkRegion(),
        temporaryDirectoryMode: windowsExecutionMode,
        onProgress: (progress) => {
          if (progress.message) sendInstallProgress(target, provider, 'output', progress.message)
        },
      })
    } finally {
      nodeRuntimeInstalling = false
    }
    npmExecutable = await findUsableNpm()
    if (!npmExecutable) {
      throw new Error('Node.js 安装完成后仍未检测到可用的 npm，请重启本程序后再试')
    }
    return npmExecutable
  }

  async function installCliOperation(provider: ProviderId, target: RendererMessageTarget): Promise<void> {
    const grokInstallStrategy = provider === 'grok' ? grokInstallStrategyFor(platform) : null
    if (installing.has(provider)) throw new Error(`${cliCatalog[provider].name} 正在安装中`)
    installing.add(provider)
    const definition = cliCatalog[provider]
    let downloadedGrokBinary: DownloadedGrokBinary | null = null
    let managedNpmLayout: ManagedNpmLayout | null = null
    let managedNpmTransaction: string | null = null
    let preserveManagedNpmTransaction = false
    try {
      if (provider === 'grok') {
        if (grokInstallStrategy === 'external') {
          throw new Error('当前平台不支持 Grok CLI 一键安装')
        }
        if (grokInstallStrategy === 'windows-native') {
          const sameUserInstall = windowsExecutionMode === 'same-user'
          const installedBefore = await findInstalledExecutable(definition.command)
          sendInstallProgress(
            target,
            provider,
            'started',
            `正在从 xAI 官方下载并验证已签名的 Grok CLI ${installedBefore ? '更新' : '安装'}包`,
          )
          let lastReportedBucket = -1
          downloadedGrokBinary = await downloadLatestGrokBinary({
            createTemporaryDirectory: () => createInstallTemporaryDirectory('grok-binary'),
            onProgress: ({ percent, transferred, total }) => {
              const bucket = Math.floor(percent / 5)
              if (bucket === lastReportedBucket && percent !== 100) return
              lastReportedBucket = bucket
              sendInstallProgress(
                target,
                provider,
                'output',
                `Grok CLI 下载 ${percent}%（${Math.floor(transferred / 1024 / 1024)} / ${Math.floor(total / 1024 / 1024)} MiB）`,
              )
            },
          })
          sendInstallProgress(
            target,
            provider,
            'output',
            `xAI 签名与文件校验通过（${downloadedGrokBinary.version}，SHA-256 ${downloadedGrokBinary.sha256Hex.slice(0, 16)}…）`,
          )
          const installed = await installDownloadedGrokBinary(downloadedGrokBinary, sameUserInstall
            ? {
                managedRoot: path.join(os.homedir(), '.grok', 'bin'),
                protectInstallDirectory: false,
              }
            : {})
          invalidateCliUpdateCache(provider)
          const verification = await inspectCliTool(provider, null, null, installed.executablePath)
          if (
            !verification.installation
            || !verification.status.version
            || verification.status.version !== installed.version
            || path.resolve(verification.installation.commandPath) !== path.resolve(installed.executablePath)
          ) {
            throw new Error('Grok CLI 安装后验证失败：未识别到托管可执行文件或版本不一致')
          }
          sendInstallProgress(
            target,
            provider,
            'success',
            `${definition.name} ${installedBefore ? '更新' : '安装'}完成（${installed.version}）`,
          )
          return
        }
      }

      const npmExecutable = await findNpmForCliInstall(provider, target)
      let installPrefix: string | null = null
      if (process.platform === 'win32' && windowsExecutionMode === 'trusted-only') {
        managedNpmLayout = await ensureManagedNpmLayout()
      } else if (platform === 'darwin' && provider !== 'grok') {
        managedNpmLayout = await ensureManagedNpmLayout({
          platform: 'darwin',
          env: commandEnvironment(),
        })
      }
      managedNpmTransaction = await createInstallTemporaryDirectory('npm-transaction', {
        ...(managedNpmLayout ? { baseDirectory: managedNpmLayout.cacheRoot } : {}),
      })
      sendInstallProgress(target, provider, 'output', '正在从 npm 官方源校验最新版本和 SHA-512 完整性元数据')
      const trustedRelease = await resolveCliInstallRelease(provider, grokInstallStrategy)
      if (!npmExecutable) throw new Error('未检测到 npm，请先安装 Node.js')
      const networkRegion = await inspectNetworkRegion()
      // Derived from the routing rather than restated, so the line can never
      // claim one registry while npmInstallRegistries picks the other. That had
      // already happened once: the unknown branch still advertised the official
      // registry after the ordering moved to mirror-first.
      const [primaryRegistry] = npmInstallRegistries(networkRegion)
      const primaryLabel = primaryRegistry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'
      // 策略钉死时 networkRegion 是归约值而非探测结果，"检测到"的措辞会撒谎。
      const regionLabel = store.read().mirrorPolicy
        ? '已按设置固定安装源顺序'
        : networkRegion === 'mainland-china'
          ? '检测到中国大陆网络'
          : networkRegion === 'outside-mainland-china'
            ? '检测到非中国大陆网络'
            : '未能识别网络区域，按国内网络处理'
      const action = `${regionLabel}，正在通过${primaryLabel}安装已校验版本 ${definition.packageName}@${trustedRelease.version}`
      sendInstallProgress(target, provider, 'started', action)
      const transaction = managedNpmTransaction
      const npmUserConfig = managedNpmLayout?.userConfig ?? path.join(transaction, 'npmrc')
      if (!managedNpmLayout) {
        const handle = await fs.promises.open(npmUserConfig, 'wx', 0o600)
        await handle.close()
      }
      /**
       * The dependency-graph resolution and the package download are timed
       * separately. Sharing one budget meant a slow official resolution ate the
       * time the download still needed, and a legitimately slow resolution was
       * being killed at five minutes as if it had hung.
       */
      const executeNpm = async (
        argv: string[],
        cwd: string,
        cache: string,
        timeoutMs = npmDownloadTimeoutMs,
      ) => {
        // 提权执行会对 argv 里的每个绝对路径做 realpath，路径不存在即判定为
        // 「位于用户可写目录」而拒绝。npm 自己会建缓存目录，但那发生在校验之后。
        await fs.promises.mkdir(cache, { recursive: true })
        const trustedOnly = process.platform === 'win32' && windowsExecutionMode === 'trusted-only'
        return executeCommand({
          executable: npmExecutable,
          argv: [
            ...argv,
            `--cache=${cache}`,
            `--userconfig=${npmUserConfig}`,
            '--audit=false',
            '--fund=false',
          ],
          windowsPackageManager: 'npm',
        }, {
          env: trustedOnly ? trustedCommandEnvironment() : commandEnvironment(),
          trustedOnly,
          trustedPaths: managedNpmLayout
            ? [npmUserConfig, transaction]
            : undefined,
          cwd,
          timeoutMs,
          maxOutputBytes: 8 * 1024 * 1024,
          onOutput: ({ text }) => {
            const message = text.trim()
            if (message) sendInstallProgress(target, provider, 'output', message)
          },
        })
      }
      const createResolutionManifest = async (directory: string) => {
        await fs.promises.mkdir(directory, { recursive: true })
        const manifestPath = path.join(directory, 'package.json')
        const handle = await fs.promises.open(manifestPath, 'wx', 0o600)
        try {
          await handle.writeFile(`${JSON.stringify({
            name: 'xingmang-cli-resolution',
            version: '1.0.0',
            private: true,
            dependencies: { [definition.packageName]: trustedRelease.version },
          }, null, 2)}\n`, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
      /**
       * npm emits nothing during `--package-lock-only`, so without a heartbeat
       * the window sits on one static line for minutes and users conclude the
       * app has hung. The ticker only reports elapsed time; it never guesses at
       * a completion percentage it cannot know.
       */
      const resolveDependencyGraph = async (
        registry: string,
        resolution: string,
        cache: string,
      ) => {
        sendInstallProgress(target, provider, 'output', npmResolutionStartMessage(registry))
        const startedAt = Date.now()
        const ticker = setInterval(() => {
          sendInstallProgress(
            target,
            provider,
            'output',
            npmResolutionHeartbeatMessage(registry, Date.now() - startedAt),
          )
        }, npmResolutionHeartbeatMs)
        try {
          await executeNpm([
            'install',
            '--package-lock-only',
            '--ignore-scripts',
            '--omit=dev',
            `--registry=${registry}`,
          ], resolution, cache, npmResolutionTimeoutMs)
        } finally {
          clearInterval(ticker)
        }
      }

      const officialResolution = path.join(transaction, 'official-resolution')
      const officialCache = path.join(transaction, 'official-cache')
      await createResolutionManifest(officialResolution)
      await resolveDependencyGraph(npmOfficialRegistry, officialResolution, officialCache)
      const officialLock = await readBoundedUtf8File(
        path.join(officialResolution, 'package-lock.json'),
        maximumNpmPackageLockBytes,
        'npm 官方 package-lock.json',
      )
      assertNpmReleaseMatchesOfficialLock(trustedRelease, officialLock)
      const registries = npmInstallRegistries(networkRegion)
      const installErrors: string[] = []
      let installed = false
      let verification: Awaited<ReturnType<typeof inspectCliTool>> | null = null
      for (const [index, registry] of registries.entries()) {
        if (index > 0) {
          sendInstallProgress(
            target,
            provider,
            'output',
            `${registries[0] === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'}安装失败，正在切换${registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'} ${registry}`,
          )
        }
        try {
          const attemptRoot = path.join(transaction, `attempt-${index}`)
          const resolution = path.join(attemptRoot, 'resolution')
          const cache = path.join(attemptRoot, 'cache')
          const attemptPrefix = managedNpmLayout
            ? path.join(attemptRoot, 'staged-prefix')
            : null
          await createResolutionManifest(resolution)
          await resolveDependencyGraph(registry, resolution, cache)
          const candidateLock = await readBoundedUtf8File(
            path.join(resolution, 'package-lock.json'),
            maximumNpmPackageLockBytes,
            `${registry === npmMirrorRegistry ? '国内镜像' : 'npm 官方'} package-lock.json`,
          )
          assertNpmPackageLocksEquivalent(
            officialLock,
            candidateLock,
            definition.packageName,
            trustedRelease.version,
          )
          sendInstallProgress(
            target,
            provider,
            'output',
            `${registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'}完整依赖图与官方 SHA-512 对账通过，正在下载校验包缓存`,
          )
          await executeNpm([
            'ci',
            '--ignore-scripts',
            '--omit=dev',
            `--registry=${registry}`,
            '--replace-registry-host=always',
          ], resolution, cache)
          if (managedNpmLayout && attemptPrefix) {
            await fs.promises.cp(managedNpmLayout.prefix, attemptPrefix, {
              recursive: true,
              force: false,
              errorOnExist: true,
            })
          }
          const plan = buildCliMaintenancePlan(
            provider,
            npmExecutable,
            attemptPrefix,
            trustedRelease.version,
            true,
            platform,
          )
          const lifecycle = () => executeNpm([
            ...plan.argv,
            '--offline',
            `--registry=${registry}`,
          ], resolution, cache).then(() => undefined)
          if (provider === 'grok' && grokInstallStrategy === 'darwin-official-npm') {
            verification = await runDarwinGrokPostInstallTransaction({
              homeDirectory: os.homedir(),
              lifecycle,
              verify: async () => {
                const inspected = await inspectVerifiedDarwinGrokPostInstall({
                  homeDirectory: os.homedir(),
                  expectedVersion: trustedRelease.version,
                  runCommand: buildDarwinTrustedVerificationRunner(executeCommand),
                })
                if (!inspected.installation || inspected.status.version !== trustedRelease.version) {
                  throw new Error(`${definition.name} 安装后服务验证失败，已恢复更新前版本`)
                }
                return inspected
              },
            })
          } else {
            await lifecycle()
          }
          installPrefix = attemptPrefix
          installed = true
          break
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          installErrors.push(
            `${registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'}：${redactCommandText(detail).replace(/\s+/g, ' ').trim().slice(0, 300) || '安装失败'}`,
          )
        }
      }
      if (!installed) {
        throw new Error(`${definition.name} 安装失败：${installErrors.join('；') || '所有 npm 源均不可用'}`)
      }
      invalidateCliUpdateCache(provider)
      const stagedManifest = installPrefix
        ? path.join(
            installPrefix,
            ...(platform === 'darwin' ? ['lib', 'node_modules'] : ['node_modules']),
            ...definition.packageName.split('/'),
            'package.json',
          )
        : null
      if (stagedManifest) {
        const stagedVersion = await readPackageManifestVersion(
          stagedManifest,
          `${definition.name} staged package.json`,
        )
        if (stagedVersion !== trustedRelease.version) {
          throw new Error(`${definition.name} 暂存安装验证失败：版本或 package.json 无效`)
        }
      }

      if (managedNpmLayout && managedNpmTransaction && installPrefix) {
        await replaceManagedNpmPrefixAtomically(
          managedNpmLayout.prefix,
          installPrefix,
          managedNpmTransaction,
          async () => {
            invalidateCliUpdateCache(provider)
            const promoted = await inspectCliTool(
              provider,
              npmExecutable,
              path.join(
                managedNpmLayout!.prefix,
                ...(platform === 'darwin' ? ['lib', 'node_modules'] : ['node_modules']),
              ),
            )
            if (
              !promoted.installation
              || promoted.status.version !== trustedRelease.version
              || !isManagedNpmInstallation(promoted.installation)
            ) {
              throw new Error(`${definition.name} 提交后验证失败，已恢复更新前版本`)
            }
            verification = promoted
          },
        )
      } else if (provider !== 'grok' || grokInstallStrategy !== 'darwin-official-npm') {
        const npmGlobalRoot = await resolveNpmGlobalRoot(npmExecutable, commandEnvironment())
        verification = await inspectCliTool(provider, npmExecutable, npmGlobalRoot)
      }
      const darwinGrokVerified = provider === 'grok' && grokInstallStrategy === 'darwin-official-npm'
      if (!darwinGrokVerified && (
        !verification?.installation
        || verification.status.version !== trustedRelease.version
        || (managedNpmLayout && !isManagedNpmInstallation(verification.installation))
      )) {
        throw new Error(`${definition.name} npm 命令已结束，但未在托管目录识别到有效安装和版本`)
      }
      sendInstallProgress(
        target,
        provider,
        'success',
        `${definition.name} 安装或更新完成（${verification!.status.version}）`,
      )
    } catch (error) {
      if (error instanceof ManagedNpmRollbackError) {
        preserveManagedNpmTransaction = error.preserveTransaction
      }
      const message = error instanceof Error ? error.message : String(error)
      sendInstallProgress(target, provider, 'error', message)
      throw error
    } finally {
      if (downloadedGrokBinary) await cleanupDownloadedGrokBinary(downloadedGrokBinary)
      if (managedNpmTransaction && !preserveManagedNpmTransaction) {
        await fs.promises.rm(managedNpmTransaction, { recursive: true, force: true }).catch(() => undefined)
      }
      installing.delete(provider)
    }
  }

  function installCli(provider: ProviderId, target: RendererMessageTarget): Promise<void> {
    return installationQueue.enqueue(`cli:install:${provider}`, () => installCliOperation(provider, target))
  }

  async function removeDirectoryFromUserPath(directory: string): Promise<void> {
    if (process.platform !== 'win32') return
    const script = [
      '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      '$target = [IO.Path]::GetFullPath($env:XINGMANG_REMOVE_PATH).TrimEnd("\\")',
      '$current = [Environment]::GetEnvironmentVariable("Path", "User")',
      '$next = @(($current -split ";") | Where-Object {',
      '  if (-not $_) { return $false }',
      '  try { [IO.Path]::GetFullPath($_).TrimEnd("\\") -ine $target } catch { $true }',
      '}) -join ";"',
      '[Environment]::SetEnvironmentVariable("Path", $next, "User")',
    ].join('\n')
    await execFileAsync(resolveWindowsPowerShellExecutable(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], {
      env: { ...trustedCommandEnvironment(), XINGMANG_REMOVE_PATH: directory },
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 1024 * 1024,
    })
  }

  async function uninstallNativeGrok(installation: CliInstallation): Promise<void> {
    const cliEnvironment = commandEnvironment()
    const homeDirectory = cliEnvironment.HOME?.trim() || os.homedir()
    const userDirectory = path.resolve(homeDirectory, '.grok', 'bin')
    if (platform === 'darwin') {
      await uninstallVerifiedDarwinGrokInstallation({
        homeDirectory,
        installDirectory: installation.installDirectory,
        runCommand: buildDarwinTrustedVerificationRunner(executeCommand),
      })
      return
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
    if (!managed) await removeDirectoryFromUserPath(result.directory)
  }

  async function uninstallNativeClaude(installation: CliInstallation): Promise<void> {
    const expectedDirectory = path.resolve(os.homedir(), '.local', 'bin')
    await uninstallVerifiedNativeCliFiles({
      actualDirectory: installation.installDirectory,
      expectedDirectory,
      fileNames: [process.platform === 'win32' ? 'claude.exe' : 'claude'],
      label: 'Claude Code',
      platform: process.platform,
      removeDirectoryWhenEmpty: false,
    })
  }

  function isManagedNpmInstallation(installation: CliInstallation): boolean {
    if ((platform !== 'win32' && platform !== 'darwin') || !installation.npmPrefix) return false
    const expected = managedNpmPrefix(commandEnvironment(), platform)
    return sameLocalPathIdentity(expected, installation.npmPrefix)
  }

  async function uninstallCliOperation(provider: ProviderId): Promise<ToolUninstallResult> {
    if (installing.has(provider)) throw new Error(`${cliCatalog[provider].name} 正在安装、更新或卸载中`)
    installing.add(provider)
    try {
      const npmTool = await inspectTool('npm')
      const npmGlobalRoot = await resolveNpmGlobalRoot(npmTool.path, commandEnvironment())
      const initial = await inspectCliTool(provider, npmTool.path, npmGlobalRoot)
      if (!initial.status.installed || !initial.installation) {
        return { outcome: 'not-installed', previousVersion: null }
      }
      let current = initial
      const removedInstallations: string[] = []
      for (let attempt = 0; attempt < 8 && current.installation; attempt += 1) {
        const installation = current.installation
        const uninstall = current.status.uninstall
          ?? cliUninstallCapability(provider, installation, { platform, windowsExecutionMode })
        if (!uninstall.available) {
          throw new Error([
            uninstall.reason,
            uninstall.manualCommand ? `请在普通 PowerShell 中运行：${uninstall.manualCommand}` : null,
          ].filter(Boolean).join('；'))
        }
        if (uninstall.delegated) {
          // 包自带的卸载脚本位于用户可写目录，绝不能拿主进程的管理员令牌去跑。
          if (!uninstall.manualCommand) throw new Error('缺少可执行的卸载命令')
          await launchUnelevatedCommandWindow({
            commandLine: uninstall.manualCommand,
            title: `Uninstall ${cliCatalog[provider].packageName}`,
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
            ?? npmTool.path
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
          } finally {
            if (cache) await fs.promises.rm(cache, { recursive: true, force: true }).catch(() => undefined)
          }
          if (fs.existsSync(plan.packageRoot)) {
            throw new Error(`${cliCatalog[provider].name} 的 npm 包目录仍然存在，卸载未完成`)
          }
        } else if (plan.kind === 'grok-native') {
          try {
            await uninstallNativeGrok(installation)
          } catch (error) {
            if (platform === 'darwin') {
              return grokManualUninstallResult(initial.status.version, error)
            }
            throw error
          }
        } else {
          await uninstallNativeClaude(installation)
        }
        removedInstallations.push(installation.installDirectory)
        current = await inspectCliTool(provider, npmTool.path, npmGlobalRoot)
      }
      if (current.status.installed) {
        const removed = removedInstallations.length
          ? `已移除 ${removedInstallations.length} 个安装：${removedInstallations.join('；')}。`
          : '未移除任何安装。'
        const remaining = current.installation?.installDirectory ?? current.status.path ?? '未知目录'
        throw new Error(`${removed}仍检测到 ${cliCatalog[provider].name}：${remaining}`)
      }
      invalidateCliUpdateCache(provider)
      return { outcome: 'uninstalled', previousVersion: initial.status.version }
    } finally {
      installing.delete(provider)
    }
  }

  function uninstallCli(provider: ProviderId): Promise<ToolUninstallResult> {
    return installationQueue.enqueue(`cli:uninstall:${provider}`, () => uninstallCliOperation(provider))
  }

  function spawnDetached(
    executable: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; windowsHide?: boolean },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { ...options, detached: true, stdio: 'ignore' })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
  }

  // Owns the Codex Desktop version-probe caches and the install/uninstall/
  // launch busy lock in its own closure; only the pieces that cross the
  // CLI-launch trust boundary or touch the shared installation queue are
  // threaded through explicitly.
  const {
    inspectCodexDesktop,
    inspectCodexDesktopUpdate,
    installCodexDesktop,
    uninstallCodexDesktop,
    launchCodexDesktop,
  } = createCodexDesktopService({
    platform,
    windowsExecutionMode,
    installationQueue,
    createInstallTemporaryDirectory,
    detectMacosCodexApp,
    resolveVerifiedCliCommand,
    executeCommand,
    codexEnv,
    store,
    inspectNativeProviderConfig,
    spawnDetached,
  })

  async function launchProviderOperation(provider: ProviderId, workspace: string): Promise<void> {
    const nativeConfig = inspectNativeProviderConfig(provider)
    if (!nativeConfig.hasApiKey || !nativeConfig.matchesRelay) {
      throw new Error('当前 CLI 不是星芒 AI 配置，请先保存星芒 AI 配置')
    }
    if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
      throw new Error('工作目录不存在，请重新选择')
    }

    const definition = cliCatalog[provider]
    const providerEnv = providerEnvironment(provider)
    const npmTool = await inspectTool('npm')
    const npmGlobalRoot = await resolveNpmGlobalRoot(npmTool.path, commandEnvironment())
    const { installation } = await inspectCliTool(provider, npmTool.path, npmGlobalRoot)
    if (!installation) throw new Error(`未检测到 ${definition.name}，请先安装`)

    if (platform === 'win32') {
      let command
      try {
        command = await resolveVerifiedCliCommand(provider, providerEnv, windowsExecutionMode)
        if (windowsExecutionMode === 'trusted-only') {
          assertTrustedElevatedCliCommand(command, definition.name)
        }
        await launchCliPowerShell({
          executable: command.executable,
          argv: command.argv,
          workspace,
          title: `${definition.name} · 星芒AI`,
          // The broker starts this terminal with Start-Process, so it inherits
          // the elevated token. Without the trusted base, NODE_OPTIONS and the
          // other injection variables would cross the integrity boundary and
          // run attacker code as administrator. assertTrustedElevatedCliCommand
          // only vets the executable path and cannot see the environment.
          env: interactiveTerminalEnvironment(
            providerEnv,
            windowsExecutionMode === 'trusted-only' ? trustedCommandEnvironment : commandEnvironment,
          ),
        })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`未能打开 ${definition.name}：${detail || '请查看反馈与诊断日志'}`)
      }
      return
    }

    if (platform === 'darwin') {
      try {
        const command = await resolveVerifiedCliCommand(provider, providerEnv, windowsExecutionMode, {
          darwinStagingRetention: 'retained',
        })
        await launchMacosTerminal(buildDarwinCliLaunchPlan(command, workspace, providerEnv))
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`未能打开 ${definition.name}：${detail || '请查看反馈与诊断日志'}`)
      }
      return
    }

    const environment = interactiveTerminalEnvironment(providerEnv)
    const command = await resolveVerifiedCliCommand(provider, providerEnv, windowsExecutionMode)
    const terminals = [
      { command: 'x-terminal-emulator', args: ['-e', command.executable, ...command.argv] },
      { command: 'gnome-terminal', args: ['--', command.executable, ...command.argv] },
      { command: 'konsole', args: ['-e', command.executable, ...command.argv] },
    ]
    let terminal = terminals[0]
    for (const candidate of terminals) {
      if (await findExecutable(candidate.command, { env: environment })) {
        terminal = candidate
        break
      }
    }
    await spawnDetached(terminal.command, terminal.args, { cwd: workspace, env: environment })
  }

  function launchProvider(provider: ProviderId, workspace: string): Promise<void> {
    return installationQueue.enqueue(
      `cli:launch:${provider}`,
      () => launchProviderOperation(provider, workspace),
    )
  }

  async function fetchAvailableModels(apiKeyInput: string): Promise<string[]> {
    const apiKey = apiKeyInput.trim()
    if (!apiKey) throw new Error('请先填写 API Key')
    // Reject any C0/C1 control character, not just CR/LF. A relay API key is a
    // single opaque bearer token with no legitimate embedded control byte; an
    // embedded NUL otherwise reaches undici's fetch below, which throws with
    // the raw "Bearer <key…>" sequence in its message -- and redactCommandText's
    // Bearer rule stops at the first non-token char, leaving the tail past the
    // NUL in the clear in both the runtime log and the renderer-facing failure
    // reason. This one chokepoint covers both models:list and config:save (the
    // latter funnels through fetchAvailableModels before writing).
    if (/[\x00-\x1F\x7F]/.test(apiKey)) throw new Error('API Key 格式错误')

    const now = Date.now()
    for (const [key, entry] of modelAccessCache) {
      if (entry.expiresAt <= now) modelAccessCache.delete(key)
    }
    // Site id joins the cache key: the same API key can be pointed at a
    // different relay site within the 2-minute TTL (site switcher), and a
    // model list fetched from the previous site must not validate a model
    // that then gets written into a config aimed at the new site.
    const activeSite = resolveRelaySite(store.read().relaySiteId)
    const cacheKey = `${activeSite.id}:${modelAccessCacheKey(apiKey)}`
    const cached = modelAccessCache.get(cacheKey)
    if (cached) {
      modelAccessCache.delete(cacheKey)
      modelAccessCache.set(cacheKey, cached)
      return [...cached.models]
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12_000)
    try {
      const response = await fetch(`${relayApiProbeBaseUrl(activeSite)}/v1/models`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
        redirect: 'error',
        signal: controller.signal,
      })
      const body = await readBoundedResponseText(response, maximumModelResponseBytes, '模型接口')
      if (!response.ok) {
        let detail = ''
        try {
          const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown }
          const message = parsed.error?.message ?? parsed.message
          if (typeof message === 'string') detail = safeRelayErrorMessage(message, apiKey)
        } catch {
          detail = ''
        }
        throw new Error(detail || `模型查询失败，服务返回 ${response.status}`)
      }

      let payload: unknown
      try {
        payload = JSON.parse(body) as unknown
      } catch {
        throw new Error('模型接口返回的不是有效 JSON')
      }
      const models = parseModelIds(payload)
      if (!models.length) throw new Error('当前 API Key 没有返回可用模型')
      while (modelAccessCache.size >= modelAccessCacheMaxEntries) {
        const oldestKey = modelAccessCache.keys().next().value as string | undefined
        if (!oldestKey) break
        modelAccessCache.delete(oldestKey)
      }
      modelAccessCache.set(cacheKey, {
        expiresAt: Date.now() + 2 * 60_000,
        models: [...models],
      })
      return [...models]
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('模型查询超时，请检查网络后重试')
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  function buildConfigSummary(previewOnboarding: boolean): AppConfigSummary {
    const stored = store.read()
    const result = {
      workspace: stored.workspace,
      providers: Object.fromEntries(
        providerIds.map((id) => [id, toNativeConfigSummary(inspectNativeProviderConfig(id))]),
      ) as Record<ProviderId, NativeConfigSummary>,
    }
    if (previewOnboarding) {
      result.providers.codex = {
        ...result.providers.codex,
        actualBaseUrl: '',
        exists: false,
        hasApiKey: false,
        matchesRelay: false,
        apiKeyPreview: null,
        model: '',
        updatedAt: null,
        files: result.providers.codex.files.map((file) => ({ ...file, exists: false })),
      }
    }
    return result
  }

  function inspectCodexReadiness(previewOnboarding: boolean): CodexReadinessStatus {
    if (previewOnboarding) return { hasApiKey: false, matchesRelay: false }
    const codex = inspectNativeProviderConfig('codex')
    return { hasApiKey: codex.hasApiKey, matchesRelay: codex.matchesRelay }
  }

  function revealApiKey(provider: ProviderId, previewOnboarding: boolean): string {
    if (previewOnboarding) return ''
    return inspectNativeProviderConfig(provider).apiKey
  }

  async function saveConfig(payload: ConfigSavePayload, previewOnboarding: boolean) {
    const model = payload.model.trim()
    // An empty key is an explicit renderer sentinel: reuse the key already held by the main process.
    const apiKey = payload.apiKey.trim() || inspectNativeProviderConfig(payload.provider).apiKey
    if (!apiKey) throw new Error('请先填写 API Key')
    const availableModels = await fetchAvailableModels(apiKey)
    if (!availableModels.includes(model)) {
      throw new Error(`当前 API Key 不支持模型 ${model}，请重新检测并选择可用模型`)
    }
    if (previewOnboarding && payload.provider === 'codex') return { backups: [], files: [] }
    // Read fresh at write time (not captured at service-construction time) so
    // a settings change takes effect on the very next save without requiring
    // a service restart.
    const activeSite = resolveRelaySite(store.read().relaySiteId)
    return saveProviderConfig(
      payload.provider,
      apiKey,
      payload.model,
      payload.mode,
      providerRoots,
      {},
      activeSite.providerBaseUrls,
    )
  }

  return {
    readStoredConfig: () => store.read(),
    updateStoredConfig: (update) => store.update(update),
    inspectCodexReadiness,
    getConfig: buildConfigSummary,
    revealApiKey,
    saveConfig,
    scanSystem,
    inspectCodexSetupStatus,
    installNodeRuntime,
    installCli,
    uninstallCli,
    inspectCliUpdate,
    installCodexDesktop,
    uninstallCodexDesktop,
    inspectCodexDesktopUpdate,
    launchProvider,
    inspectCodexDesktop,
    launchCodexDesktop,
    fetchAvailableModels,
  }
}
