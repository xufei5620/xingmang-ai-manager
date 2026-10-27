// 从星芒打开工具的那一段（#1070 第 3 步，从 system-service.ts 的 createSystemService 原样搬来）：打开命令行工具
// （Windows 的 PowerShell 窗口、Mac 的「终端」、Linux 各家终端，起之前核命令、补环境、排进保存配置那一队补写配置），
// 打开 Codex 桌面端和它的中文界面设置，以及信任 Codex 工作目录。
//
// 各簇共用的那份在 system-service-context.ts；起子进程的环境、两样 Codex 桌面端操作、读工具状态、记住的工作目录和
// 打开 Grok 前修钩子由 createSystemService 传进来（ProviderLaunchServiceDependencies）。这里只 import system-service.ts 的类型。
import fs from 'node:fs'
import path from 'node:path'
import type { QueuedAccountWork } from './account-work-gate'
import { cliCatalog, type ProviderId } from './catalog'
import {
  type CodexDesktopLocale,
  codexDesktopLocaleNeedsChange,
  type CodexDesktopLocaleResult,
  type CodexDesktopLocaleStatus,
  inspectCodexDesktopLocale as inspectCodexDesktopLocaleStatus,
  shouldAutoConfigureCodexDesktopChineseLocale,
  writeCodexDesktopLocale,
} from './codex-desktop-locale'
import type { CodexDesktopService } from './codex-desktop-service'
import { type CodexDesktopGlobalStateStatus, inspectCodexDesktopGlobalState } from './codex-desktop-state'
import { commandEnvironment, trustedCommandEnvironment } from './command-runner'
import {
  canLaunchManagedProvider,
  claudeForeignModelEnvKeys,
  type CodexWorkspacePermissionStatus,
  type CodexWorkspacePermissionWriteResult,
  ensureCodexPermissionDefaults,
  ensureGeminiProjectContextFiles,
  geminiCliCompatibleModel,
  inspectCodexWorkspacePermissions,
  managedProviderLaunchBlockedMessage,
  type NativeConfigInspection,
  providerAccountMode,
  type ProviderAccountMode,
  trustCodexWorkspace,
  trustManagedWorkspace,
} from './config-files'
import { toolLaunchFailureMessage } from './failure-wording'
import { type LinuxTerminalAttempt, LinuxTerminalLaunchError } from './linux-terminal'
import type { MacosTerminalLaunchPlan } from './macos-platform'
import { ensureProjectInstructions, readProjectInstructionsTemplate } from './project-instructions'
import { redactHomeDirectory } from './startup-log'
import { withSystemCertificateTrust } from './system-certificate-trust'
import type {
  CliLaunchResult,
  CodexDesktopLaunchMode,
  CodexDesktopLaunchResult,
  DesktopAppStatus,
  RendererMessageTarget,
  ToolStatus,
} from './system-service'
import type { ServiceContext } from './system-service-context'
import { type CliInstallation, cliLaunchArgv, type CliLaunchMode } from './tool-installation'
import { assertTrustedElevatedCliCommand, WindowsCliLaunchError } from './windows-elevation'
import { withAppendedWindowsPath } from './windows-live-path'
import {
  claudePlatformSwitches,
  describeOverride,
  inspectWorkspaceConfigOverrides,
  launchOverrideNotice,
} from './workspace-config-overrides'
import { classifyWorkspace, sensitiveWorkspaceLabel } from './workspace-guard'

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

/**
 * 普通权限打开工具时的基底：在 commandEnvironment 之上让 Claude Code、Gemini CLI
 * 也信任这台电脑装的证书（公司上网审计、安全软件的网页扫描）。管理员身份那条路
 * 用 trustedCommandEnvironment，不经过这里。
 */
export function sameUserTerminalEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return withSystemCertificateTrust(commandEnvironment(env))
}

/**
 * 打开 CLI 的排队 key。只有同一工具、同一文件夹、同一种打开方式才算「同一次打开」
 * 合并成一个（双击幂等，I11）；换了文件夹或从记录页「接着聊」是另一件事，
 * 要排在后面各自执行，不能被前一个吞掉、再拿到前一个的结果（#482）。
 * 前缀保持 `cli:launch:`，退出拦截（quit-blocking-tasks.ts）按前缀认它不是安装。
 */
export function buildCliLaunchQueueKey(provider: ProviderId, workspace: string, mode: CliLaunchMode, resumeSessionId?: string | null): string {
  // 同一目录里按 id 接两条不同的 Codex 对话也是两件事，不能合并。
  const resumed = mode === 'resumeLast' && resumeSessionId ? `${mode}=${resumeSessionId}` : mode
  return `cli:launch:${provider}:${resumed}:${path.resolve(workspace)}`
}

