// 一键检测里「系统与权限」那几项（#1070 第 9 步，从 diagnostics.ts 的 runDiagnostics 原样搬来）：星芒版本、操作系统、
// 电脑芯片（Windows 上的 ARM 笔记本）、运行权限（是不是以管理员身份在跑、这个账号能不能提权）、打开工具用的命令窗口
// （Windows 上是 PowerShell，Linux 上是终端程序，Mac 不用）。
//
// 各类检查共用的那份在 diagnostics-context.ts；这里只 import diagnostics.ts 的类型，免得两个文件互相 require。
import { commandEnvironment, runCommand, trustedCommandEnvironment } from './command-runner'
import type { CheckDefinition, CheckOutcome, DiagnosticToolStatus } from './diagnostics'
import type { DiagnosticsContext } from './diagnostics-context'
import { pathForDisplay } from './diagnostics-redaction'
import { readLinuxSystemName } from './linux-os-release'
import { findLinuxTerminals } from './linux-terminal'
import {
  describeWindowsExecutionProbeFailure,
  inspectCurrentWindowsProcessHighIntegrity,
  inspectWindowsElevationCapability,
  resolveWindowsPowerShellExecutable,
} from './windows-elevation'
import { inspectWindowsExecutableMachine, type WindowsExecutableMachine } from './windows-processor'

