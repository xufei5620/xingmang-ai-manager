// 装运行环境（Node.js、Python、Git）和装完要重启 Windows 的那一段（#1070 第 3 步，从 system-service.ts 的
// createSystemService 原样搬来）：Node.js 太旧、认不得公司证书时换一份，Windows 上看处理器挑安装包，Mac 上
// 弹苹果自己的 Git 安装窗口（一次只弹一个），以及有任务在跑时不发重启。
//
// 各簇共用的那份在 system-service-context.ts；归首页检测和工具钩子的几样由 createSystemService 传进来
// （RuntimeInstallServiceDependencies）。这里只 import system-service.ts 的类型。
import { trustedCommandEnvironment, windowsSystemExecutable } from './command-runner'
import type { GitRuntimeInstallProgress, GitRuntimeInstallResult } from './git-runtime-install'
import type { NodeRuntimeInstallRequest } from './ipc-contract'
import { inspectCommandLineToolsShim } from './macos-command-line-tools'
import { requestMacCommandLineToolsInstall, waitForMacCommandLineTools } from './macos-git-install'
import type { NodeRuntimeInstallResult } from './node-runtime'
import type { PythonRuntimeInstallResult } from './python-runtime'
import { nodeReadsSystemCertificates } from './system-certificate-trust'
import type { NetworkRegion, RendererMessageTarget, ToolStatus } from './system-service'
import { buildToolStatusFromSettled, type ServiceContext } from './system-service-context'
import {
  chooseNodeRuntimeArchitecture,
  inspectWindowsProcessorArchitecture,
  type WindowsProcessorArchitecture,
} from './windows-processor'

/**
 * 客户点了「换成新版 Node.js」（公司电脑的证书要 22.19 / 24.6 以上才认）时，已经装着的
 * Node.js 即使够装工具也要照样换。Windows 上换：那边装的是官方安装包，会接替
 * Program Files 里原来那份；Linux 上也换：本软件代下的那份排在 PATH 最前
 * （linux-platform.ts），装上就是它。Mac 上代下的那份排在 PATH 最后，客户自己的旧版
 * 永远先被找到，装了也白装（macos-platform.ts darwinCommandPathCandidates）。
 * 版本读不出（null）不换：那时不知道该怪 Node 旧。
 */
export function shouldReplaceNodeForCertificates(input: {
  platform: NodeJS.Platform
  request: NodeRuntimeInstallRequest
  node: Pick<ToolStatus, 'installed' | 'version'>
}): boolean {
  return input.platform !== 'darwin'
    && input.request.reason === 'certificate'
    && input.node.installed
    && nodeReadsSystemCertificates(input.node.version) === false
}

export const nodeStillOutdatedAfterReplaceMessage = '新版 Node.js 已经装上了，但电脑上另外还有一份旧的 Node.js 排在前面，工具仍会先用到它，还是认不了这台电脑的证书。请联系客服帮你处理。'

/** 装运行环境要用、但归首页检测和工具钩子那两块管的几样，由 createSystemService 传进来。 */
export interface RuntimeInstallServiceDependencies {
  inspectNetworkRegion: () => Promise<NetworkRegion>
  inspectTool: (command: string, args?: string[]) => Promise<ToolStatus>
  inspectNode: () => Promise<ToolStatus>
  inspectPython: () => Promise<ToolStatus>
  inspectGit: () => Promise<ToolStatus>
  /** Windows 上装好 Git 以后，Grok 的钩子按新的命令行重写。 */
  refreshGrokHooksForShellChange: () => Promise<void>
  /** Windows 上只装 Grok 时缺的那几条钩子，装好运行环境就补上。 */
  addMissingGrokHooks: (trigger: 'runtime-installed') => Promise<boolean>
}