/**
 * 手机遥控起 `codex app-server` 的排队 key（#1407 P3-3）：和终端里打开 Codex 一样排进安装队列，
 * Codex 正在装、更新、卸载时等它做完再起，不会从换了一半的目录起。前缀同上，退出拦截不当它是安装。
 */
export const codexRemoteLaunchQueueKey = 'cli:launch:codex:remote'

/** Keeps service-level macOS launching bound to the command already verified by CLI resolution. */
export function buildDarwinCliLaunchPlan(
  command: { executable: string; argv: readonly string[] },
  workspace: string,
  env: NodeJS.ProcessEnv,
  clearedEnvironmentKeys: readonly string[] = [],
): MacosTerminalLaunchPlan {
  if (!path.isAbsolute(command.executable)) {
    throw new Error('macOS CLI executable must be an absolute resolved path')
  }
  if (!path.isAbsolute(workspace)) throw new Error('macOS workspace must be an absolute path')
  return {
    executable: command.executable,
    argv: [...command.argv],
    workspace,
    env,
    ...(clearedEnvironmentKeys.length ? { clearedEnvironmentKeys: [...clearedEnvironmentKeys] } : {}),
  }
}

// Gemini CLI loads the managed ~/.gemini/.env only when a variable is not
// already present. A shell-level stale gateway/key/model would otherwise
// override the account configuration just written by the manager and send
// requests to another relay (or select a model that is not in the group).
const managedGeminiVariables = [
  'GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GEMINI_MODEL',
  'GOOGLE_GENAI_API_VERSION', 'GOOGLE_GEMINI_API_KEY',
] as const

export function providerCommandEnvironment(
  provider: ProviderId,
  processEnv: NodeJS.ProcessEnv,
  codexEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment = commandEnvironment(provider === 'codex' ? codexEnv : processEnv)
  if (provider === 'gemini') {
    const managed = new Set<string>(managedGeminiVariables)
    for (const key of Object.keys(environment)) {
      if (managed.has(key.toUpperCase())) delete environment[key]
    }
  }
  return environment
}

/**
 * 三个平台从星芒打开工具时都不交给它的变量（已知45 跟进，#1081）。只管 Claude Code 用星芒账号的时候：
 * - 检查页实测会绕开当前账号的那两个（diagnostics-override-checks.ts 的 breaksAccount）：ANTHROPIC_API_KEY 会换掉 Key，
 *   CLAUDE_CONFIG_DIR 让它整个不读星芒写的 ~/.claude。这一次不交给工具不等于改客户的电脑，他系统里的设置
 *   一个字不动，所以 Windows、Linux 和 Mac 一样不带，不再只靠检查页提示。
 * - 选型号的那几个：客户自己设的 ANTHROPIC_MODEL 这类会让 Claude Code 去要当前账号没有的型号；接账号时
 *   settings.json 里的同名项已经挪开（config-files.ts 的 claudeForeignModelEnvKeys），环境里的这里一并不带。
 * - 改走云厂商的那几个开关（workspace-config-overrides.ts 的 claudePlatformSwitches，#1157 第 11 条）：
 *   CLAUDE_CODE_USE_BEDROCK 这类一打开，Claude Code 连地址带登录都换成云厂商的，星芒写的 settings.json
 *   里没有同名项，盖不住它。客户给自己终端里的 Claude Code 用 Bedrock、Vertex 照旧，这里只是这一次不带。
 *   settings.json 里客户自己写的同名项不挪（那是他设的值，挪不挪要 yoyo 定）。
 * 用自己的 Claude 账号时照旧都带：这些可能就是客户自己的 Key、登录和型号（切回官方账号时星芒也把他原来的
 * ANTHROPIC_API_KEY 放回 settings.json）。ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN 盖不过 settings.json 的
 * env 段，不在里面。
 */
const claudeRelayLaunchExcludedVariables: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CONFIG_DIR',
  ...claudeForeignModelEnvKeys,
  ...claudePlatformSwitches,
]

export function launchExcludedEnvironmentVariables(provider: ProviderId, accountMode: ProviderAccountMode): readonly string[] {
  return provider === 'claude' && accountMode === 'relay' ? claudeRelayLaunchExcludedVariables : []
}

/** 名字不分大小写：Windows 上 `anthropic_model` 和大写是同一个变量（同 providerCommandEnvironment）。 */
export function withoutEnvironmentVariables(env: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const excluded = new Set(names.map((name) => name.toUpperCase()))
  return Object.fromEntries(Object.entries(env).filter(([key]) => !excluded.has(key.toUpperCase())))
}

