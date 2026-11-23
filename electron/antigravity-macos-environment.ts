import os from 'node:os'
import path from 'node:path'
import {
  antigravityGatewayVariableNames,
  assertCompleteAntigravityEnvironment,
  type AntigravityEnvironmentValues,
  type AntigravityEnvironmentWriteOutcome,
  type AntigravityGatewayEnvironment,
} from './antigravity-gateway'
import {
  defaultLoginShell,
  fishConfigDirectory,
  loginFileExists,
  pathExists,
  planMacosShellProfileTarget,
  resolveMacosLoginShell,
  type MacosShellProfileTarget,
} from './macos-shell-profile'
import { managedProductRoot } from './managed-cli-paths'
import {
  appendSafeUtf8File,
  ensureSafeDataDirectory,
  readSafeUtf8File,
  writeAtomicSafeUtf8File,
} from './safe-local-data'
import { quotePosixArgument } from './terminal-launcher-files'

// Mac 上「写进用户环境变量」的对应（yoyo 11-23 选的写法）：新开的终端读的是登录 shell 的启动文件。
// 四个值放在产品目录里一个只有本人能读的文件（0600），启动文件末尾只加一段标记，读那个文件：
// 密钥不进 ~/.zprofile，那个文件常被客户放进 dotfiles 仓库同步出去。fish 不认 sh 的写法，另有一份。
//
// 从程序坞、启动台打开的 Antigravity 桌面端不读这些文件，星芒自己打开它时由打开的那一步把设置交给它。
// 本进程的环境不跟着改，理由同 antigravity-windows-environment.ts。

const settingsDirectoryName = 'Antigravity'
const posixSettingsFileName = 'gateway.sh'
const fishSettingsFileName = 'gateway.fish'
// 自己写的四行，再大就不是我们写的了。
const maximumSettingsBytes = 16 * 1024
// 手写的 .zprofile / .bash_profile 不会有几百 KB；再大就不是我们该去碰的文件了（同 macos-shell-profile.ts）。
const maximumProfileBytes = 512 * 1024

// 和「终端里能直接敲 claude」那一段分开标：两段各管各的，客户删了哪段都不影响另一段。
export const antigravityShellProfileMarker = '# >>> xingmang-ai-manager antigravity >>>'
const antigravityShellProfileEndMarker = '# <<< xingmang-ai-manager antigravity <<<'
const fishProfileFileName = 'xingmang-ai-manager-antigravity.fish'

// 写成 $HOME 开头，客服念给客户听时看得懂；同 macos-shell-profile.ts 的终端命令目录。
const settingsDirectoryWords = `$HOME/Library/Application Support/XingMangAI/${settingsDirectoryName}`

const settingsFileHeader = '# 星芒AI管理工具写的 Antigravity 中转设置，每次在星芒里保存都会整份换掉，请不要手改。'

// agy 官方装法放的位置（第十一轮实测：tar.gz 里那一个文件装成 ~/.local/bin/agy）。它自更新时只认这个位置，
// 所以星芒装到同一处；但不跑 `agy install`：那一步把目录加到 PATH 最前面，还会动配置文件里的 alias。
// 这里加在最后，客户自己排在前面的目录照旧优先。
const agyDirectoryWords = '$HOME/.local/bin'

export type AntigravityShellProfileOutcome = 'added' | 'present' | 'unsupported-shell'

export interface MacosAntigravityEnvironmentResult {
  outcome: AntigravityEnvironmentWriteOutcome
  /** 登录 shell 的启动文件里那一段：这次加上的、本来就在的，或者账号用的 shell 不归这里管。 */
  profile: AntigravityShellProfileOutcome
}

/** fish 单引号里只有反斜杠和单引号要转义。 */
function quoteFishString(value: string): string {
  if (value.includes('\0')) throw new TypeError('fish string must not contain NUL bytes')
  return `'${value.replace(/[\\']/g, '\\$&')}'`
}

/** sh、bash、zsh 都认的那一份：每行一个 `export 名字='值'`。 */
export function buildAntigravityPosixSettingsFile(environment: AntigravityGatewayEnvironment): string {
  assertCompleteAntigravityEnvironment(environment)
  return [
    settingsFileHeader,
    ...antigravityGatewayVariableNames.map((name) => `export ${name}=${quotePosixArgument(environment[name])}`),
    '',
  ].join('\n')
}

/** fish 那一份：`set -gx 名字 '值'`。 */
export function buildAntigravityFishSettingsFile(environment: AntigravityGatewayEnvironment): string {
  assertCompleteAntigravityEnvironment(environment)
  return [
    settingsFileHeader,
    ...antigravityGatewayVariableNames.map((name) => `set -gx ${name} ${quoteFishString(environment[name])}`),
    '',
  ].join('\n')
}