async function defaultInspectAdministrator(signal: AbortSignal): Promise<boolean> {
  if (process.platform !== 'win32') return typeof process.getuid === 'function' && process.getuid() === 0
  // whoami 几十毫秒就答；PowerShell 冷启动在慢电脑上要好几秒，和下面问「能不能提权」
  // 那次加起来就超过单项预算了。读不出完整性标签时才退回 PowerShell。
  const highIntegrity = await inspectCurrentWindowsProcessHighIntegrity({ timeoutMs: 3_000 }).catch(() => null)
  if (highIntegrity !== null) return highIntegrity
  const script = [
    '$identity=[Security.Principal.WindowsIdentity]::GetCurrent()',
    '$principal=[Security.Principal.WindowsPrincipal]::new($identity)',
    '$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  ].join(';')
  const result = await runCommand({
    executable: resolveWindowsPowerShellExecutable(),
    argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
  }, {
    env: trustedCommandEnvironment(),
    trustedOnly: true,
    timeoutMs: 4_000,
    maxOutputBytes: 16 * 1024,
    signal,
  })
  return result.stdout.trim().toLowerCase() === 'true'
}

async function defaultInspectPowerShell(
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<DiagnosticToolStatus> {
  let executable: string
  try {
    executable = resolveWindowsPowerShellExecutable({ env })
  } catch {
    return { installed: false, version: null, path: null }
  }
  const result = await runCommand({
    executable,
    argv: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$PSVersionTable.PSVersion.ToString()',
    ],
  }, {
    env: trustedCommandEnvironment(env),
    trustedOnly: true,
    timeoutMs: 4_000,
    maxOutputBytes: 16 * 1024,
    signal,
  })
  return {
    installed: true,
    version: result.stdout.trim() || null,
    path: executable,
  }
}

/**
 * 「操作系统」一项的结论说人话：Windows 11（64 位）、macOS 15（Apple 芯片）。
 * Windows 11 的内核号仍是 10.0，只能按版本号 22000 起算；macOS 从 Darwin 20
 * （macOS 11）起主版本号差 9，Darwin 25 起苹果跳到 26。认不出就原样给。
 *
 * Linux 的内核号对客服没用，要的是发行版（linux-os-release.ts 读出来的
 * 「Ubuntu 24.04.1 LTS」），读不到才只写 Linux。
 */
export function operatingSystemSummary(platform: NodeJS.Platform, release: string, arch: string, linuxSystemName?: string | null): string {
  if (platform === 'win32') {
    const match = release.match(/^(\d+)\.(\d+)\.(\d+)/)
    if (match && match[1] === '10' && match[2] === '0') {
      const name = Number(match[3]) >= 22_000 ? 'Windows 11' : 'Windows 10'
      const bits = arch === 'arm64' ? 'ARM 芯片' : arch === 'ia32' ? '32 位' : '64 位'
      return `${name}（${bits}）`
    }
  }
  if (platform === 'darwin') {
    const darwinMajor = Number(release.match(/^(\d+)\./)?.[1])
    if (Number.isInteger(darwinMajor) && darwinMajor >= 20) {
      const version = darwinMajor >= 25 ? darwinMajor + 1 : darwinMajor - 9
      // Intel Mac 的「关于本机」写的是「处理器」不是「芯片」，照客户能对上的叫法说（#1155）。
      const chip = arch === 'arm64' ? 'Apple 芯片' : 'Intel 处理器'
      return `macOS ${version}（${chip}）`
    }
  }
  if (platform === 'linux') {
    const chip = arch === 'arm64' ? 'ARM 芯片' : arch === 'x64' ? '64 位' : arch
    return `${linuxSystemName || 'Linux'}（${chip}）`
  }
  return `${platform} ${release} (${arch})`
}

/**
 * 「电脑芯片」一项的结论。面向小白：只说「ARM 芯片」「ARM 版」「普通电脑用的版本」，
 * 不出现 arm64 / x64 / 模拟层这些词。
 */
export function buildWindowsArmSummary(input: {
  nodeInstalled: boolean
  nodeMachine: WindowsExecutableMachine | null
  appArch: string
}): string {
  const node = !input.nodeInstalled
    ? '这台电脑是 ARM 芯片，装 Node.js 时会自动装 ARM 版，之后装的工具跑起来更快、更省电'
    : input.nodeMachine === 'arm64'
      ? '这台电脑是 ARM 芯片，Node.js 已是 ARM 版，用它装的工具也按 ARM 版运行'
      : input.nodeMachine === 'x64' || input.nodeMachine === 'x86'
        ? '这台电脑是 ARM 芯片，现有的 Node.js 是给普通电脑用的版本，工具能正常用，只是会慢一些、更费电'
        : '这台电脑是 ARM 芯片'
  const app = input.appArch === 'arm64'
    ? ''
    : '。星芒本身暂时只有普通电脑版，在这台电脑上靠系统转换运行，打开时会慢一点'
  return `${node}${app}`
}

export function buildSystemChecks(context: DiagnosticsContext): CheckDefinition[] {
  const { dependencies, env, displayRoots, platform, arch, release, scanned, inspectTool } = context
  const probePowerShell = dependencies.inspectPowerShell
    ?? ((signal) => defaultInspectPowerShell(signal, env))
  // Windows 上 Codex 桌面端那次探测本身就是经 resolveWindowsPowerShellExecutable 选出的
  // PowerShell 跑的：它没失败，就说明这个 PowerShell 找得到、起得来，不必为读一个版本号
  // 再起一次。只有这一种能省；桌面端探测失败或没有扫描结果时照旧自己探。
  const inspectPowerShell = (signal: AbortSignal): Promise<DiagnosticToolStatus> => {
    if (scanned && platform === 'win32' && !scanned.desktopApps.codex.detectionFailed) {
      try {
        const executable = dependencies.resolvePowerShellExecutable?.() ?? resolveWindowsPowerShellExecutable({ env })
        return Promise.resolve({ installed: true, version: null, path: executable })
      } catch { /* 找不到可信路径时交给自己探，让它给出同样的结论。 */ }
    }
    return probePowerShell(signal)
  }
  const findLinuxTerminal = dependencies.findLinuxTerminal
    ?? (() => findLinuxTerminals(commandEnvironment(env))[0] ?? null)
  const inspectAdmin = dependencies.inspectAdministrator ?? defaultInspectAdministrator
  const inspectElevation = dependencies.inspectElevationCapability
    ?? ((signal) => inspectWindowsElevationCapability({ timeoutMs: 3_000, signal }))
  const supportedPlatform = platform === 'win32' || platform === 'darwin' || platform === 'linux'

  return [
    {
      code: 'APP_RUNTIME',
      title: '星芒版本',
      run: () => ({
        state: 'pass',
        summary: `${dependencies.app.name} ${dependencies.app.version}`,
        details: { packaged: dependencies.app.packaged },
      }),
    },
    {
      code: 'OPERATING_SYSTEM',
      title: '操作系统',
      run: async () => {
        const linuxSystemName = platform === 'linux'
          ? await (dependencies.readLinuxSystemName ?? readLinuxSystemName)().catch(() => null)
          : null
        const macRosetta = platform === 'darwin' && dependencies.macRosetta === true
        const details: Record<string, string | boolean> = { supported: supportedPlatform }
        if (platform === 'darwin') Object.assign(details, { appArch: arch, rosetta: macRosetta })
        return {
          state: supportedPlatform ? 'pass' : 'warn',
          summary: operatingSystemSummary(platform, release, macRosetta ? 'arm64' : arch, linuxSystemName),
          details,
        }
      },
    },
    ...(platform === 'win32' && dependencies.windowsProcessor === 'arm64' ? [{
      // 星芒自己只出 x64 安装包，在 ARM 笔记本上靠系统模拟运行；Node.js 和经它装的
      // 工具是哪一版，要看 node.exe 自己，不能看本进程。这一项只做说明，不算故障。
      code: 'WINDOWS_ARM',
      title: '电脑芯片',
      timeoutOutcome: { state: 'pass', summary: '这台电脑是 ARM 芯片' },
      run: async (signal: AbortSignal): Promise<CheckOutcome> => {
        const node = await inspectTool('node', signal)
        const nodeMachine = node.installed && node.path
          ? await (dependencies.inspectExecutableMachine ?? inspectWindowsExecutableMachine)(node.path)
          : null
        return {
          state: 'pass',
          summary: buildWindowsArmSummary({ nodeInstalled: node.installed, nodeMachine, appArch: arch }),
          details: { nodeInstalled: node.installed, nodeMachine, appArch: arch },
        }
      },
    } satisfies CheckDefinition] : []),
    {
      // 这一项问两件事。一是「现在是不是管理员在跑」——是的话仍然建议普通启动。
      // 二是「这个账号需要时能不能提权」：Node.js 是机器级 MSI、Codex 桌面端是
      // Appx，两处都会弹 UAC，普通账号走到那一步才失败，太晚了。macOS 上本程序
      // 从不提权，所以第二问只在 Windows 上做。
      code: 'ADMINISTRATOR',
      title: '运行权限',
      // 软件按不按管理员方式做事，是启动时就定好的，这一项只负责说明。
      // 电脑正忙时它没问完，不该让用户以为出了故障。
      timeoutOutcome: {
        state: 'warn',
        summary: '电脑这会儿比较忙，没来得及确认运行权限。这不影响软件使用，稍后点「重新检测」再看一次',
        details: { timedOut: true },
      },
      run: async (signal): Promise<CheckOutcome> => {
        const windowsExecution = platform === 'win32' ? dependencies.windowsExecution : undefined
        const probeFailure = windowsExecution?.probeFailure
        // 启动时那次探测失败的机器上，这次探测多半也会失败（同样要起 PowerShell）。
        // 那时这一项要说的正是「没问出来」，不能让它自己的失败把原因盖掉。
        const elevated = probeFailure
          ? await Promise.resolve(inspectAdmin(signal)).catch(() => null)
          : await inspectAdmin(signal)
        const probeDetails: Record<string, string | number | null> = probeFailure
          ? {
              executionMode: windowsExecution?.mode ?? null,
              probeFailure: probeFailure.reason,
              probeElapsedMs: windowsExecution?.elapsedMs ?? null,
            }
          : {}
        if (probeFailure && windowsExecution?.mode === 'trusted-only') {
          // 启动时已经看出是高权限、只是细节没问出来，软件按管理员方式处理（从严）。
          // 这时再说「当前以普通用户权限运行」就和实际行为对不上，客服会被带偏。
          return {
            state: 'warn',
            summary: `软件这次是以管理员权限打开的，但没能确认细节，已按管理员方式处理，所以安装和打开工具可能会失败。原因：${describeWindowsExecutionProbeFailure(probeFailure.reason)}。请关掉软件，直接双击重新打开（不要选「以管理员身份运行」）；还不行请在「反馈与客服」页导出报告发给客服`,
            details: { elevated, required: false, ...probeDetails },
          }
        }
        if (elevated && !probeFailure && windowsExecution?.mode === 'same-user') {
          // 令牌是高权限，启动时却确认了不是专门提权打开的（TokenElevationType 为 default）：
          // 系统自带的 Administrator 账号，或整台电脑关了授权弹窗。这就是这个账号平常的
          // 权限，没有「普通启动」可选，软件也已按普通方式做事。国内很多装机版系统默认
          // 登这个账号，一直挂着「建议普通启动」只会让客户以为软件坏了（0.2.8 起就这样）。
          // 0.2.12 起这里曾黄着说「商店装的软件（比如 Codex 桌面端）可能打不开」，是误报，
          // 已撤掉，原因见 windows-store-availability.ts 开头。
          return {
            state: 'pass',
            summary: '这台电脑登录的账号本身就带管理员权限，软件每次都是这样打开的，已按平常方式运行，不用处理',
            details: { elevated, required: false, alwaysElevated: true },
          }
        }
        if (elevated) {
          return {
            state: 'warn',
            summary: '当前以管理员权限运行，建议普通启动',
            details: { elevated, required: false, canElevate: true, ...probeDetails },
          }
        }
        if (probeFailure) {
          // 什么都没看出来时按普通用户处理，软件照常能用，不必吓用户；原因只留给客服。
          // 「能不能提权」那一问同样要起 PowerShell，这时不再问。
          return {
            state: 'pass',
            summary: '当前以普通用户权限运行',
            details: { elevated, required: false, canElevate: null, ...probeDetails },
          }
        }
        const capability = platform === 'win32' ? await inspectElevation(signal) : 'unknown'
        if (capability === 'standard') {
          return {
            state: 'warn',
            summary: '当前以普通用户权限运行。这个 Windows 账号不在管理员组，自动安装 Node.js、Codex 桌面端时会要求输入一个管理员账号的密码；公司或学校的电脑请联系 IT 协助，也可以请 IT 先装好 Node.js LTS 再回来点「重新检测」',
            details: { elevated, required: false, canElevate: false },
          }
        }
        return {
          state: 'pass',
          summary: '当前以普通用户权限运行',
          details: { elevated, required: false, canElevate: capability === 'administrator' ? true : null },
        }
      },
    },
    {
      code: 'SYSTEM_POWERSHELL',
      title: '打开工具用的命令窗口',
      run: async (signal) => {
        if (platform === 'darwin') {
          return {
            state: 'pass',
            summary: 'Mac 不需要这一项',
            details: { required: false, installed: null, path: null },
          }
        }
        if (platform !== 'win32') {
          // Linux 上点「打开」要借一个命令窗口程序（终端），和「打开」用的是同一张查找表。
          const terminal = findLinuxTerminal()
          const outcome: CheckOutcome = {
            state: terminal ? 'pass' : 'fail',
            summary: terminal
              ? `可用，会用「${terminal.label}」打开工具`
              : '这台电脑上没找到能打开命令窗口的程序（终端），工具没法从星芒打开。打开系统自带的应用商店，搜「终端」装一个，再回来点「重新检测」',
            details: {
              required: true,
              installed: Boolean(terminal),
              terminal: terminal?.id ?? null,
              path: pathForDisplay(terminal?.executable ?? null, displayRoots),
            },
          }
          return outcome
        }
        const status = await inspectPowerShell(signal)
        return {
          state: status.installed ? 'pass' : 'fail',
          summary: status.installed
            ? '可用'
            : '这台电脑上找不到打开工具要用的系统命令窗口，工具没法从星芒打开。请在「反馈与客服」页导出报告发给客服',
          details: {
            required: true,
            installed: status.installed,
            path: pathForDisplay(status.path, displayRoots),
          },
        }
      },
    },
  ]
}