/**
 * Mac 上「终端」先起客户自己的登录 shell 读 ~/.zshrc 这些启动文件，再跑星芒的启动脚本，那里 export
 * 的变量一路带给工具；星芒是从访达打开的，自己的环境里看不到它们，上面那步管不到（已知45，同第三十四批 B）。
 * 启动脚本先把这里列的 unset 掉，再写星芒自己的值。三个平台都不带的（launchExcludedEnvironmentVariables）
 * 都在里面，另加 Mac 才要的：
 * - Claude Code：没有另加的，Key、配置目录、选型号和改走云厂商的那几个三个平台一样，只在用星芒账号时去掉。
 * - Gemini CLI：同 Windows、Linux 上的 providerCommandEnvironment，星芒管的这五个不论哪种账号都不用客户 shell
 *   里的，要给的值启动时另给。
 * - Codex：CODEX_HOME 星芒每次都自己写，OPENAI_* 盖不过 config.toml。Grok 没实测过，不猜。
 */
export function macosShellOverrideVariables(provider: ProviderId, accountMode: ProviderAccountMode): readonly string[] {
  switch (provider) {
    case 'claude':
      return launchExcludedEnvironmentVariables(provider, accountMode)
    case 'gemini':
      return managedGeminiVariables
    case 'codex':
    case 'grok':
      return []
  }
}

/** 打开工具前替客户补写配置（目录信任、Codex 权限缺省、桌面端中文），排在保存配置后面最多等这么久。 */
const toolLaunchConfigWriteWaitMs = 3_000

/**
 * 把 write 排进 enqueue 那一队，最多等 ms 毫秒：到点还没轮到就按 gaveUp 那句拒绝，之后轮到了也不再做。
 * 轮到了就等它做完。给打开工具前那几样补写用（#1061 第 1 条）：打开的人在等，排不上就这次不写；
 * 也不能留到工具起来以后再写，那时工具自己也在写同一个文件。
 */
