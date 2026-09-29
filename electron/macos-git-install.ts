import { CommandRunnerError, runCommand, trustedCommandEnvironment, type CommandResult } from './command-runner'
import { gitMacInstallWaitingHint } from './git-runtime'
import type {
  GitRuntimeArchitecture,
  GitRuntimeInstallProgress,
  GitRuntimeInstallResult,
} from './git-runtime-install'
import {
  inspectCommandLineToolsShim,
  xcodeLicensePendingNotice,
  xcodeSelectExecutable,
  type CommandLineToolsShimState,
} from './macos-command-line-tools'

/**
 * macOS 上 Git 来自苹果的「命令行开发者工具」。客户点「安装 Git」时由本软件运行一次
 * `xcode-select --install`，系统就会弹出苹果自己的安装窗口（第十六批 2）。本软件不提权、
 * 不开终端：下载、要不要输密码、装到哪里，全是苹果那个窗口自己的事。
 *
 * 那个窗口不回报结果，所以之后只能自己盯：每隔几秒看一次 /usr/bin/git 背后那份是不是
 * 已经能用（macos-command-line-tools.ts 的同一套判断，不会把对话框再招出来一次），
 * 同时看苹果的安装程序还在不在跑。它先出现、后消失，而 Git 还是不能用，就是客户点了
 * 「取消」。
 */

/** 苹果那个安装窗口的程序名（推测：没在真 Mac 上核对过进程名）。 */
const commandLineToolsInstallerName = 'Install Command Line Developer Tools'

export type MacGitInstallRequest = 'prompted' | 'already-installed'

/**
 * `xcode-select --install` 弹出窗口后立刻以 0 退出；已经装好时以 1 退出并在 stderr
 * 写「command line tools are already installed」。两者之外一律当失败。
 */
export async function requestMacCommandLineToolsInstall(
  execute: (executable: string, argv: readonly string[]) => Promise<CommandResult> = defaultExecute,
): Promise<MacGitInstallRequest> {
  try {
    await execute(xcodeSelectExecutable, ['--install'])
    return 'prompted'
  } catch (error) {
    const output = error instanceof CommandRunnerError ? `${error.stdout}\n${error.stderr}` : ''
    if (/already installed/i.test(output)) return 'already-installed'
    throw new Error('没能打开苹果的安装窗口，可以再点一次「安装 Git」；还不行请联系客服')
  }
}

function defaultExecute(executable: string, argv: readonly string[]): Promise<CommandResult> {
  return runCommand({ executable, argv: [...argv] }, {
    env: trustedCommandEnvironment(process.env, undefined, 'darwin'),
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
  })
}

/** `ps -A -o comm=` 每行一个可执行文件路径；只认苹果安装窗口那一个名字。 */
export function isCommandLineToolsInstallerListed(psOutput: string): boolean {
  return psOutput.split(/\r?\n/).some((line) => line.includes(commandLineToolsInstallerName))
}

async function defaultIsInstallerRunning(): Promise<boolean | null> {
  try {
    const result = await runCommand({ executable: '/bin/ps', argv: ['-A', '-o', 'comm='] }, {
      env: trustedCommandEnvironment(process.env, undefined, 'darwin'),
      timeoutMs: 10_000,
      maxOutputBytes: 4 * 1024 * 1024,
    })
    return isCommandLineToolsInstallerListed(result.stdout)
  } catch {
    // 看不到进程列表时不下结论，只靠 Git 能不能用来判断。
    return null
  }
}

export type MacGitInstallWaitOutcome = 'installed' | 'cancelled' | 'unconfirmed' | 'timed-out'

export interface MacGitInstallWaitDependencies {
  inspectGit(): Promise<CommandLineToolsShimState>
  isInstallerRunning(): Promise<boolean | null>
  sleep(milliseconds: number): Promise<void>
  now(): number
}

export interface MacGitInstallWaitOptions {
  pollMs?: number
  /**
   * 过了这段时间还一次都没在进程列表里看到苹果的安装程序，就不再让按钮一直转着：
   * 客户秒关了窗口和进程名对不上两种情况分不清，只给一句两头都对的话。
   */
  unseenGiveUpMs?: number
  /** 苹果的下载可能要很久；超过这个时间就不再替客户盯着，让他装完自己点「重新检测」。 */
  timeoutMs?: number
  signal?: AbortSignal
}

const defaultWaitDependencies: MacGitInstallWaitDependencies = {
  inspectGit: () => inspectCommandLineToolsShim('/usr/bin/git'),
  isInstallerRunning: defaultIsInstallerRunning,
  sleep: (milliseconds) => new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  }),
  now: () => Date.now(),
}

/**
 * 盯着苹果的安装窗口，直到 Git 能用、客户取消，或者等太久。
 *
 * 判「取消」要同时满足：Git 仍不能用，安装程序曾经出现过、现在又不在了（连续两次看不到，
 * 避开刚好换进程的那一下）。安装程序一直没被看到时（客户秒关了窗口、进程名推测错了，
 * 或者读不到进程列表）分不清是哪一种，等一分钟后回 unconfirmed，不说成取消。
 */
