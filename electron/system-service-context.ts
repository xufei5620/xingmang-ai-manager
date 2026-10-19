// 系统服务各簇共用的那一份上下文（#1070 第 2 步，从 system-service.ts 的 createSystemService 开头原样搬来）：
// 选项解析成实际用的那一份（测试注入的替身或缺省实现）、几份记录文件、安装和保存配置的排队，以及只靠这些
// 就能做的几样（找命令、跑 --version、下载加速、临时目录、装之前看盘）。后面各簇搬出 system-service.ts 时
// 都拿这一份，不再各自去翻 serviceOptions，簇与簇之间也不互相 import。
//
// 这里只 import system-service.ts 的类型：值要是也从那边拿，两个文件就互相 require 了。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppSettingsStore } from './app-settings'
import { cliCatalog, type ProviderId } from './catalog'
import {
  describeOccupiedUpdateFailure,
  fileLockErrorCode,
  probeRunningCliProcesses,
  type OccupiedUpdateFailureInput,
} from './cli-process-probe'
import { CliUpdateHistoryStore } from './cli-update-history'
import { defaultProviderConfigRoots } from './codex-home'
import {
  commandEnvironment,
  findExecutable,
  isTrustedHighIntegrityExecutable,
  primeTrustedHighIntegrityExecutable,
  redactCommandText,
  runCommand,
  trustedCommandEnvironment,
  type WindowsPackageManager,
} from './command-runner'
import { inspectProviderConfig, type NativeConfigInspection } from './config-files'
import type { DesktopBucketOptions } from './desktop-package-bucket'
import { describeInsufficientDiskSpace, readDiskSpace, tightestDiskSpace } from './disk-space'
import type { DownloadAccelerationLease } from './download-acceleration'
import { ExternalClientOwnershipStore } from './external-client-ownership'
import { installGitRuntime as installGitForWindows } from './git-runtime-install'
import { InstallCancellationRegistry } from './install-cancellation'
import { InstallationQueue } from './installation-queue'
import { installLinuxNodeRuntime } from './linux-node-runtime'
import { launchLinuxTerminal } from './linux-terminal'
import { managedCliRoot, managedNpmPrefix } from './managed-cli-paths'
import { inspectMacosCodexApp } from './macos-codex-app'
import { installMacGitRuntime } from './macos-git-install'
import { installDarwinNodeRuntime, resolveDarwinPreferredNodeDirectory } from './macos-node-runtime'
import { launchMacosTerminal } from './macos-platform'
import {
  inspectWindowsRestartRequired,
  installNodeRuntime as installNodeRuntimeLts,
} from './node-runtime'
import { fetchOfficialChatGptUsage } from './official-account-usage'
import { sameLocalPathIdentity } from './path-identity'
import { ProjectInstructionsStateStore } from './project-instructions'
import {
  inspectInstalledPythonRuntime,
  installPythonRuntime as installPythonRuntime312,
} from './python-runtime'
import { createRelayEndpointRoutingSnapshot, relaySiteForProviderBaseUrl, type RelaySite } from './relay-sites'
import { bypassClosedLoopbackProxies, describeDroppedProxies, probeLoopbackProxy } from './stale-proxy-environment'
import { redactHomeDirectory } from './startup-log'
import type { SystemServiceOptions } from './system-service'
import { ToolConfigOwnershipStore } from './tool-config-ownership'
import { resolveCliCommand, resolveCliInstallation, resolveNpmGlobalRoot, type CliInstallation } from './tool-installation'
import { createToolRouteFollowStore } from './tool-route-follow-state'
import { createTrustedTemporaryDirectory } from './trusted-temp'
import { createCliTerminalAccess } from './windows-cli-shell-access'
import { launchCliPowerShell } from './windows-elevation'
import { resolveWindowsMachinePaths } from './windows-machine-paths'
import { inspectWindowsExecutableMachine } from './windows-processor'

/** 刚跑完的一轮扫描在这么久以内可以直接复用（见 createScanCoalescer）。 */
export const scanReuseMs = 15_000

