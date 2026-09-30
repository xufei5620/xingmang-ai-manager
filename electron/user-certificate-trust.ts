/**
 * 检查页「安全证书」一项查出这台电脑装了公司或安全软件的证书（systemTrusted）时，
 * 星芒自己起的工具已经带着「也信任这台电脑的证书库」（system-certificate-trust.ts）。
 * 客户自己开的终端、VS Code 里敲 `gemini` 拿不到这一条，每次请求都是证书错误
 * （第十八批 7）。Claude Code 是独立程序自己认系统证书库，Codex、Grok 本来就走系统库，
 * 只剩 Gemini 这一家 Node 程序。
 *
 * 这里把同一个开关写进当前 Windows 账号的环境变量（HKCU\Environment），客户点了确认
 * 才写；只写这一个键，已经有（包括客户自己设的 0）就不动。不做收回：它只是让 Node
 * 程序多信一份这台电脑本来就信的证书，收回反而让别的 Node 程序又坏。
 *
 * macOS 没有一处「以后新开的终端都读得到」又不改 shell 配置文件的地方，不做。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { trustedCommandEnvironment } from './command-runner'
import { systemCertificateTrustVariable } from './system-certificate-trust'
import { resolveWindowsPowerShellExecutable } from './windows-elevation'

const execFileAsync = promisify(execFile)

/**
 * - available：可以写，检查页给「让这台电脑上所有终端都信任」；
 * - applied：这个账号已经是 1（星芒写的或客户自己设的），不用再点；
 * - userSet：这个账号设成了别的值，那是客户的选择，星芒不碰；
 * - unsupported：不是 Windows，或以管理员身份打开（那时 HKCU 里的值该由普通权限的
 *   客户自己决定，提权进程不替他写）。
 */
export type UserWideCertificateTrustState = 'available' | 'applied' | 'userSet' | 'unsupported'
export type UserWideCertificateTrustResult = 'applied' | 'userSet'

export type PowerShellRunner = (script: string, env: NodeJS.ProcessEnv) => Promise<string>

async function runPowerShell(script: string, env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync(resolveWindowsPowerShellExecutable(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    env,
    windowsHide: true,
    // Same budget as the user PATH step: a cold PowerShell on a slow disk with
    // Defender scanning takes well over ten seconds.
    timeout: 60_000,
    maxBuffer: 64 * 1024,
  })
  return stdout
}

/**
 * The variable name is fixed in the script and nothing from the renderer or
 * the environment reaches it. `SetEnvironmentVariable(..., "User")` writes
 * HKCU\Environment and broadcasts WM_SETTINGCHANGE, so terminals opened from
 * now on see it without signing out. Any existing value, including an explicit
 * `0`, is the user's choice and is left alone; the last line reports which.
 */
export function buildSetUserCertificateTrustScript(): string {
  return [
    '$ErrorActionPreference = "Stop"',
    `$current = [Environment]::GetEnvironmentVariable("${systemCertificateTrustVariable}", "User")`,
    'if ($null -ne $current) { if ($current.Trim() -eq "1") { "present-on" } else { "present-other" }; return }',
    `[Environment]::SetEnvironmentVariable("${systemCertificateTrustVariable}", "1", "User")`,
    '"set"',
  ].join('\n')
}

export function parseSetUserCertificateTrustOutput(stdout: string): UserWideCertificateTrustResult {
  const last = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)
  if (last === 'set' || last === 'present-on') return 'applied'
  if (last === 'present-other') return 'userSet'
  throw new Error('没能确认这项设置有没有加上')
}

function findVariable(env: NodeJS.ProcessEnv): string | undefined {
  const key = systemCertificateTrustVariable.toLowerCase()
  const name = Object.keys(env).find((entry) => entry.toLowerCase() === key)
  return name === undefined ? undefined : env[name] ?? ''
}

export interface UserWideCertificateTrustOptions {
  platform?: NodeJS.Platform
  executionMode: 'trusted-only' | 'same-user'
  /** 本进程的环境：检查时读它，写成功后同步它；缺省 = process.env。 */
  env?: NodeJS.ProcessEnv
  run?: PowerShellRunner
}

/**
 * 检查页每次检查时调用，不起 PowerShell：本进程启动时从资源管理器继承了这个账号的
 * 环境变量，写成功后又同步过，所以看它就够了。
 */
export function inspectUserWideCertificateTrust(options: UserWideCertificateTrustOptions): UserWideCertificateTrustState {
  if ((options.platform ?? process.platform) !== 'win32' || options.executionMode === 'trusted-only') return 'unsupported'
  const value = findVariable(options.env ?? process.env)
  if (value === undefined) return 'available'
  return value.trim() === '1' ? 'applied' : 'userSet'
}

/**
 * 「让这台电脑上所有终端都信任」。写成功后同步本进程环境，下次检查就不再给按钮；
 * 星芒自己起的工具本来就带着它（withSystemCertificateTrust），同步不改变它们的行为，
 * 提权那条路照旧由 trustedCommandEnvironment 剥掉。
 */
export async function trustCertificatesForUserTerminals(options: UserWideCertificateTrustOptions): Promise<UserWideCertificateTrustResult> {
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('只有 Windows 上能在这里设置')
  if (options.executionMode === 'trusted-only') {
    throw new Error('星芒现在是以管理员身份打开的，这时不改这项设置。请关掉星芒，直接双击正常打开后再点。')
  }
  const result = parseSetUserCertificateTrustOutput(await (options.run ?? runPowerShell)(
    buildSetUserCertificateTrustScript(),
    trustedCommandEnvironment(),
  ))
  const env = options.env ?? process.env
  if (result === 'applied' && findVariable(env) === undefined) env[systemCertificateTrustVariable] = '1'
  return result
}
