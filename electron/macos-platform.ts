import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cliExitHintLines, macosFolderAccessHintLines } from './cli-exit-hint'
import { managedNodeRuntimeBinDirectory, managedNpmBinDirectory } from './managed-cli-paths'
import type { CommandSpec, RunCommandOptions } from './command-runner'
import type { StaleProxyVariableName } from './stale-proxy-environment'
import {
  captureLauncherIdentity,
  cleanupStaleTerminalDirectoriesOnce,
  quotePosixArgument,
  removeLauncherIfUnchanged,
  terminalDirectoryPrefix,
  writeLauncherAtomically,
  type LauncherIdentity,
} from './terminal-launcher-files'

// 启动脚本的文件部分挪到了 terminal-launcher-files.ts，与 Linux 共用；这两个仍从这里导出。
export { cleanupStaleTerminalDirectories, quotePosixArgument } from './terminal-launcher-files'

export interface MacosTerminalScriptPlan {
  executable: string
  argv: readonly string[]
  workspace: string
  launcherPath: string
  env: NodeJS.ProcessEnv
}

export interface MacosTerminalLaunchPlan extends Omit<MacosTerminalScriptPlan, 'launcherPath'> {}

type MacosCommandRunner = (
  spec: CommandSpec,
  options: RunCommandOptions,
) => Promise<unknown>

export type MacosTerminalCleanupScheduler = (
  cleanup: () => Promise<void>,
  delayMs: number,
) => void

const terminalLauncherCleanupDelayMs = 5 * 60_000
const persistedTerminalEnvironmentKeys = new Set([
  'HOME',
  'PATH',
  'CODEX_HOME',
  'GEMINI_API_KEY',
  'GOOGLE_GEMINI_BASE_URL',
  'GEMINI_MODEL',
  // 让 Claude Code / Gemini CLI 也认公司或安全软件装进钥匙串的证书（system-certificate-trust.ts）。
  'NODE_USE_SYSTEM_CA',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_COLLATE',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_MONETARY',
  'LC_NUMERIC',
  'LC_TIME',
  'TERM',
  'COLORTERM',
  'FORCE_COLOR',
  'NO_COLOR',
  'NODE_DISABLE_COLORS',
  'CLICOLOR',
  'CLICOLOR_FORCE',
])

function isAbsolutePath(value: string): boolean {
  return Boolean(value) && !value.includes('\0') && path.isAbsolute(value)
}

function scheduleLauncherCleanup(
  cleanup: () => Promise<void>,
  delayMs: number,
): void {
  const timer = setTimeout(() => {
    void cleanup().catch(() => undefined)
  }, delayMs)
  timer.unref()
}

/**
 * Returns fixed macOS discovery locations without consulting shell startup files.
 *
 * The system directories come before any writable one. Every command this app
 * resolves that macOS actually ships — git and python3 — is then taken from the
 * SIP-protected copy rather than from whatever a user-scoped directory happens to
 * offer under that name. Nothing else regresses: node, npm, npx and the four CLIs
 * do not exist under /usr/bin at all, so they still fall through to the locations
 * they are installed in.
 *
 * `additionalPaths` stays first because callers pass an exact directory they already
 * resolved, which is a stronger statement than any of the guesses below it.
 *
 * This is ordering only. Whether a resolved file may then be executed is a separate
 * decision, made in darwin-path-trust.ts.
 */
