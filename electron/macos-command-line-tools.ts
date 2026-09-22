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
 * 空壳背后那份真的在，才值得去跑它的 `--version`。任何一步拿不准（xcode-select
 * 跑失败、超时、打印的目录下没有同名命令）都回 false：误判成「未安装」的代价是
 * 检查页多一句怎么装，误判成「已安装」的代价是一个系统弹窗。
 */
export async function isCommandLineToolsShimBacked(
  shim: string,
  options: CommandLineToolsProbeOptions = {},
): Promise<boolean> {
  const execute = options.runCommand ?? runCommand
  try {
    const result = await execute({ executable: xcodeSelectExecutable, argv: ['-p'] }, {
      env: commandEnvironment(options.env),
      timeoutMs: 4_000,
      maxOutputBytes: 16 * 1024,
      signal: options.signal,
    })
    const developerDirectory = parseXcodeSelectDeveloperDirectory(result.stdout)
    if (!developerDirectory) return false
    return (options.isFile ?? isRegularFile)(commandLineToolsTargetFor(developerDirectory, shim))
  } catch {
    return false
  }
}

/**
 * 检查页那一行的原因句，句末不带标点（同 git-runtime.ts 的口径）。「空壳」是
 * 说给客户听的：他在访达里能看见 /usr/bin/git，却被告知没装，得说清为什么。
 */
export function commandLineToolsShimNotice(command: 'git' | 'python3'): string {
  return `macOS 自带的 ${command} 只是个空壳，要先装「命令行开发者工具」才能用：在「终端」里运行 xcode-select --install，或者用 Homebrew 另装一份`
}
