import fs from 'node:fs'
import path from 'node:path'
import { commandEnvironment, runCommand } from './command-runner'
import { platformCapabilitiesFor } from './platform-capabilities'

/**
 * macOS ships `/usr/bin/git` and `/usr/bin/python3` on every machine, but they
 * are only trampolines into the active developer directory. When the Command
 * Line Tools (or Xcode) are not installed, running one of them does not fail
 * quietly: the system pops the "The git command requires the command line
 * developer tools" dialog and the command exits non-zero. A plain PATH lookup
 * finds the trampoline, so every runtime scan used to summon that dialog once
 * for git and once for python3, on every launch.
 *
 * 所以这两个固定路径在执行之前要先问一句「背后那份真的在不在」；用户自己装的
 * （Homebrew 的 /opt/homebrew/bin/git、python.org 的 Framework 那份）不在这张表里，
 * 照常探测。只列本应用会去探测版本的两个命令，不做成通用的 /usr/bin 黑名单。
 */
const commandLineToolsShims = new Set(['/usr/bin/git', '/usr/bin/python3'])

/** `xcode-select` itself is a real binary, not a trampoline, and never prompts. */
export const xcodeSelectExecutable = '/usr/bin/xcode-select'

/** 只有 macOS 上这两个固定路径是空壳候选；其余平台、其余路径一律不是。 */
export function isMacOsCommandLineToolsShim(
  executable: string | null | undefined,
  platform: string = process.platform,
): boolean {
  if (!executable || !platformCapabilitiesFor(platform).isMac) return false
  return commandLineToolsShims.has(path.posix.normalize(executable))
}

/**
 * `xcode-select -p` 打印当前开发者目录。只认一行绝对路径；空输出、相对路径、
 * 多行杂讯都当作「没选」，宁可把 git 标成未安装，也不去碰那层壳。
 */
export function parseXcodeSelectDeveloperDirectory(stdout: string): string | null {
  const line = stdout.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean)
  if (!line || !path.posix.isAbsolute(line)) return null
  return path.posix.normalize(line)
}

/**
 * 空壳转发的目标是「开发者目录/usr/bin/同名命令」。只看 xcode-select 的退出码不够：
 * 手动删掉 /Library/Developer/CommandLineTools 之后它仍可能打印那条旧路径，
 * 而那时一跑空壳照样弹窗。
 */
export function commandLineToolsTargetFor(developerDirectory: string, shim: string): string {
  return path.posix.join(developerDirectory, 'usr', 'bin', path.posix.basename(shim))
}

function isRegularFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

export interface CommandLineToolsProbeOptions {
  runCommand?: typeof runCommand
  env?: NodeJS.ProcessEnv
  isFile?: (candidate: string) => boolean
  signal?: AbortSignal
}

/**
 * - `usable`：背后那份在，试跑也成功，可以照常用。
 * - `missing`：背后那份不在（没装命令行开发者工具，或者跑不通且原因不明）。
 * - `license-pending`：装了 Xcode 但还没同意它的许可协议。此时空壳不弹窗，
 *   而是只在 stderr 打一句「You have not agreed to the Xcode license agreements…」
 *   然后以非零退出。以前我们只看背后那份在不在，结果把这句英文当成版本号上了首页。
 */
export type CommandLineToolsShimState = 'usable' | 'missing' | 'license-pending'

/**
 * xcrun 在许可协议没同意时打印的那句话。它只有英文版，也不随系统语言变；
 * 只认这两个固定片段，别的失败一律按 missing 处理。
 */
export function isXcodeLicenseNotAgreedOutput(output: string): boolean {
  return /xcode license|xcodebuild -license/i.test(output)
}

function commandOutputOf(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const candidate = error as { stdout?: unknown; stderr?: unknown; message?: unknown }
  return [candidate.stdout, candidate.stderr, candidate.message]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
}

/**
 * 空壳背后那份真的在，还要试跑一次 `--version` 才算能用。任何一步拿不准（xcode-select
 * 跑失败、超时、打印的目录下没有同名命令、试跑失败）都不回 usable：误判成「未安装」的
 * 代价是检查页多一句怎么装，误判成「已安装」的代价是一个系统弹窗或一段英文报错。
 * 试跑排在确认背后那份存在之后，所以不会把「安装命令行开发者工具」的对话框招出来。
 */
export async function inspectCommandLineToolsShim(
  shim: string,
  options: CommandLineToolsProbeOptions = {},
): Promise<CommandLineToolsShimState> {
  const execute = options.runCommand ?? runCommand
  try {
    const result = await execute({ executable: xcodeSelectExecutable, argv: ['-p'] }, {
      env: commandEnvironment(options.env),
      timeoutMs: 4_000,
      maxOutputBytes: 16 * 1024,
      signal: options.signal,
    })
    const developerDirectory = parseXcodeSelectDeveloperDirectory(result.stdout)
    if (!developerDirectory) return 'missing'
    if (!(options.isFile ?? isRegularFile)(commandLineToolsTargetFor(developerDirectory, shim))) return 'missing'
  } catch {
    return 'missing'
  }
  try {
    await execute({ executable: shim, argv: ['--version'] }, {
      env: commandEnvironment(options.env),
      timeoutMs: 8_000,
      maxOutputBytes: 64 * 1024,
      signal: options.signal,
    })
    return 'usable'
  } catch (error) {
    return isXcodeLicenseNotAgreedOutput(commandOutputOf(error)) ? 'license-pending' : 'missing'
  }
}

export async function isCommandLineToolsShimBacked(
  shim: string,
  options: CommandLineToolsProbeOptions = {},
): Promise<boolean> {
  return await inspectCommandLineToolsShim(shim, options) === 'usable'
}

/**
 * 检查页那一行的原因句，句末不带标点（同 git-runtime.ts 的口径）。「空壳」是
 * 说给客户听的：他在访达里能看见 /usr/bin/git，却被告知没装，得说清为什么。
 */
export function commandLineToolsShimNotice(command: 'git' | 'python3'): string {
  return `macOS 自带的 ${command} 只是个空壳，要先装「命令行开发者工具」才能用：在「终端」里运行 xcode-select --install，或者用 Homebrew 另装一份`
}

/**
 * 许可协议没同意时的原因句，句末不带标点。客户能自己做的只有两件：打开一次 Xcode
 * 在弹出的协议上点「同意」，或者另装一份。不叫客户开终端跑 sudo。
 */
export function xcodeLicensePendingNotice(command: 'git' | 'python3'): string {
  const name = command === 'git' ? 'Git' : 'Python'
  return `这台 Mac 上的 Xcode 还没同意许可协议，系统自带的 ${name} 暂时用不了：打开一次 Xcode，在弹出的协议上点「同意」，或者另装一份 ${name}`
}