export function darwinCommandPathCandidates(
  baseEnv: NodeJS.ProcessEnv = process.env,
  additionalPaths: readonly string[] = [],
  homeDirectory = baseEnv.HOME?.trim() || os.homedir(),
): string[] {
  const inheritedPath = baseEnv.PATH ?? baseEnv.Path ?? baseEnv.path ?? ''
  return [
    ...additionalPaths,
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    managedNpmBinDirectory({ ...baseEnv, HOME: homeDirectory }, 'darwin'),
    path.join(homeDirectory, '.grok', 'bin'),
    path.join(homeDirectory, '.local', 'bin'),
    path.join(homeDirectory, '.volta', 'bin'),
    path.join(homeDirectory, '.cargo', 'bin'),
    path.join(homeDirectory, '.npm-global', 'bin'),
    path.join(homeDirectory, 'Library', 'pnpm'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...inheritedPath.split(path.delimiter),
    // 本软件代下的 Node.js 排在最后：客户自己装过（Homebrew、官网安装包、nvm）
    // 的那份先被找到，这一份只在他什么都没有时才顶上（第十六批 2）。他那份太旧时，
    // 本软件自己干活另把这一份经 additionalPaths 排到最前（第三十四批 A，
    // macos-node-runtime.ts 的 resolveDarwinPreferredNodeDirectory），交给工具的终端仍是这个顺序。
    managedNodeRuntimeBinDirectory({ ...baseEnv, HOME: homeDirectory }, 'darwin'),
  ]
}

// 键和 stale-proxy-environment.ts 的 staleProxyVariableNames 一一对应：那边加减一个名字，这里不跟着改就编译不过。
const shellProxyVariables: Record<StaleProxyVariableName, true> = {
  HTTP_PROXY: true,
  HTTPS_PROXY: true,
  ALL_PROXY: true,
}

// 认的写法和 parseLoopbackProxyTarget 一样：可带协议、用户名密码和后面的路径，主机只认
// localhost、127.x.x.x、[::1]，端口必须写出来。拿转成小写的值来比。那边的 URL 解析还会把
// 127.1、[0:0:0:0:0:0:0:1] 这类简写还原成本机地址，这里不认，照旧带上。
const loopbackProxyPattern = '^[[:space:]]*([a-z][a-z0-9+.-]*://)?([^/?#]*@)?'
  + '(localhost|127\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}|\\[::1])'
  + ':0*([0-9]{1,5})([/?#].*)?[[:space:]]*$'

/**
 * 「终端」开新窗口时先起客户自己的登录 shell，读过 ~/.zprofile、~/.zshrc 才跑这份启动脚本，
 * 那里 export 的代理会一路带给工具；本软件是从访达、程序坞打开的，自己的环境里看不到它们。
 * 照教程写进 ~/.zshrc 的 `export https_proxy=http://127.0.0.1:7890` 还在、代理软件却没开时，
 * 从这里打开的工具就全连不上（第三十四批 B）。
 *
 * 所以在脚本里现判，规则照 Windows、Linux 那边（stale-proxy-environment.ts，第十六批 5）：
 * 只看这三个名字，只管指向本机、写了端口的，连不上的这一次 unset；连得上的、指向别的机器的、
 * 写法认不出的一律不动。客户的 ~/.zshrc 一个字不改，他自己开的终端照旧。
 *
 * 和那边不同的地方：大写小写各算一个变量、各判各的，macOS 上它们本来就是两个变量，去掉没开的
 * 那个，开着的那个照旧给工具用。探测用系统自带的 nc，最多等 1 秒（-G 以秒为单位；127.0.0.1、::1
 * 上的端口不是当场连上就是当场被拒，用不了这么久）。
 *
 * 探不了的时候宁可不动：nc 不在、正则模块载不进来时整段跳过；nc 连不上时本来一声不吭，它要是
 * 自己报了错（不认这几个参数、认不出地址），说明是探测本身出了问题，这个目标这次照旧带上。中途
 * 出任何错都只当没探，所以在函数里关掉 errexit、允许取没设的变量，返回时 zsh 自己把选项换回来；
 * 整段的错误输出也丢掉，不往客户的终端里打英文。
 */
export function buildMacosClosedProxyGuard(probeExecutable = '/usr/bin/nc'): string[] {
  const names = Object.keys(shellProxyVariables).flatMap((name) => [name, name.toLowerCase()])
  const probe = quotePosixArgument(probeExecutable)
  return [
    '() {',
    '  setopt localoptions noerrexit unset',
    `  [[ -x ${probe} ]] && zmodload zsh/regex 2>/dev/null || return 0`,
    '  local name value host port target address failure MATCH MBEGIN MEND',
    '  local -a match mbegin mend addresses',
    '  local -A reach',
    `  local pattern=${quotePosixArgument(loopbackProxyPattern)}`,
    `  for name in ${names.join(' ')}; do`,
    '    value=${(P)name}',
    '    [[ ${#value} -le 2048 && ${(L)value} =~ $pattern ]] || continue',
    '    host=${match[3]} port=$(( 10#${match[4]} ))',
    '    (( port >= 1 && port <= 65535 )) || continue',
    '    target=$host:$port',
    '    if [[ -z ${reach[$target]} ]]; then',
    // localhost 两个地址都试，一个连得上就算开着：代理多半只听 127.0.0.1（同 probeLoopbackProxy）。
    '      case $host in',
    '        localhost) addresses=(127.0.0.1 ::1) ;;',
    "        '[::1]') addresses=(::1) ;;",
    '        *) addresses=($host) ;;',
    '      esac',
    '      reach[$target]=closed',
    '      for address in $addresses; do',
    // 只留 nc 的错误输出：连不上时它不出声，出了声就是探测本身的问题。
    `        if failure=$(${probe} -z -n -G 1 $address $port 2>&1 </dev/null >/dev/null); then`,
    '          reach[$target]=open',
    '          break',
    '        fi',
    '        [[ -n $failure ]] && reach[$target]=unknown',
    '      done',
    '    fi',
    '    [[ ${reach[$target]} == closed ]] && unset $name',
    '  done',
    '  return 0',
    '} 2>/dev/null',
  ]
}

/** Builds the short-lived zsh launcher that Terminal executes. */
export function buildMacosTerminalScript(plan: MacosTerminalScriptPlan): string {
  if (!isAbsolutePath(plan.executable)) throw new TypeError('executable must be an absolute path')
  if (!isAbsolutePath(plan.workspace)) throw new TypeError('workspace must be an absolute path')
  if (!isAbsolutePath(plan.launcherPath)) throw new TypeError('launcher path must be an absolute path')
  if (plan.argv.some((argument) => argument.includes('\0'))) {
    throw new TypeError('argv must not contain NUL bytes')
  }
  const environmentEntries = Object.entries(plan.env)
  for (const [key, value] of environmentEntries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new TypeError(`invalid environment key: ${key}`)
    }
    if (value?.includes('\0')) throw new TypeError(`environment value for ${key} must not contain NUL bytes`)
  }
  for (const requiredKey of ['HOME', 'PATH'] as const) {
    if (!plan.env[requiredKey]?.trim()) {
      throw new TypeError(`environment ${requiredKey} is required`)
    }
  }
  const shellMaintainedEnvironmentKeys = new Set(['PWD', 'OLDPWD', 'SHLVL', '_'])
  const environmentExports = environmentEntries
    .filter((entry): entry is [string, string] => (
      entry[1] !== undefined
      && persistedTerminalEnvironmentKeys.has(entry[0])
      && !shellMaintainedEnvironmentKeys.has(entry[0])
    ))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `export ${key}=${quotePosixArgument(value)}`)

  return [
    '#!/bin/zsh -f',
    'set -eu',
    `rm -f -- ${quotePosixArgument(plan.launcherPath)}`,
    `rmdir -- ${quotePosixArgument(path.dirname(plan.launcherPath))} 2>/dev/null || true`,
    // cd 失败时 set -e 只会留下一句英文就结束；受保护文件夹通常能进、读不出，所以进去后
    // 再用 ls 试读一次，读不到就说清楚去哪开权限，不启动工具（启动了也什么都看不到）。
    // ls 写绝对路径：这时 PATH 还没导出。只输出固定文案，不引入外部输入。
    `if ! cd -- ${quotePosixArgument(plan.workspace)} 2>/dev/null; then`,
    ...macosFolderAccessHintLines.unreachable.map((line) => `  print -r -- ${quotePosixArgument(line)}`),
    '  exit 1',
    'fi',
    'if ! /bin/ls -A -- . >/dev/null 2>&1; then',
    ...macosFolderAccessHintLines.unreadable.map((line) => `  print -r -- ${quotePosixArgument(line)}`),
    '  exit 1',
    'fi',
    ...environmentExports,
    // ~/.zshrc 里留着、却已经没开的本机代理，这一次不带给工具（第三十四批 B）。
    ...buildMacosClosedProxyGuard(),
    // 不再 exec：工具退出后还要留在这个脚本里补一句中文，告诉用户下一步。
    // set -e 下工具非零退出会直接结束脚本，所以用 || 接住退出码。trap 让 zsh
    // 在用户按 Ctrl+C 时不跟着工具一起被打断；它是 shell 函数处理器不是忽略，
    // 子进程照旧收到默认的 SIGINT 行为。只输出固定文案，不引入外部输入。
    "trap ':' INT",
    'cli_exit_code=0',
    `${[plan.executable, ...plan.argv].map(quotePosixArgument).join(' ')} || cli_exit_code=$?`,
    'print -r --',
    'if [ "$cli_exit_code" -eq 0 ]; then',
    ...cliExitHintLines.normal.map((line) => `  print -r -- ${quotePosixArgument(line)}`),
    'else',
    ...cliExitHintLines.unexpected.map((line) => `  print -r -- ${quotePosixArgument(line)}`),
    'fi',
    '',
  ].join('\n')
}