export async function waitForMacCommandLineTools(
  dependencies: Partial<MacGitInstallWaitDependencies> = {},
  options: MacGitInstallWaitOptions = {},
): Promise<MacGitInstallWaitOutcome> {
  const deps = { ...defaultWaitDependencies, ...dependencies }
  const pollMs = options.pollMs ?? 5_000
  const timeoutMs = options.timeoutMs ?? 60 * 60_000
  const unseenGiveUpMs = options.unseenGiveUpMs ?? 60_000
  const startedAt = deps.now()
  let seenInstaller = false
  let missingTicks = 0
  while (true) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('操作已取消')
    if (await deps.inspectGit() === 'usable') return 'installed'
    const running = await deps.isInstallerRunning()
    if (running === true) {
      seenInstaller = true
      missingTicks = 0
    } else if (running === false && seenInstaller) {
      missingTicks += 1
      if (missingTicks >= 2) {
        // 装完的那一刻安装程序也会退出：最后再看一次，别把刚装好的当成取消。
        return await deps.inspectGit() === 'usable' ? 'installed' : 'cancelled'
      }
    }
    const elapsed = deps.now() - startedAt
    if (!seenInstaller && elapsed >= unseenGiveUpMs) return 'unconfirmed'
    if (elapsed >= timeoutMs) return 'timed-out'
    await deps.sleep(pollMs)
  }
}

/** 装完 / 取消 / 等太久，首页各给一句话。 */
export function macGitInstallOutcomeMessage(outcome: MacGitInstallWaitOutcome): string {
  if (outcome === 'installed') return 'Git 装好了。'
  if (outcome === 'cancelled') return '没有装 Git。需要时再点一次「安装 Git」就行。'
  if (outcome === 'unconfirmed') {
    return '在苹果的窗口里装完后，点首页右上角的「重新检测」就好；要是点了取消，需要时再点一次「安装 Git」。'
  }
  return '苹果的安装窗口还没装完。装完后点首页右上角的「重新检测」就好。'
}

export interface MacGitRuntimeInstallDependencies {
  /** 本软件平时那套 Git 探测（system-service 的 inspectGit）：Homebrew 装的也算。 */
  inspectInstalled(): Promise<{ version: string | null } | null>
  inspectShim(): Promise<CommandLineToolsShimState>
  /** 调用方负责把这一步排进安装队列（I11）；等待苹果窗口那一段不占队列。 */
  request(): Promise<MacGitInstallRequest>
  wait(): Promise<MacGitInstallWaitOutcome>
  onProgress?(progress: GitRuntimeInstallProgress): void
}

/** 苹果说「已经装过」，Git 却还是用不了（多半是开发者目录指错了或被删了一半）。 */
export const macGitAlreadyInstalledButMissingMessage =
  '这台 Mac 上苹果的开发者工具显示已经装过，但 Git 还是用不了。可以重启电脑后再点一次「安装 Git」；还不行请联系客服'

export async function installMacGitRuntime(
  dependencies: MacGitRuntimeInstallDependencies,
  architecture: GitRuntimeArchitecture,
): Promise<GitRuntimeInstallResult> {
  const progress = (message: string, phase: GitRuntimeInstallProgress['phase']) => {
    dependencies.onProgress?.({ phase, source: null, message, percent: phase === 'complete' ? 100 : null })
  }
  const installed = (version: string | null, action: 'installed' | 'unchanged'): GitRuntimeInstallResult => ({
    installed: true,
    action,
    source: null,
    version,
    architecture,
    pathRefreshRequired: false,
  })
  const existing = await dependencies.inspectInstalled()
  if (existing) {
    progress('Git 本来就装好了，不用重复安装', 'complete')
    return installed(existing.version, 'unchanged')
  }
  // 装了 Xcode 但没点过「同意」时，苹果的安装窗口不会弹（它认为已经装好了），
  // 只能告诉客户去点那一下。
  if (await dependencies.inspectShim() === 'license-pending') {
    throw new Error(`${xcodeLicensePendingNotice('git')}。`)
  }
  if (await dependencies.request() === 'already-installed') {
    const after = await dependencies.inspectInstalled()
    if (after) return installed(after.version, 'unchanged')
    throw new Error(macGitAlreadyInstalledButMissingMessage)
  }
  progress(gitMacInstallWaitingHint, 'installing')
  const outcome = await dependencies.wait()
  if (outcome === 'installed') {
    const after = await dependencies.inspectInstalled()
    progress(macGitInstallOutcomeMessage('installed'), 'complete')
    return installed(after?.version ?? null, 'installed')
  }
  return {
    installed: false,
    action: outcome === 'cancelled' ? 'cancelled' : 'pending',
    source: null,
    version: null,
    architecture,
    pathRefreshRequired: false,
    message: macGitInstallOutcomeMessage(outcome),
  }
}