/**
 * The lines appended to ~/.zprofile, or to the file a bash login shell reads.
 * They put agy's folder at the end of PATH (the `case` guard keeps a nested
 * login shell, or a PATH that already has it, from listing it twice) and read
 * the settings file, so the key never lands in a file the user may sync
 * elsewhere, and a removed settings file leaves nothing behind but a check
 * that quietly fails.
 */
export function buildAntigravityShellProfileBlock(): string {
  const file = `${settingsDirectoryWords}/${posixSettingsFileName}`
  return [
    antigravityShellProfileMarker,
    '# 星芒AI管理工具加的：让新开的终端能直接敲 agy，并用星芒设好的中转。不想要可以连同上下两行标记一起删掉。',
    'case ":$PATH:" in',
    `  *":${agyDirectoryWords}:"*) ;;`,
    `  *) export PATH="$PATH:${agyDirectoryWords}" ;;`,
    'esac',
    `if [ -r "${file}" ]; then`,
    `  . "${file}"`,
    'fi',
    antigravityShellProfileEndMarker,
    '',
  ].join('\n')
}

/** The same for fish, in a conf.d file of its own (fish reads every file there). */
export function buildAntigravityFishProfile(): string {
  const file = `${settingsDirectoryWords}/${fishSettingsFileName}`
  return [
    antigravityShellProfileMarker,
    '# 星芒AI管理工具加的：让新开的终端能直接敲 agy，并用星芒设好的中转。不想要可以删掉这个文件。',
    `if not contains -- "${agyDirectoryWords}" $PATH`,
    `    set -gx PATH $PATH "${agyDirectoryWords}"`,
    'end',
    `if test -r "${file}"`,
    `    source "${file}"`,
    'end',
    antigravityShellProfileEndMarker,
    '',
  ].join('\n')
}

/** What to append to `current` so it ends with the block; empty when the block is already there. */
export function planAntigravityShellProfileAppend(current: string | null): string {
  if (current?.includes(antigravityShellProfileMarker)) return ''
  const block = buildAntigravityShellProfileBlock()
  if (!current) return block
  // 客户文件最后一行没换行时，直接接上会把我们的第一行粘进他那一行里。
  return `${current.endsWith('\n') ? '\n' : '\n\n'}${block}`
}

/**
 * Reads back what the sh settings file holds. Only lines shaped exactly as
 * buildAntigravityPosixSettingsFile writes them count; anything else in the
 * file is ignored rather than evaluated.
 */
export function parseAntigravityPosixSettingsFile(content: string): AntigravityEnvironmentValues {
  const values: AntigravityEnvironmentValues = {}
  for (const line of content.split(/\r?\n/)) {
    const match = /^export ([A-Z_]+)='([^']*)'$/.exec(line)
    if (!match) continue
    const name = antigravityGatewayVariableNames.find((candidate) => candidate === match[1])
    if (name) values[name] = match[2]
  }
  return values
}

export interface MacosAntigravityEnvironmentOptions {
  platform?: NodeJS.Platform
  homeDirectory?: string
  /** The user's login shell; defaults to the account record, not $SHELL, which a launcher may override. */
  loginShell?: string | null
  /** XDG_CONFIG_HOME is read from here, for fish. */
  env?: NodeJS.ProcessEnv
  /**
   * The fish file a zsh or bash account also gets when its fish config folder exists could not be
   * written: `fish/conf.d/…` for the log, and why. That file is a courtesy, so its failure is reported
   * here instead of failing the call, as in macos-shell-profile.ts.
   */
  skipped?: (displayPath: string, error: unknown) => void
}

function assertMacos(platform: NodeJS.Platform): void {
  if (platform !== 'darwin') throw new Error('只有 macOS 上把 Antigravity 的设置写进终端的启动设置')
}

function resolveHomeDirectory(options: MacosAntigravityEnvironmentOptions): string {
  const homeDirectory = options.homeDirectory ?? os.homedir()
  if (!homeDirectory || !path.posix.isAbsolute(homeDirectory) || homeDirectory.includes('\0')) {
    throw new Error('未找到有效的 macOS 用户目录')
  }
  return homeDirectory
}

function settingsDirectory(homeDirectory: string): string {
  return path.posix.join(managedProductRoot({ HOME: homeDirectory }, 'darwin'), settingsDirectoryName)
}

/** Replaces one settings file when its content differs; true when it did. Always 0600: the key is in it. */
async function replaceSettingsFile(filePath: string, content: string, label: string): Promise<boolean> {
  const current = await readSafeUtf8File(filePath, label, maximumSettingsBytes)
  if (current === content) return false
  await writeAtomicSafeUtf8File(filePath, content, label, { mode: 0o600 })
  return true
}

async function appendShellProfileBlock(target: MacosShellProfileTarget, label: string): Promise<boolean> {
  const current = await readSafeUtf8File(target.filePath, label, maximumProfileBytes)
  const addition = planAntigravityShellProfileAppend(current)
  if (!addition) return false
  await appendSafeUtf8File(target.filePath, addition, label)
  return true
}