async function defaultCommandRunner(spec: CommandSpec, options: RunCommandOptions): Promise<unknown> {
  const { runCommand } = await import('./command-runner')
  return runCommand(spec, options)
}

/** Creates an app-owned launcher and opens it in Terminal through runCommand. */
export async function launchMacosTerminal(
  plan: MacosTerminalLaunchPlan,
  commandRunner: MacosCommandRunner = defaultCommandRunner,
  scheduleCleanup: MacosTerminalCleanupScheduler = scheduleLauncherCleanup,
): Promise<void> {
  if (!isAbsolutePath(plan.executable)) throw new TypeError('executable must be an absolute path')
  if (!isAbsolutePath(plan.workspace)) throw new TypeError('workspace must be an absolute path')

  const baseDirectory = os.tmpdir()
  await cleanupStaleTerminalDirectoriesOnce(baseDirectory)
  // The pid is part of the name so the collector above can tell a directory whose
  // owner is gone from one still waiting out its cleanup delay.
  const directory = await fs.promises.mkdtemp(path.join(baseDirectory, terminalDirectoryPrefix()))
  const launcherPath = path.join(directory, 'launch.zsh')
  let launcherIdentity: LauncherIdentity | null = null
  try {
    await fs.promises.chmod(directory, 0o700)
    await writeLauncherAtomically(launcherPath, buildMacosTerminalScript({ ...plan, launcherPath }))
    launcherIdentity = await captureLauncherIdentity(directory, launcherPath)
    await commandRunner({
      executable: '/usr/bin/open',
      argv: ['-a', 'Terminal', launcherPath],
    }, {
      cwd: plan.workspace,
    })
    const cleanupIdentity = launcherIdentity
    scheduleCleanup(
      () => removeLauncherIfUnchanged(directory, launcherPath, cleanupIdentity),
      terminalLauncherCleanupDelayMs,
    )
  } catch (error) {
    if (launcherIdentity) {
      await removeLauncherIfUnchanged(directory, launcherPath, launcherIdentity)
    } else {
      // Recursive removal is confined to the directory this call just created with
      // mkdtemp, and is only reached before the launcher has an identity — so there
      // is nothing here worth preserving. A plain rmdir would fail on any partial
      // file left behind and leak the tree.
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
    throw error
  }
}