export function writeQueuedWithin<T>(
  enqueue: (operation: () => Promise<T>) => Promise<T>,
  write: () => T | Promise<T>,
  ms: number,
  gaveUp: string,
): Promise<T> {
  let started = false
  let abandoned = false
  const queued = enqueue(async () => {
    if (abandoned) throw new Error(gaveUp)
    started = true
    return write()
  })
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (started) return
      abandoned = true
      reject(new Error(gaveUp))
    }, ms)
    queued.then((value) => {
      clearTimeout(timer)
      resolve(value)
    }, (error: unknown) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/** 打开工具要用、但归别处管的几样，由 createSystemService 传进来。 */
export interface ProviderLaunchServiceDependencies {
  /** 起 CLI 子进程用的环境（providerCommandEnvironment）。 */
  providerEnvironment: (provider: ProviderId) => NodeJS.ProcessEnv
  /** Codex 桌面端的探测和真正的启动归 codex-desktop-service.ts 管。 */
  inspectCodexDesktop: () => Promise<DesktopAppStatus>
  launchCodexDesktopOperation: CodexDesktopService['launchCodexDesktop']
  inspectCliTool: (
    provider: ProviderId,
    npmExecutable?: string | null,
    npmGlobalRoot?: string | null,
    executablePath?: string | null,
  ) => Promise<{ status: ToolStatus; installation: CliInstallation | null }>
  /** 首页记住的工作目录还在不在、能不能用（配置摘要那边也用）。 */
  rememberedWorkspaceFor: (workspace: string) => string | null
  /** 打开 Grok 前按现在的命令行把钩子修好。 */
  repairGrokHooksBeforeLaunch: () => Promise<void>
}

export function createProviderLaunchService(context: ServiceContext, dependencies: ProviderLaunchServiceDependencies) {
  const {
    store, serviceOptions, windowsExecutionMode, platform, providerRoots, runtimeLog, projectInstructionsState,
    serializeConfigWrite, inspectNativeProviderConfig, resolveVerifiedCliCommand, launchLinuxTerminalForService,
    launchCliPowerShellForService, launchMacosTerminalForService, withoutDeadLoopbackProxies, installationQueue,
    findInstalledExecutable, preferredNodeDirectories, resolveServiceNpmGlobalRoot, currentWindowsLivePath,
    toolLaunchedAt, toolRouteRestartPending,
  } = context
  const {
    providerEnvironment,
    inspectCodexDesktop,
    launchCodexDesktopOperation,
    inspectCliTool,
    rememberedWorkspaceFor,
    repairGrokHooksBeforeLaunch,
  } = dependencies

  // 打开工具前替客户补的那几样也排进保存配置这一队（#1061 第 1 条）。保存要先联网查模型，查完核对
  // 配置没被动过才写（sameNativeConfigSnapshot 连修改时间一起比）；以前这一两秒里点「打开」，补写
  // 一改 config.toml，保存就报「工具配置在模型检测期间发生变化」。这几样都是写不进去也不挡打开的，
  // 排不上就这次不写：下次打开再补，目录信任 CLI 自己还会问。
  function writeBeforeLaunch<T>(write: () => T | Promise<T>): Promise<T> {
    return writeQueuedWithin(serializeConfigWrite, write, toolLaunchConfigWriteWaitMs, '保存配置还没做完，这次打开先不写')
  }

  /**
   * A persisted zh-CN override must also affect a later ordinary “打开”
   * action, not only the click that originally changed the setting. Resolve
   * that flag at the last possible moment so a fresh process restart keeps the
   * local CDP enhancement without changing the system-language path.
   */
  async function launchCodexDesktop(
    mode: CodexDesktopLaunchMode,
    target: RendererMessageTarget,
    launchOptions: { injectChinese?: boolean; accountWork?: QueuedAccountWork } = {},
  ): Promise<CodexDesktopLaunchResult> {
    // Configs created before the permission picker was introduced often omit
    // both legacy fields. Add only missing defaults so a mirror-installed
    // Desktop gets the same interactive baseline as a local installation.
    try {
      // Only normalize configs managed by Xingmang. An official/custom Codex
      // profile is user-owned and must remain byte-for-byte untouched here.
      // Decide inside the queue: a save that was in flight may just have
      // switched the profile.
      await writeBeforeLaunch(() => {
        if (inspectNativeProviderConfig('codex').matchesRelay) ensureCodexPermissionDefaults(providerRoots)
      })
    } catch {
      // The launch path remains available; malformed configs are reported by
      // Codex itself and by the dedicated permission inspection below.
    }
    let effectiveLaunchMode = mode
    let repairPermissionModeVisibility = false
    if (platform === 'win32') {
      const globalState: CodexDesktopGlobalStateStatus = inspectCodexDesktopGlobalState(providerRoots.codexHome)
      if (globalState.needsRepair) {
        repairPermissionModeVisibility = true
        // The Desktop keeps the legacy value in memory and writes it back on
        // exit. Force a full restart before migration when an open action
        // finds a running instance; otherwise the repair would be lost.
        if (mode === 'open') {
          const desktop = await inspectCodexDesktop()
          if (desktop.running) effectiveLaunchMode = 'restart'
        }
      }
    }
    let injectChinese = launchOptions.injectChinese
    if (injectChinese === undefined && platform === 'win32') {
      // The runtime patch is the only reason this app ever starts Codex with a
      // remote debugging port, and that port then stays open -- unauthenticated
      // on loopback -- for the whole Codex session. Consent therefore comes
      // from the stored setting written by the explicit 「启用中文界面」 action,
      // never from config.toml: `localeOverride = "zh-CN"` is a value this
      // program writes by itself, so reading it as consent made the debugging
      // port the default path for every Chinese customer (E-S3).
      injectChinese = store.read().codexDesktopChineseRuntimePatch === 'enabled'
      try {
        const locale = await inspectCodexDesktopLocale()
        if (shouldAutoConfigureCodexDesktopChineseLocale(locale)) {
          // Installations created before the locale flow have no override at
          // all. Persisting the Chinese default still costs nothing: the native
          // menus and the packaged locale honor it without any debugging port,
          // and only the web view's Statsig gate needs the runtime patch.
          // `writeCodexDesktopLocale` re-validates the safe path and TOML, so a
          // malformed or redirected config can never be silently overwritten.
          await writeBeforeLaunch(() => writeCodexDesktopLocale({ codexHome: providerRoots.codexHome }, 'zh-CN'))
        }
      } catch {
        // The normal launch remains available if a locale probe is temporarily
        // unavailable; config.toml will still be honored by Codex itself.
      }
    }
    return launchCodexDesktopOperation(effectiveLaunchMode, target, {
      ...launchOptions,
      injectChinese,
      repairPermissionModeVisibility,
    })
  }

  async function launchProviderOperation(
    provider: ProviderId,
    workspace: string,
    mode: CliLaunchMode,
    resumeSessionId: string | null,
  ): Promise<CliLaunchResult> {
    const nativeConfig = inspectNativeProviderConfig(provider)
    if (!canLaunchManagedProvider(nativeConfig)) {
      throw new Error(managedProviderLaunchBlockedMessage(provider))
    }
    if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
      throw new Error('工作目录不存在，请重新选择')
    }
    // 从星芒打开的窗口读的是现在的配置：之前标的「需重开生效」说的不是它了（C19 另按「开着」算 Gemini）。
    toolLaunchedAt.set(provider, Date.now())
    toolRouteRestartPending.delete(provider)
    if (provider === 'grok') await repairGrokHooksBeforeLaunch()

    const definition = cliCatalog[provider]
    // 主目录、盘根、桌面、系统目录、四家工具的配置目录等敏感目录不写信任、也不生成 AGENTS.md：
    // 两者都是「配一次管整棵目录树」的动作，放在这种目录上等于把整台电脑标成
    // 可信、给所有项目加一份看不见的说明（workspace-guard.ts）。打开本身照常，
    // 信任那一问由 CLI 自己去问 —— 在这种目录上那一问是有意义的。
    const workspaceSensitivity = classifyWorkspace(workspace, {
      platform,
      home: providerRoots.userHome,
    })
    if (workspaceSensitivity) {
      runtimeLog?.log('info', 'config', 'workspace.guard.skipped', `${definition.name} 打开的是${sensitiveWorkspaceLabel(workspaceSensitivity)}，不写入信任，也不生成项目说明`, {
        provider,
        kind: workspaceSensitivity,
      })
    }
    // 目录是用户刚在本软件的对话框里亲自选的，再让他去读一遍 CLI 自己的英文
    // 信任问答没有意义，所以打开之前先把这一项写进 CLI 的配置。写不进去
    // （文件损坏、只读、主目录被重定向）绝不能挡住打开：CLI 自己还会问一次。
    if (!workspaceSensitivity) {
      try {
        const trust = await writeBeforeLaunch(() => trustManagedWorkspace(provider, providerRoots, workspace))
        if (trust.changed) {
          runtimeLog?.log('info', 'config', 'workspace.trust.written', `${definition.name} 已信任所选工作目录`, {
            provider,
          })
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        runtimeLog?.log('warn', 'config', 'workspace.trust.failed', `${definition.name} 未能记录工作目录信任，将由工具自己询问`, {
          provider,
          reason: redactHomeDirectory(reason, providerRoots.userHome),
        })
      }
    }
    // 目录里三种项目说明文件（CLAUDE.md / AGENTS.md / GEMINI.md）一个都没有、
    // 且本应用没给这个目录生成过时，放一份中文 AGENTS.md，三个工具打开这个目录
    // 都会读它。绝不覆盖已有文件；客户删掉生成的那份就不再生成（记录在
    // projectInstructionsState 里，不往客户目录写标记）；写不进去（磁盘满、只读、
    // 目录被重定向）绝不能挡住打开。
    if (serviceOptions.projectInstructionsTemplatePath && !workspaceSensitivity) {
      try {
        const template = readProjectInstructionsTemplate(serviceOptions.projectInstructionsTemplatePath)
        const result = await ensureProjectInstructions({
          workspace,
          template,
          state: projectInstructionsState,
        })
        if (result.created) {
          runtimeLog?.log('info', 'config', 'project-instructions.created', `${definition.name} 已为工作目录生成 AGENTS.md`, {
            provider,
          })
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        runtimeLog?.log('warn', 'config', 'project-instructions.failed', `${definition.name} 未能生成项目说明，将不影响打开`, {
          provider,
          reason: redactHomeDirectory(reason, providerRoots.userHome),
        })
      }
    }
    // Gemini CLI 默认只把 GEMINI.md 当项目说明，得在用户级 settings.json 里把
    // AGENTS.md 一起加进 context.fileName，它才会读到上面生成的那份。只补不删。
    if (provider === 'gemini') {
      try {
        const written = ensureGeminiProjectContextFiles(providerRoots)
        if (written.changed) {
          runtimeLog?.log('info', 'config', 'gemini.context-files.written', 'Gemini CLI 已配置为读取 AGENTS.md', {
            provider,
          })
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        runtimeLog?.log('warn', 'config', 'gemini.context-files.failed', 'Gemini CLI 项目说明配置未写入，将不影响打开', {
          provider,
          reason: redactHomeDirectory(reason, providerRoots.userHome),
        })
      }
    }
    const launchResult = inspectLaunchConfigOverrides(provider, workspace, nativeConfig)
    const accountMode = providerAccountMode(nativeConfig)
    const excludedVariables = launchExcludedEnvironmentVariables(provider, accountMode)
    // Grok 按 PATH 挑跑钩子的 shell：补上注册表里新加的那几段，与 expectedGrokWindowsShell 推的是同一份 PATH。
    // 只在不跨提权边界时补；trusted-only 的终端 PATH 由 trustedCommandEnvironment 重建，不收用户可写的目录（I2）。
    const providerEnv = withoutEnvironmentVariables(
      provider === 'grok' && platform === 'win32' && windowsExecutionMode === 'same-user'
        ? withAppendedWindowsPath(providerEnvironment(provider), currentWindowsLivePath())
        : providerEnvironment(provider),
      excludedVariables,
    )
    if (provider === 'gemini') {
      // Gemini CLI 0.59 may skip ~/.gemini/.env for an untrusted workspace,
      // and it never overwrites conflicting parent-process variables. Pass the
      // exact inspected managed values for this launch so the selected account
      // cannot silently fall back to another endpoint or model.
      if (nativeConfig.apiKey) providerEnv.GEMINI_API_KEY = nativeConfig.apiKey
      if (nativeConfig.baseUrl) providerEnv.GOOGLE_GEMINI_BASE_URL = nativeConfig.baseUrl
      if (nativeConfig.model) providerEnv.GEMINI_MODEL = geminiCliCompatibleModel(nativeConfig.model)
    }
    // 打开只用得上 npm 在哪，用不上它的版本号；inspectTool 会多起一次 `npm --version`
    // （Windows 上是 .cmd 再套 node，还要过一遍杀毒），每点一次「打开」都白等那一下。
    // 路径照旧每次现查，不缓存，刚装 / 卸 / 换过 Node 也不会拿到旧答案。
    const npmPath = await findInstalledExecutable('npm')
    const npmGlobalRoot = await resolveServiceNpmGlobalRoot(npmPath)
    const { status: installedStatus, installation } = await inspectCliTool(provider, npmPath, npmGlobalRoot)
    if (!installation) throw new Error(`未检测到 ${definition.name}，请先安装`)

    if (platform === 'win32') {
      let command
      try {
        command = await resolveVerifiedCliCommand(provider, providerEnv, windowsExecutionMode)
        if (windowsExecutionMode === 'trusted-only') {
          assertTrustedElevatedCliCommand(command, definition.name)
        }
        await launchCliPowerShellForService({
          executable: command.executable,
          argv: cliLaunchArgv(provider, command.argv, mode, {
            installedVersion: installedStatus.version,
            resumeSessionId,
          }),
          workspace,
          title: `${definition.name} · 星芒AI`,
          // The broker starts this terminal with Start-Process, so it inherits
          // the elevated token. Without the trusted base, NODE_OPTIONS and the
          // other injection variables would cross the integrity boundary and
          // run attacker code as administrator. assertTrustedElevatedCliCommand
          // only vets the executable path and cannot see the environment.
          env: await withoutDeadLoopbackProxies(interactiveTerminalEnvironment(
            providerEnv,
            windowsExecutionMode === 'trusted-only' ? trustedCommandEnvironment : sameUserTerminalEnvironment,
          ), provider),
        })
      } catch (error) {
        if (error instanceof WindowsCliLaunchError) {
          // 错误框只说原因；PowerShell 和 Node 交回来的原文记在这一条里，路径按主目录脱敏（I13）。
          const { stderr, message, ...exit } = error.launchOutput
          runtimeLog?.log('warn', 'system', 'terminal.failed', `${definition.name} 的命令窗口没能打开`, {
            provider,
            ...exit,
            stderr: stderr && redactHomeDirectory(stderr, providerRoots.userHome),
            message: message && redactHomeDirectory(message, providerRoots.userHome),
          })
        }
        throw new Error(toolLaunchFailureMessage(definition.name, error), { cause: error })
      }
      return launchResult
    }

    if (platform === 'darwin') {
      try {
        // 客户自己那份 Node.js 太旧时，要 node 才跑得起来的工具（比如 Gemini CLI）用代下的那份跑；
        // 下面交给终端的环境照旧，客户在工具里跑 node 还是他自己那份（第三十四批 A）。
        const nodeDirectories = await preferredNodeDirectories()
        const command = await resolveVerifiedCliCommand(provider, providerEnv, windowsExecutionMode, {
          darwinStagingRetention: 'retained',
          ...(nodeDirectories.length ? { nodeDirectories } : {}),
        })
        await launchMacosTerminalForService(buildDarwinCliLaunchPlan(
          {
            ...command,
            argv: cliLaunchArgv(provider, command.argv, mode, { installedVersion: installedStatus.version, resumeSessionId }),
          },
          workspace,
          withSystemCertificateTrust(providerEnv),
          macosShellOverrideVariables(provider, accountMode),
        ))
      } catch (error) {
        // Windows、Linux 另记一条 terminal.failed；Mac 上 open 交回来的退出码和原话挂在 cause 上，
        // 随这次失败一起进运行日志。
        throw new Error(toolLaunchFailureMessage(definition.name, error), { cause: error })
      }
      return launchResult
    }

    // Linux：找一个命令窗口程序，交给它一份一次性启动脚本，脚本真的跑起来才算打开
    // （linux-terminal.ts，Linux 版拆分 ⑤）。
    try {
      // 打开的工具同样带不上一个没开的本机代理，否则连不上中转（Linux 版拆分 ②，与上面 Windows 那条同理）。
      const environment = await withoutDeadLoopbackProxies(
        interactiveTerminalEnvironment(providerEnv, sameUserTerminalEnvironment),
        provider,
      )
      const command = await resolveVerifiedCliCommand(provider, providerEnv, windowsExecutionMode)
      const opened = await launchLinuxTerminalForService({
        executable: command.executable,
        argv: cliLaunchArgv(provider, command.argv, mode, { installedVersion: installedStatus.version, resumeSessionId }),
        workspace,
        title: `${definition.name} · 星芒AI`,
        env: environment,
        // 交给已经开着的命令窗口程序时，工具拿到的是那个程序自己的环境，上面去掉的得在脚本里再去一次。
        ...(excludedVariables.length ? { clearedEnvironmentKeys: excludedVariables } : {}),
      })
      runtimeLog?.log('info', 'system', 'terminal.opened', `${definition.name} 已在「${opened.terminal.label}」里打开`, {
        provider,
        terminal: opened.terminal.id,
        ...describeLinuxTerminalAttempts(opened.attempts),
      })
    } catch (error) {
      if (error instanceof LinuxTerminalLaunchError) {
        runtimeLog?.log('warn', 'system', 'terminal.failed', `${definition.name} 的命令窗口没能打开`, {
          provider,
          ...describeLinuxTerminalAttempts(error.attempts),
          ...(error.reason ? { reason: redactHomeDirectory(error.reason, providerRoots.userHome) } : {}),
        })
      }
      throw new Error(toolLaunchFailureMessage(definition.name, error), { cause: error })
    }
    return launchResult
  }

  /** 日志只写试过哪几个命令窗口、各自怎么失败的；路径按主目录脱敏（I13）。 */
  function describeLinuxTerminalAttempts(attempts: readonly LinuxTerminalAttempt[]): Record<string, unknown> {
    if (!attempts.length) return {}
    return {
      attempts: attempts.map((attempt) => ({
        terminal: attempt.terminal,
        executable: redactHomeDirectory(attempt.executable, providerRoots.userHome),
        outcome: attempt.outcome,
        detail: attempt.detail,
      })),
    }
  }

  /**
   * 项目文件夹里（或公司统一下发）的设置会盖过当前账号时，打开照常，只带回一句
   * 提醒并记一条日志。只读，不动那些文件；查的过程出任何错都不能挡住打开。
   */
  function inspectLaunchConfigOverrides(
    provider: ProviderId,
    workspace: string,
    nativeConfig: NativeConfigInspection,
  ): CliLaunchResult {
    const definition = cliCatalog[provider]
    try {
      const overrides = inspectWorkspaceConfigOverrides(provider, workspace, {
        platform,
        home: providerRoots.userHome,
        codexHome: providerRoots.codexHome,
        current: {
          baseUrl: nativeConfig.baseUrl,
          apiKey: nativeConfig.apiKey,
          authType: nativeConfig.authType,
          codexAuthMode: nativeConfig.codexAuthMode,
        },
      })
      if (!overrides.length) return {}
      runtimeLog?.log('warn', 'config', 'workspace.config-override', `${definition.name} 的项目文件夹或这台电脑上有会盖过当前账号的设置`, {
        provider,
        severity: overrides.some((entry) => entry.severity === 'blocking' && !entry.launchUnaffected) ? 'blocking' : 'possible',
        scopes: [...new Set(overrides.map((entry) => entry.scope))],
        files: overrides.map((entry) => redactHomeDirectory(
          describeOverride(entry, workspace, providerRoots.userHome, platform),
          providerRoots.userHome,
        )),
      })
      const notice = launchOverrideNotice(definition.name, overrides)
      return notice ? { configOverrideNotice: notice } : {}
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      runtimeLog?.log('warn', 'config', 'workspace.config-override.failed', `${definition.name} 未能检查项目文件夹里的设置，将不影响打开`, {
        provider,
        reason: redactHomeDirectory(reason, providerRoots.userHome),
      })
      return {}
    }
  }

  function launchProvider(
    provider: ProviderId,
    workspace: string,
    mode: CliLaunchMode = 'new',
    resumeSessionId: string | null = null,
    accountWork?: QueuedAccountWork,
  ): Promise<CliLaunchResult> {
    async function launch(): Promise<CliLaunchResult> {
      return {
        ...await launchProviderOperation(provider, workspace, mode, resumeSessionId),
        rememberedWorkspace: rememberedWorkspaceFor(store.read().workspace),
      }
    }
    return installationQueue.enqueue(
      buildCliLaunchQueueKey(provider, workspace, mode, resumeSessionId),
      () => accountWork ? accountWork.run(launch) : launch(),
      { signal: accountWork?.signal },
    )
  }

  async function inspectCodexDesktopLocale(): Promise<CodexDesktopLocaleStatus> {
    const desktop = await inspectCodexDesktop()
    return inspectCodexDesktopLocaleStatus({
      codexHome: providerRoots.codexHome,
      installed: desktop.installed,
      version: desktop.version,
      installDirectory: desktop.installDirectory,
      running: desktop.running,
      platform,
    })
  }

  function inspectCodexWorkspacePermissionsForService(): CodexWorkspacePermissionStatus {
    const workspace = store.read().workspace
    try {
      return inspectCodexWorkspacePermissions(providerRoots, workspace)
    } catch (error) {
      return {
        configPath: path.join(providerRoots.codexHome, 'config.toml'),
        workspace,
        configExists: false,
        trustLevel: 'unknown',
        approvalPolicy: null,
        permissionProfile: null,
        sandboxMode: null,
        control: 'unknown',
        error: error instanceof Error ? error.message : 'Codex 权限配置读取失败',
      }
    }
  }

  async function trustCodexWorkspaceForService(
    target: RendererMessageTarget,
  ): Promise<CodexWorkspacePermissionWriteResult & { restarted: boolean }> {
    const workspace = store.read().workspace
    if (!path.isAbsolute(workspace)) throw new Error('Codex 工作目录不是绝对路径')
    try {
      if (!fs.statSync(workspace).isDirectory()) throw new Error('工作目录不是文件夹')
    } catch {
      throw new Error('Codex 工作目录不存在，请重新选择')
    }
    // 客户点的按钮，等保存做完再写，不像打开前那几样排不上就算了；重开桌面端放在队外（它自己还要排队）。
    const result = await serializeConfigWrite(async () => trustCodexWorkspace(providerRoots, workspace))
    let restarted = false
    // 只在 Windows 上替人重开：Mac 上主进程一律拒绝重启 Codex（codex-desktop-service.ts），
    // 信任这时已经写进去了，再去重启只会把「已保存」变成一个报错框（第二十九批 A 的同一个原因）。
    if (result.changed && platform === 'win32') {
      const desktop = await inspectCodexDesktop()
      if (desktop.running) {
        await launchCodexDesktop('restart', target)
        restarted = true
      }
    }
    return {
      ...result,
      restarted,
      status: inspectCodexWorkspacePermissionsForService(),
    }
  }

  async function setCodexDesktopLocale(
    locale: CodexDesktopLocale,
    target: RendererMessageTarget,
  ): Promise<CodexDesktopLocaleResult> {
    if (locale !== 'zh-CN' && locale !== 'system') throw new Error('Codex Desktop 语言选项无效')
    const before = await inspectCodexDesktopLocale()
    if (before.error) throw new Error(before.error)
    if (!before.installed) throw new Error('未检测到 Codex Desktop，请先安装后重新检测')
    if (locale === 'zh-CN' && !before.chineseResources.available) {
      throw new Error('当前 Codex Desktop 安装包没有本地简体中文资源，请先通过镜像更新 Codex Desktop')
    }
    const changed = codexDesktopLocaleNeedsChange(before.configuredLocale, locale)
    if (changed) await serializeConfigWrite(() => writeCodexDesktopLocale({ codexHome: providerRoots.codexHome }, locale))
    // This call is the explicit switch for the runtime patch, so it is also the
    // only place that grants or withdraws consent for the debugging port. Store
    // it before the restart: a failed restart must not leave the later ordinary
    // 「打开」 path disagreeing with what the user just chose.
    await store.update({ version: 2, codexDesktopChineseRuntimePatch: locale === 'zh-CN' ? 'enabled' : 'disabled' })
    let launchResult: CodexDesktopLaunchResult | undefined
    // A saved zh-CN preference is not proof that a previous runtime patch
    // worked. Explicitly enabling Chinese is also the retry path.
    if (before.running && platform === 'win32' && (changed || locale === 'zh-CN')) {
      launchResult = await launchCodexDesktop('restart', target, { injectChinese: locale === 'zh-CN' })
    }
    const after = await inspectCodexDesktopLocale()
    if (codexDesktopLocaleNeedsChange(after.configuredLocale, locale)) {
      throw new Error('语言设置保存后未通过回读检查，请重新尝试')
    }
    const runtimeVerified = locale === 'zh-CN' && launchResult?.chineseLocale?.status === 'verified'
    const warning = locale === 'zh-CN' && launchResult && !runtimeVerified
      ? launchResult.chineseLocale?.message || '中文设置已保存，但本次未确认中文界面生效。请再次启用中文界面以重试。'
      : undefined
    return {
      ...after,
      restarted: launchResult?.restarted ?? false,
      runtimeVerified,
      needsRestart: locale === 'zh-CN' ? !runtimeVerified : changed && !launchResult,
      ...(warning ? { warning } : {}),
    }
  }

  return {
    launchCodexDesktop,
    launchProvider,
    inspectCodexDesktopLocale,
    inspectCodexWorkspacePermissionsForService,
    trustCodexWorkspaceForService,
    setCodexDesktopLocale,
  }
}