async function writeFishProfile(target: MacosShellProfileTarget, label: string): Promise<boolean> {
  const current = await readSafeUtf8File(target.filePath, label, maximumProfileBytes)
  if (current?.includes(antigravityShellProfileMarker)) return false
  if (current !== null) throw new Error(`${label}已被别的内容占用`)
  ensureSafeDataDirectory(path.posix.dirname(target.filePath), label)
  await writeAtomicSafeUtf8File(target.filePath, buildAntigravityFishProfile(), label, { mode: 0o644 })
  return true
}

function fishProfileTarget(fishDirectory: string): MacosShellProfileTarget {
  return {
    kind: 'fish',
    filePath: path.posix.join(fishDirectory, 'conf.d', fishProfileFileName),
    displayPath: `fish/conf.d/${fishProfileFileName}`,
  }
}

async function ensureAntigravityShellProfile(
  homeDirectory: string,
  options: MacosAntigravityEnvironmentOptions,
): Promise<AntigravityShellProfileOutcome> {
  const shell = resolveMacosLoginShell(options.loginShell === undefined ? defaultLoginShell() : options.loginShell)
  if (!shell) return 'unsupported-shell'
  const fishDirectory = fishConfigDirectory(options.env ?? process.env, homeDirectory)
  const target = shell === 'fish'
    ? fishProfileTarget(fishDirectory)
    : planMacosShellProfileTarget({ shell, homeDirectory, fishConfigDirectory: fishDirectory, exists: loginFileExists })
  // bash 可能落在三个文件里的任何一个，出错时日志得说清是哪一个。
  const label = `终端启动设置（${target.displayPath}）`
  const added = target.kind === 'fish'
    ? await writeFishProfile(target, label)
    : await appendShellProfileBlock(target, label)
  // 登录 shell 是 zsh、bash 但 fish 的设置文件夹在：他也用 fish，顺带给一份，写不进去只报给 skipped
  // （同 macos-shell-profile.ts 的 ensureMacosShellProfile）。
  let fishAdded = false
  if (target.kind !== 'fish' && pathExists(fishDirectory)) {
    const fishTarget = fishProfileTarget(fishDirectory)
    try {
      fishAdded = await writeFishProfile(fishTarget, `终端启动设置（${fishTarget.displayPath}）`)
    } catch (error) {
      options.skipped?.(fishTarget.displayPath, error)
    }
  }
  return added || fishAdded ? 'added' : 'present'
}

/**
 * Writes the gateway settings for terminals the user opens on their own. The
 * environment must be the whole of buildAntigravityGatewayEnvironment's
 * answer; anything less writes nothing. Both settings files are replaced only
 * when their content differs, and the login shell's startup file only ever
 * gets the block appended (never rewritten), so whatever the user wrote there,
 * their own AGY_* variables included, stays as it is. Every file goes through
 * safe-local-data (I8): a dotfiles-managed startup file that is a symlink is
 * refused, not followed. Answers only words, never values, for the log.
 */
export async function writeMacosAntigravityEnvironment(
  environment: AntigravityGatewayEnvironment,
  options: MacosAntigravityEnvironmentOptions = {},
): Promise<MacosAntigravityEnvironmentResult> {
  assertMacos(options.platform ?? process.platform)
  const posixContent = buildAntigravityPosixSettingsFile(environment)
  const fishContent = buildAntigravityFishSettingsFile(environment)
  const homeDirectory = resolveHomeDirectory(options)
  const directory = settingsDirectory(homeDirectory)
  const label = 'Antigravity 的设置'
  ensureSafeDataDirectory(directory, label)
  // 先写设置文件再加启动文件那一段：中途失败时留下的只是没人读的设置文件，不会有一段读不到文件的标记。
  const posixChanged = await replaceSettingsFile(path.posix.join(directory, posixSettingsFileName), posixContent, label)
  const fishChanged = await replaceSettingsFile(path.posix.join(directory, fishSettingsFileName), fishContent, label)
  const profile = await ensureAntigravityShellProfile(homeDirectory, options)
  return {
    outcome: posixChanged || fishChanged || profile === 'added' ? 'written' : 'unchanged',
    profile,
  }
}

/** What the sh settings file now holds; nothing when the app has not written it. The values carry the key (I3). */
export async function readMacosAntigravityEnvironment(
  options: Pick<MacosAntigravityEnvironmentOptions, 'platform' | 'homeDirectory'> = {},
): Promise<AntigravityEnvironmentValues> {
  assertMacos(options.platform ?? process.platform)
  const directory = settingsDirectory(resolveHomeDirectory(options))
  const content = await readSafeUtf8File(path.posix.join(directory, posixSettingsFileName), 'Antigravity 的设置', maximumSettingsBytes)
  return content === null ? {} : parseAntigravityPosixSettingsFile(content)
}