function firstOutputLine(stdout: string, stderr: string): string | null {
  return `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '') ?? null
}

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

export function createServiceContext(store: AppSettingsStore, serviceOptions: SystemServiceOptions) {
  const windowsExecutionMode = serviceOptions.windowsExecutionMode ?? 'trusted-only'
  const platform = serviceOptions.platform ?? process.platform
  const providerRoots = serviceOptions.providerRoots ?? defaultProviderConfigRoots()
  const runtimeLog = serviceOptions.runtimeLog
  const configOwnership = new ToolConfigOwnershipStore(path.join(serviceOptions.managerDataDirectory ?? store.dataDirectory, 'tool-config-ownership'))
  const externalOwnership = new ExternalClientOwnershipStore(path.join(serviceOptions.managerDataDirectory ?? store.dataDirectory, 'external-client-ownership'))
  const projectInstructionsState = new ProjectInstructionsStateStore(path.join(serviceOptions.managerDataDirectory ?? store.dataDirectory, 'project-instructions'))
  const cliUpdateHistory = new CliUpdateHistoryStore(path.join(serviceOptions.managerDataDirectory ?? store.dataDirectory, 'cli-update-history'))
  const toolRouteFollow = createToolRouteFollowStore(path.join(serviceOptions.managerDataDirectory ?? store.dataDirectory, 'tool-route-follow'))
  let configWriteQueue: Promise<unknown> = Promise.resolve()
  function serializeConfigWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = configWriteQueue.then(operation, operation)
    configWriteQueue = next.catch(() => undefined)
    return next
  }
  const codexEnv = serviceOptions.codexEnv
    ?? { ...process.env, CODEX_HOME: providerRoots.codexHome }
  const relayRouting = serviceOptions.relayEndpointRouting ?? createRelayEndpointRoutingSnapshot(store.read().relayEndpointIds)
  function activeRelaySite(): RelaySite {
    return relayRouting.resolve(serviceOptions.getRelaySiteId?.() ?? store.read().relaySiteId)
  }
  function providerRelaySite(provider: ProviderId, current: NativeConfigInspection, removal = false): RelaySite {
    const selected = activeRelaySite()
    // 星芒账号接了工具线路以后一直是定下来的，「还没定、认得出的旧地址原样留着」只剩历史账号会走（xm 三线路 5.1.0）。
    if (!removal && relayRouting.selection(selected.id) !== undefined) return selected
    return relaySiteForProviderBaseUrl(selected.id, provider, current.actualBaseUrl) ?? selected
  }
  // The account's site remains live. An explicit line is frozen until restart; under "auto" the
  // line may move mid-run, so each write and probe reads it once and uses that line throughout.
  const inspectNativeProviderConfig = (provider: ProviderId) =>
    (serviceOptions.inspectProviderConfig ?? inspectProviderConfig)(
      provider,
      providerRoots,
      activeRelaySite().providerBaseUrls,
    )
  const resolveVerifiedCliCommand = serviceOptions.resolveCliCommand ?? resolveCliCommand
  const launchLinuxTerminalForService = serviceOptions.launchLinuxTerminal ?? launchLinuxTerminal
  const launchCliPowerShellForService = serviceOptions.launchCliPowerShell ?? launchCliPowerShell
  const launchMacosTerminalForService = serviceOptions.launchMacosTerminal ?? launchMacosTerminal
  const resolveCliInstallationForService = serviceOptions.resolveCliInstallation ?? resolveCliInstallation
  const findExecutableForService = serviceOptions.findExecutable ?? findExecutable
  const executeCommand = serviceOptions.runCommand ?? runCommand
  const detectMacosCodexApp = serviceOptions.macosCodexAppDetector ?? inspectMacosCodexApp
  const installPythonRuntimeForService = serviceOptions.installPythonRuntime ?? installPythonRuntime312
  const inspectInstalledPythonRuntimeForService = serviceOptions.inspectInstalledPythonRuntime ?? inspectInstalledPythonRuntime
  const inspectWindowsRestartRequiredForService = serviceOptions.inspectWindowsRestartRequired ?? inspectWindowsRestartRequired
  // macOS 上不跑 Windows 那套 winget / MSI：把官方压缩包解进本软件自己的文件夹（第十六批 2）。
  // Linux 同理，只是版本和校验值钉在软件里（linux-node-runtime.ts，Linux 版拆分 ②）。
  const installNodeRuntimeForService = serviceOptions.installNodeRuntime
    ?? (platform === 'darwin'
      ? installDarwinNodeRuntime
      : platform === 'win32' ? installNodeRuntimeLts : installLinuxNodeRuntime)
  const installGitRuntimeForService = serviceOptions.installGitRuntime ?? installGitForWindows
  const installMacGitRuntimeWith = serviceOptions.installMacGitRuntime ?? installMacGitRuntime
  // 安装下载曾经完全无视机器上的代理：产物下载走 Node 自带网络栈、npm 子进程
  // 没有任何代理变量，于是开着加速也一样直连。这两个注入点把下载接回系统代理。
  const downloadFetch = serviceOptions.downloadFetch ?? fetch
  /**
   * 管理员身份时照旧用 Node 自带的根证书：当前用户的证书库普通权限就写得进，不能
   * 让它决定管理员的安装信任哪张证书（与 trustedCommandEnvironment 剥掉
   * NODE_USE_SYSTEM_CA 同一个理由）。取 fetch 放在调用时，测试替换全局 fetch 才生效。
   */
  const registryMetadataFetch: typeof fetch = (input, init) => (
    serviceOptions.registryFetch && !(platform === 'win32' && windowsExecutionMode === 'trusted-only')
      ? serviceOptions.registryFetch(input, init)
      : fetch(input, init)
  )
  const resolveSubprocessProxyEnvironment = serviceOptions.resolveSubprocessProxyEnvironment
    ?? (async (): Promise<NodeJS.ProcessEnv> => ({}))
  const acquireDownloadAcceleration = serviceOptions.acquireDownloadAcceleration
  const probeLoopbackProxyForService = serviceOptions.probeLoopbackProxy ?? probeLoopbackProxy
  /**
   * 电脑里留着指向本机某个没开的代理的设置时，这一次不带它（第十六批 5）。只减不增：
   * 开着的、指向别的机器的照旧带上；探测出错时原样返回，不挡住打开和安装。
   */
  async function withoutDeadLoopbackProxies(env: NodeJS.ProcessEnv, provider: ProviderId): Promise<NodeJS.ProcessEnv> {
    const bypass = await bypassClosedLoopbackProxies(env, probeLoopbackProxyForService)
    if (bypass.dropped.length) {
      runtimeLog?.log('info', 'network', 'proxy-env.bypassed', '电脑里设的本机代理没开，这一次不带它', {
        provider,
        ...describeDroppedProxies(bypass.dropped),
      })
    }
    return bypass.env
  }
  // 有多少次下载正跑在加速线路上。只用来决定安装源顺序，所以是个计数而不是
  // 布尔：两个工具同时装时，先装完的那个不能把后一个的官方优先撤掉。
  let acceleratedDownloads = 0
  const resolveWindowsMachinePathsForService = serviceOptions.resolveWindowsMachinePaths ?? resolveWindowsMachinePaths
  const installing = new Set<ProviderId>()
  const installationQueue = new InstallationQueue()
  const installCancellations = new InstallCancellationRegistry()
  // 登记着取消句柄的那次 CLI 安装点名的版本（undefined = 没点名）。只在句柄还登记着时读，
  // 每次登记句柄都会先覆盖它，所以句柄放掉以后留着旧值也不会被读到。
  const installRequestedVersions = new Map<ProviderId, string | undefined>()
  // 单独装 Node.js 和装工具时发现没有 npm 顺带装的那一次共用这一个标记：同一时间只装一份。
  const nodeRuntimeInstall = { running: false }
  // 桌面端（Codex、Claude）先从星芒自己的存储桶下（yoyo 2026-10-10）；桶那一路为什么没走通只进日志。
  const desktopBucketDownloads: DesktopBucketOptions = {
    onFallback: (detail) => runtimeLog?.log('warn', 'install', 'desktop-bucket.fallback', '桌面端存储桶这一路没走通，改走原来的下载办法', { detail }),
  }
  const grokBucketDownloads: DesktopBucketOptions = {
    onFallback: (detail) => runtimeLog?.log('warn', 'install', 'grok-bucket.fallback', 'Grok 存储桶这一路没走通，改去 xAI 下载', { detail }),
  }
  // Mac 上要不要改用代下的那份 Node.js（preferredNodeDirectories）。判断要起一两次 `node --version`，
  // 同一阵子里的检测、装工具、开工具共用一次结果；强制重新检测、装完 Node.js 时重新判断。
  let preferredNodeProbe: { at: number; directory: Promise<string | null> } | null = null
  const inspectExecutableMachine = serviceOptions.inspectExecutableMachine ?? inspectWindowsExecutableMachine
  const inspectOfficialUsage = serviceOptions.fetchOfficialChatGptUsage
    ?? (process.env.VITEST ? async () => null : fetchOfficialChatGptUsage)

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

  const probeDiskSpace = serviceOptions.readDiskSpace ?? readDiskSpace

  /**
   * 一次安装会同时用到临时事务目录和托管目录，所以两块盘都问一次，按最紧的那
   * 一块判断。npm 的全局目录要跑一条命令才知道，而事务目录和缓存本来就落在临
   * 时目录，够覆盖「C 盘只剩几百兆」这个真实场景。
   */
  function installDiskSpaceTargets(): string[] {
    const targets = [os.tmpdir()]
    try {
      targets.push(managedCliRoot(commandEnvironment(), platform))
    } catch {
      // Windows 上拿不到可信的 ProgramData 时托管目录本来就用不了，这一项跳过。
    }
    return targets
  }

  /**
   * 装之前先看一眼盘。**读不到空间一律放行**（disk-space.ts 的 fail-open）：为了
   * 一个查不到的数字拦下安装，是把小毛病变成大故障。拦住时抛的那句话里有
   * 「磁盘空间不足」（Windows 上是「C 盘空间不足」），渲染层按已有的「磁盘空间不够」
   * 一类呈现，不新立一类。
   */
  async function assertInstallDiskSpace(subject: string): Promise<void> {
    const readings = await Promise.all(
      installDiskSpaceTargets().map((target) => probeDiskSpace(target)),
    )
    const tightest = tightestDiskSpace(readings)
    const shortfall = describeInsufficientDiskSpace(tightest)
    if (!shortfall) return
    runtimeLog?.log('warn', 'install', 'disk-space.insufficient', `${subject}：${shortfall}`, {
      subject,
      availableBytes: tightest?.availableBytes ?? null,
      measuredPath: tightest ? redactHomeDirectory(tightest.measuredPath, providerRoots.userHome) : null,
    })
    throw new Error(`${subject}：${shortfall}`)
  }

  /**
   * 把一次下载包在临时加速里：开始前把线路拉起来，结束（无论成败）再还回去。
   * 拿不到线路就原样执行——加速是加分项，绝不能变成安装的前置条件。
   */
  async function withDownloadAcceleration<T>(
    note: ((message: string) => void) | null,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!acquireDownloadAcceleration) return operation()
    note?.('正在准备下载加速')
    let lease: DownloadAccelerationLease
    try { lease = await acquireDownloadAcceleration() }
    catch { return operation() }
    // 拿到手就一定要还回去，哪怕这一次并没有线路：租约的归属在协调者那边，
    // 不还回去等于让下一次下载去猜还有没有人在用。
    if (lease.accelerated) {
      note?.('已为本次下载启用加速线路（未改动系统代理）')
      acceleratedDownloads += 1
    } else {
      note?.('未启用下载加速，按现有下载源顺序继续')
    }
    try { return await operation() }
    finally {
      if (lease.accelerated) acceleratedDownloads -= 1
      await lease.release().catch(() => undefined)
    }
  }

  /**
   * Tool discovery is deliberately not restricted to machine PATH entries.
   * npm global installs and the official Grok/Claude installers live under a
   * user's profile on Windows. Discovery is read-only; an explicitly elevated
   * process still blocks version execution from user-writable paths.
   */
  async function findInstalledExecutable(command: string): Promise<string | null> {
    const additionalPaths = await nodeCommandDirectories(command)
    return findExecutableForService(command, {
      env: commandEnvironment(),
      windowsPackageManagers: command.toLowerCase() === 'npm' ? ['npm'] : [],
      ...(additionalPaths.length ? { additionalPaths } : {}),
    })
  }

  /**
   * Mac 上客户自己那份 Node.js 太旧、代下的那份够新时，本软件自己找 node / npm、跑 npm
   * 都把代下的那份排到最前（第三十四批 A，macos-node-runtime.ts）；别的平台、别的情况是空的，
   * 顺序照旧。交给工具的终端 PATH 不经过这里，客户在工具里用的还是他自己那份。
   */
  function preferredNodeDirectories(): Promise<string[]> {
    if (platform !== 'darwin') return Promise.resolve([])
    const now = Date.now()
    if (!preferredNodeProbe || now - preferredNodeProbe.at >= scanReuseMs) {
      preferredNodeProbe = {
        at: now,
        directory: resolveDarwinPreferredNodeDirectory({
          findNode: () => findExecutableForService('node', { env: commandEnvironment() }),
          readVersion: (executable) => executeVersion(executable, ['--version']),
        }).catch(() => null),
      }
    }
    return preferredNodeProbe.directory.then((directory) => directory ? [directory] : [])
  }

  function nodeCommandDirectories(command: string): Promise<string[]> {
    return ['node', 'npm', 'npx'].includes(command.toLowerCase()) ? preferredNodeDirectories() : Promise.resolve([])
  }

  /** `npm root --global` 也得用找 npm 时排在最前的那份 Node.js 跑，不然代下的 npm 会落到客户的旧 node 上。 */
  async function resolveServiceNpmGlobalRoot(npmExecutable: string | null): Promise<string | null> {
    return resolveNpmGlobalRoot(npmExecutable, commandEnvironment(), undefined, undefined, await preferredNodeDirectories())
  }

  async function executeVersion(
    executable: string,
    args: string[],
    windowsPackageManager?: WindowsPackageManager,
    baseEnv: NodeJS.ProcessEnv = process.env,
    additionalPaths: readonly string[] = [],
  ): Promise<string | null> {
    try {
      const trustedOnly = platform === 'win32' && windowsExecutionMode === 'trusted-only'
      if (trustedOnly) await primeTrustedHighIntegrityExecutable(executable, platform)
      if (trustedOnly && !isTrustedHighIntegrityExecutable(executable)) return null
      const result = await executeCommand({ executable, argv: args, windowsPackageManager }, {
        env: trustedOnly ? trustedCommandEnvironment(baseEnv) : commandEnvironment(baseEnv, additionalPaths),
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

  function isManagedNpmInstallation(installation: Pick<CliInstallation, 'npmPrefix'>): boolean {
    if (!installation.npmPrefix) return false
    const expected = managedNpmPrefix(commandEnvironment(), platform)
    return sameLocalPathIdentity(expected, installation.npmPrefix)
  }

  // 让用户在自己开的 PowerShell / cmd 里直接敲工具名就能用：删掉 npm 写的 .ps1
  // 启动文件（默认执行策略下它会报「禁止运行脚本」），装完时再确认工具目录在
  // 当前用户的 PATH 里。两步都只动当前用户自己的东西，不改执行策略、不提权；
  // 失败只记日志，不影响安装结果。
  const cliTerminalAccess = createCliTerminalAccess({
    platform,
    executionMode: windowsExecutionMode,
    isManaged: isManagedNpmInstallation,
    ensureUserPath: serviceOptions.ensureWindowsUserPath,
    removeUserPath: serviceOptions.removeWindowsUserPath,
    ensureShellProfile: serviceOptions.ensureMacosShellProfile,
    syncTerminalCommands: serviceOptions.syncLinuxTerminalCommands,
    log: (level, event, message, detail) => runtimeLog?.log(level, 'install', event, message, detail),
    describeError: (error) => redactHomeDirectory(
      redactCommandText(error instanceof Error ? error.message : String(error)),
      providerRoots.userHome,
    ),
  })

  /**
   * 把「文件被占用」这句话补到失败原文上,前提是真的撞上了占用:EBUSY / ETXTBSY
   * 自己就够,EPERM / EACCES 必须数到这个工具的进程才算(见 cli-process-probe.ts
   * 的 describeOccupiedUpdateFailure)。数不到就返回 null,原来的失败原样出去。
   */
  async function describeOccupiedCliFailure(
    provider: ProviderId,
    errorLike: unknown,
    detail: string,
    probeRoot: string | null,
    action: OccupiedUpdateFailureInput['action'],
  ): Promise<string | null> {
    if (!fileLockErrorCode(errorLike)) return null
    const probe = probeRoot
      ? await probeRunningCliProcesses(probeRoot)
      : { status: 'unsupported' as const, processes: [] }
    const message = describeOccupiedUpdateFailure({
      toolName: cliCatalog[provider].name,
      action,
      error: errorLike,
      probe,
      detail,
    })
    if (!message) return null
    runtimeLog?.log('warn', 'install', 'cli.file-locked', `${cliCatalog[provider].name} ${action}时文件被占用`, {
      provider,
      probeStatus: probe.status,
      processes: probe.processes.length,
    })
    return message
  }

  /** 这会儿有几次下载正跑在加速线路上；挑安装源顺序的两处（inspectNetworkRegion、装命令行工具）读它。 */
  function acceleratedDownloadCount(): number {
    return acceleratedDownloads
  }

  /** 强制重新检测、装完 Node.js 以后，重新判断要不要改用代下的那份。 */
  function forgetPreferredNodeDirectories(): void {
    preferredNodeProbe = null
  }

  return {
    store,
    serviceOptions,
    windowsExecutionMode,
    platform,
    providerRoots,
    runtimeLog,
    configOwnership,
    externalOwnership,
    projectInstructionsState,
    cliUpdateHistory,
    toolRouteFollow,
    serializeConfigWrite,
    codexEnv,
    relayRouting,
    activeRelaySite,
    providerRelaySite,
    inspectNativeProviderConfig,
    resolveVerifiedCliCommand,
    launchLinuxTerminalForService,
    launchCliPowerShellForService,
    launchMacosTerminalForService,
    resolveCliInstallationForService,
    findExecutableForService,
    executeCommand,
    detectMacosCodexApp,
    installPythonRuntimeForService,
    inspectInstalledPythonRuntimeForService,
    inspectWindowsRestartRequiredForService,
    installNodeRuntimeForService,
    installGitRuntimeForService,
    installMacGitRuntimeWith,
    downloadFetch,
    registryMetadataFetch,
    resolveSubprocessProxyEnvironment,
    withoutDeadLoopbackProxies,
    acceleratedDownloadCount,
    resolveWindowsMachinePathsForService,
    installing,
    installationQueue,
    installCancellations,
    installRequestedVersions,
    nodeRuntimeInstall,
    desktopBucketDownloads,
    grokBucketDownloads,
    inspectExecutableMachine,
    inspectOfficialUsage,
    createInstallTemporaryDirectory,
    assertInstallDiskSpace,
    withDownloadAcceleration,
    findInstalledExecutable,
    preferredNodeDirectories,
    forgetPreferredNodeDirectories,
    nodeCommandDirectories,
    resolveServiceNpmGlobalRoot,
    executeVersion,
    isManagedNpmInstallation,
    cliTerminalAccess,
    describeOccupiedCliFailure,
  }
}

export type ServiceContext = ReturnType<typeof createServiceContext>