export function createRuntimeInstallService(context: ServiceContext, dependencies: RuntimeInstallServiceDependencies) {
  const {
    serviceOptions, windowsExecutionMode, platform, runtimeLog, executeCommand, installPythonRuntimeForService,
    inspectWindowsRestartRequiredForService, installNodeRuntimeForService, installGitRuntimeForService,
    installMacGitRuntimeWith, downloadFetch, resolveWindowsMachinePathsForService, installationQueue,
    nodeRuntimeInstall, inspectExecutableMachine, withDownloadAcceleration, forgetPreferredNodeDirectories,
    forgetNpmGlobalRoots,
  } = context
  const {
    inspectNetworkRegion,
    inspectTool,
    inspectNode,
    inspectPython,
    inspectGit,
    refreshGrokHooksForShellChange,
    addMissingGrokHooks,
  } = dependencies

  let windowsProcessor: Promise<WindowsProcessorArchitecture | null> | null = null
  // 苹果的安装窗口一次只该弹一个：连点两下「安装 Git」拿到的是同一次等待。
  let macGitInstall: Promise<GitRuntimeInstallResult> | null = null
  let pythonRuntimeInstalling = false

  async function installNodeRuntimeOperation(
    target: RendererMessageTarget,
    request: NodeRuntimeInstallRequest,
  ): Promise<NodeRuntimeInstallResult> {
    if (nodeRuntimeInstall.running) throw new Error('Node.js 正在安装中，请等待当前任务完成')
    nodeRuntimeInstall.running = true
    try {
      const [nodeResult, npmResult] = await Promise.allSettled([inspectNode(), inspectTool('npm')])
      const node = buildToolStatusFromSettled(nodeResult)
      const npm = buildToolStatusFromSettled(npmResult)
      if (node.detectionFailed || npm.detectionFailed) {
        throw new Error(node.detectionError ?? npm.detectionError ?? 'Node.js/npm 检测失败，请重新检测后再试')
      }
      const replaceForCertificates = shouldReplaceNodeForCertificates({ platform, request, node })
      if (node.installed && node.versionStatus === 'supported' && npm.installed && !replaceForCertificates) {
        const architecture = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : 'x64'
        const result: NodeRuntimeInstallResult = {
          installed: true,
          action: 'unchanged',
          method: null,
          source: null,
          version: node.version,
          architecture,
          pathRefreshRequired: false,
          systemRestartRequired: false,
        }
        if (!target.isDestroyed()) {
          target.send('runtime:node-install-progress', {
            phase: 'complete',
            source: null,
            message: `已检测到可用的 Node.js ${node.version ?? ''} 和 npm，无需重复安装`.trim(),
            percent: 100,
          })
        }
        return result
      }
      if (platform === 'win32') {
        // 以前 Windows 在等重启（系统更新装完没重启）就不装，叫客户先重启。可 Node.js 的安装包不看这两个
        // 标记（nodejs/node 的 tools/msvs/msi/nodemsi/product.wxs 只拦系统版本）：带 /norestart 装，真要
        // 重启时退出码是 3010，走装完要重启那条；真被挡住时 1603、1618、1925 那几句本来就叫客户重启。
        // 拦在前面反倒常见：合盖不关机的电脑几天都在「等重启」，标记卡住的重启了还在，客户就永远装不上。
        // 现在照样装，只把这件事记进运行日志，装不上时客服看得见。装工具时缺 Node.js 自己补装的那一路
        // （cli-install-service.ts）本来就不查。
        try {
          const restartStatus = await inspectWindowsRestartRequiredForService()
          if (restartStatus.required) {
            runtimeLog?.log('info', 'install', 'node.install.restart-pending', 'Windows 在等重启，照样先装 Node.js', { reasons: restartStatus.reasons })
          }
        } catch (error) {
          runtimeLog?.log('warn', 'install', 'node.install.restart-probe-failed', '没查清 Windows 是否在等重启，先接着装', { reason: error instanceof Error ? error.message : String(error) })
        }
      }
      const architecture = platform === 'win32'
        ? chooseNodeRuntimeArchitecture({
          processor: await inspectWindowsProcessor(),
          existingNodeMachine: node.installed && node.path ? await inspectExecutableMachine(node.path) : null,
          nodeInstalled: node.installed,
        })
        : undefined
      if (architecture === 'arm64' && process.arch !== 'arm64' && !target.isDestroyed()) {
        target.send('runtime:node-install-progress', {
          phase: 'checking',
          source: null,
          message: '这台电脑是 ARM 芯片，会装 ARM 版 Node.js，工具跑起来更快、更省电',
          percent: null,
        })
      }
      const result = await installNodeRuntimeForService({
        ...(architecture ? { architecture } : {}),
        // 到要下载时才问先走哪个源：Windows 借到线路以后才定，借到了就官方源优先。
        // Windows 开头还会先问一次，只用来定试不试 winget（只在海外试，#1061 第5条）。
        networkRegion: inspectNetworkRegion,
        // Windows 在海外先试 winget，它自己下载、不走下载专用线路，退到下安装包时才借（第二十八批 D）；
        // macOS、Linux 一开始就是下载，整段已经包在线路里（installNodeRuntime）。
        withDownloadRoute: platform === 'win32' ? (operation) => withDownloadAcceleration(null, operation) : undefined,
        temporaryDirectoryMode: windowsExecutionMode,
        dependencies: { fetch: downloadFetch },
        onProgress: (progress) => {
          if (!target.isDestroyed()) target.send('runtime:node-install-progress', progress)
        },
      })
      // Mac 上客户自己那份太旧时，刚下好的这份当场就用上，后面装工具不再去下（第三十四批 A）。
      forgetPreferredNodeDirectories()
      if (replaceForCertificates) await assertNodeReplacedForCertificates()
      return result
    } finally {
      // 装成、装到一半失败都可能已经换了 npm，全局安装目录下次重新问；不必装的那条路多问一次也不贵。
      forgetNpmGlobalRoots()
      nodeRuntimeInstall.running = false
    }
  }

  /**
   * 装新版的目的是让工具认得公司证书，装完却仍然找到旧的那份（比如 nvm 之类的
   * 版本管理工具把自己的目录放在前面），工具还是会失败。这时照实说，别让客户以为
   * 换好了、回去重试再撞同一个错。读不出版本就不下结论。
   */
  async function assertNodeReplacedForCertificates(): Promise<void> {
    let version: string | null = null
    try { version = (await inspectTool('node')).version } catch { return }
    if (nodeReadsSystemCertificates(version) !== false) return
    throw new Error(nodeStillOutdatedAfterReplaceMessage)
  }

  function inspectWindowsProcessor(): Promise<WindowsProcessorArchitecture | null> {
    // 芯片开机后不会变，一次启动只问一次；问失败也记住「不知道」，不反复起 reg.exe。
    windowsProcessor ??= (serviceOptions.inspectWindowsProcessor
      ?? (() => inspectWindowsProcessorArchitecture({ platform, machinePaths: () => resolveWindowsMachinePathsForService() })))()
      .catch(() => null)
    return windowsProcessor
  }

  function installNodeRuntime(
    target: RendererMessageTarget,
    request: NodeRuntimeInstallRequest = {},
  ): Promise<NodeRuntimeInstallResult> {
    // Windows 只在退到下安装包时借线路，见 installNodeRuntimeOperation 传下去的 withDownloadRoute。
    return installationQueue.enqueue('runtime:node', () => platform === 'win32'
      ? installNodeRuntimeOperation(target, request)
      : withDownloadAcceleration(null, () => installNodeRuntimeOperation(target, request)))
      .then(async (result) => {
        // 等补完再回，首页随后那次刷新就不再显示「补上」。它自己兜住所有错误，不影响装运行环境的结果。
        if (platform === 'win32') await addMissingGrokHooks('runtime-installed')
        return result
      })
  }

  async function restartWindows(): Promise<void> {
    if (platform !== 'win32') throw new Error('系统重启仅支持 Windows')
    // shutdown /r 会在倒计时结束后强行结束本程序，队列里的安装会停在原子替换的
    // 半截（I11 保护的正是这种中间态），所以有任务在跑就不发重启。
    if (installationQueue.busy) throw new Error('还有安装、卸载或打开工具的任务在进行，等它做完再重启电脑')
    const machinePaths = resolveWindowsMachinePathsForService()
    await executeCommand({
      executable: windowsSystemExecutable('shutdown.exe', process.env, 'win32', machinePaths),
      argv: ['/r', '/t', '15', '/d', 'p:0:0', '/c', 'XingMang AI requires a restart to finish Windows updates'],
    }, {
      env: trustedCommandEnvironment(process.env, machinePaths, 'win32'),
      trustedOnly: true,
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    })
  }

  async function installPythonRuntimeOperation(target: RendererMessageTarget): Promise<PythonRuntimeInstallResult> {
    if (pythonRuntimeInstalling) throw new Error('Python 正在安装中，请等待当前任务完成')
    pythonRuntimeInstalling = true
    try {
      const [pythonResult] = await Promise.allSettled([inspectPython()])
      const python = buildToolStatusFromSettled(pythonResult)
      if (python.detectionFailed) {
        throw new Error(python.detectionError ?? 'Python 检测失败，请重新检测后再试')
      }
      const architecture = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : 'x64'
      if (python.installed && Boolean(python.version?.trim())) {
        const result: PythonRuntimeInstallResult = {
          installed: true,
          action: 'unchanged',
          method: null,
          source: null,
          version: python.version,
          architecture,
          pathRefreshRequired: false,
        }
        if (!target.isDestroyed()) {
          target.send('runtime:python-install-progress', {
            phase: 'complete',
            source: null,
            message: '已检测到可用的 ' + python.version + '，无需重复安装',
            percent: 100,
          })
        }
        return result
      }
      // 商店装不上时退到 python.org 下载，那是国外的站：和装 Node.js、Git 一样借一条
      // 下载专用线路（不改系统代理），所以 fetch 也要换成认这条线路的那一个。商店那一步
      // 自己下载、不走这条线路，所以退到 python.org 时才借（第二十八批 D）。
      return await installPythonRuntimeForService({
        architecture: process.arch,
        temporaryDirectoryMode: windowsExecutionMode,
        withDownloadRoute: (operation) => withDownloadAcceleration(null, operation),
        onProgress: (progress) => {
          if (!target.isDestroyed()) target.send('runtime:python-install-progress', progress)
        },
        dependencies: { fetch: downloadFetch },
      })
    } finally {
      pythonRuntimeInstalling = false
    }
  }

  function installPythonRuntime(target: RendererMessageTarget): Promise<PythonRuntimeInstallResult> {
    return installationQueue.enqueue('runtime:python', () => installPythonRuntimeOperation(target))
  }

  async function installGitRuntimeOperation(
    target: RendererMessageTarget,
    onProgress?: (progress: GitRuntimeInstallProgress) => void,
  ): Promise<GitRuntimeInstallResult> {
    if (platform !== 'win32') throw new Error('Git 自动安装当前仅支持 Windows 和 macOS')
    const git = buildToolStatusFromSettled((await Promise.allSettled([inspectGit()]))[0])
    if (git.detectionFailed) throw new Error(git.detectionError ?? 'Git 检测失败，请重新检测后再试')
    const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
    if (git.installed) {
      if (!target.isDestroyed()) {
        target.send('runtime:git-install-progress', {
          phase: 'complete',
          source: null,
          message: 'Git 本来就装好了，不用重复安装',
          percent: 100,
        })
      }
      return {
        installed: true,
        action: 'unchanged',
        source: null,
        version: git.version,
        architecture,
        pathRefreshRequired: false,
      }
    }
    return installGitRuntimeForService({
      networkRegion: await inspectNetworkRegion(),
      temporaryDirectoryMode: windowsExecutionMode,
      dependencies: { fetch: downloadFetch },
      // 安装程序退出 0 不等于装好：被安全软件或公司策略拦了一半时它照样退出 0（#549）。
      // inspectGit 会额外找代装的两个固定目录，本进程的 PATH 没刷新也找得到。
      verifyInstalled: async () => {
        const installed = await inspectGit()
        return installed.installed ? { version: installed.version } : null
      },
      onProgress: (progress) => {
        if (!target.isDestroyed()) target.send('runtime:git-install-progress', progress)
        onProgress?.(progress)
      },
    })
  }

  /**
   * macOS 上的 Git 交给苹果自己的安装窗口（第十六批 2）。只有「弹窗口」这一下进安装队列；
   * 之后客户在苹果窗口里下载安装可能要十几分钟，这段等待不能占着队列，否则别的工具
   * 全都装不了。
   */
  function installMacGitRuntimeForService(target: RendererMessageTarget): Promise<GitRuntimeInstallResult> {
    macGitInstall ??= installMacGitRuntimeWith({
      inspectInstalled: async () => {
        const git = await inspectGit()
        return git.installed ? { version: git.version } : null
      },
      inspectShim: () => inspectCommandLineToolsShim('/usr/bin/git'),
      request: () => installationQueue.enqueue('runtime:git', () => requestMacCommandLineToolsInstall()),
      wait: () => waitForMacCommandLineTools(),
      onProgress: (progress) => {
        if (!target.isDestroyed()) target.send('runtime:git-install-progress', progress)
      },
    }, process.arch === 'arm64' ? 'arm64' : 'x64').finally(() => {
      macGitInstall = null
    })
    return macGitInstall
  }

  function installGitRuntime(
    target: RendererMessageTarget,
    onProgress?: (progress: GitRuntimeInstallProgress) => void,
  ): Promise<GitRuntimeInstallResult> {
    if (platform === 'darwin') return installMacGitRuntimeForService(target)
    return installationQueue.enqueue('runtime:git',
      () => withDownloadAcceleration(null, () => installGitRuntimeOperation(target, onProgress)))
      .then((result) => {
        if (result.installed && result.action === 'installed') void refreshGrokHooksForShellChange()
        return result
      })
  }

  return { installNodeRuntime, inspectWindowsProcessor, restartWindows, installPythonRuntime, installGitRuntime }
}
