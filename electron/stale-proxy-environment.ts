import { execFile } from 'node:child_process'
import net from 'node:net'
import { promisify } from 'node:util'
import { trustedCommandEnvironment } from './command-runner'
import { buildPowerShellModuleImportStatement } from './powershell-module-imports'
import { resolveWindowsPowerShellExecutable } from './windows-elevation'

const execFileAsync = promisify(execFile)

/**
 * 很多人照教程给 Windows 加过 `HTTPS_PROXY=http://127.0.0.1:7890` 这类设置，好让命令行
 * 也走代理；后来代理软件卸了或没开，这条设置还留着。本软件自己联网看的是系统代理，
 * 一切正常，可从这里打开的工具和 npm 都认这几个变量，于是全连不上（第十六批 5）。
 *
 * 这里只认三个名字：Claude Code / Codex / Gemini 读 HTTPS_PROXY 与 HTTP_PROXY（按各家
 * 公开说明，推测，未逐一核实），npm 的 @npmcli/agent 读 https_proxy / http_proxy，
 * ALL_PROXY 是 curl 一系的通用写法。NO_PROXY 只会让请求少走代理，不会把人卡住，不管。
 */
export const staleProxyVariableNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as const

export type StaleProxyVariableName = typeof staleProxyVariableNames[number]

/** 本机代理拒绝连接在 Windows 上要重试近两秒才报错，所以等到点就算没开。 */
export const loopbackProxyProbeTimeoutMs = 300

export interface LoopbackProxyTarget {
  host: string
  port: number
}

export type ProxyVariableReach = 'closed' | 'open' | 'remote'

export interface ProxyVariableFinding {
  /** 规范化成大写的变量名。 */
  name: StaleProxyVariableName
  /** 指向本机时才有；指向别的机器或认不出来的写法一律为 null。 */
  target: LoopbackProxyTarget | null
  reach: ProxyVariableReach
}

export type LoopbackProbe = (target: LoopbackProxyTarget) => Promise<boolean>

function canonicalName(key: string): StaleProxyVariableName | null {
  const upper = key.toUpperCase()
  return staleProxyVariableNames.find((name) => name === upper) ?? null
}

function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/, '$1').toLowerCase()
  return bare === 'localhost' || bare === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
}

/**
 * 认出「本机某个端口」这一种写法：`http://127.0.0.1:7890`、`socks5://localhost:1080`、
 * 不带协议的 `127.0.0.1:7890` 都算。没写端口、写法认不出来的返回 null——那些不去
 * 猜，照旧交给工具，行为和以前一样。
 */
export function parseLoopbackProxyTarget(value: string | undefined): LoopbackProxyTarget | null {
  const text = value?.trim()
  if (!text || text.length > 2048) return null
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`)
  } catch {
    return null
  }
  if (!url.port || !isLoopbackHost(url.hostname)) return null
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
  return { host: url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase(), port }
}

/**
 * 只有在限定时间内真的连上才算开着；拒绝、超时、任何错误都算没开。localhost 两个
 * 地址一起试：代理多半只听 127.0.0.1，而按名字解析时先试 ::1，在 Windows 上被拒要
 * 等上一阵，会把本来开着的代理拖过时限。
 */
export async function probeLoopbackProxy(
  target: LoopbackProxyTarget,
  timeoutMs = loopbackProxyProbeTimeoutMs,
): Promise<boolean> {
  const hosts = target.host === 'localhost' ? ['127.0.0.1', '::1'] : [target.host]
  const results = await Promise.all(hosts.map((host) => probeLoopbackAddress(host, target.port, timeoutMs)))
  return results.some(Boolean)
}

function probeLoopbackAddress(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let settled = false
    const finish = (open: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(open)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/**
 * 看一份环境里这三个变量各指向哪里、本机的那个开没开。同一个名字大小写写了两份
 * （非 Windows 上可能）按一条算，取第一个非空值。同一个端口只探一次。
 */
export async function inspectProxyVariables(
  env: NodeJS.ProcessEnv,
  probe: LoopbackProbe = probeLoopbackProxy,
): Promise<ProxyVariableFinding[]> {
  const values = new Map<StaleProxyVariableName, string>()
  for (const [key, value] of Object.entries(env)) {
    const name = canonicalName(key)
    if (name && value?.trim() && !values.has(name)) values.set(name, value)
  }
  const probes = new Map<string, Promise<boolean>>()
  const findings = await Promise.all(staleProxyVariableNames
    .filter((name) => values.has(name))
    .map(async (name): Promise<ProxyVariableFinding> => {
      const target = parseLoopbackProxyTarget(values.get(name))
      if (!target) return { name, target: null, reach: 'remote' }
      const key = `${target.host}:${target.port}`
      let pending = probes.get(key)
      if (!pending) {
        pending = probe(target).catch(() => false)
        probes.set(key, pending)
      }
      return { name, target, reach: await pending ? 'open' : 'closed' }
    }))
  return findings
}

/** 去掉指向没开的本机代理的那几个变量（各种大小写一起），其余原样保留。 */
export function withoutClosedProxyVariables(
  env: NodeJS.ProcessEnv,
  findings: readonly ProxyVariableFinding[],
): NodeJS.ProcessEnv {
  const closed = new Set(findings.filter((finding) => finding.reach === 'closed').map((finding) => finding.name))
  if (!closed.size) return env
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    const name = canonicalName(key)
    if (!name || !closed.has(name)) result[key] = value
  }
  return result
}

export interface ClosedProxyBypass {
  env: NodeJS.ProcessEnv
  /** 这一次没带上的变量；空数组 = 什么都没动。 */
  dropped: ProxyVariableFinding[]
}

/**
 * 打开工具、跑 npm 之前调用：本机代理确实连不上时这一次不带它，开着的、指向别的
 * 机器的照旧带上。用户的系统设置一个字不改。探测本身出错时原样返回，不挡住后面的事。
 */
export async function bypassClosedLoopbackProxies(
  env: NodeJS.ProcessEnv,
  probe: LoopbackProbe = probeLoopbackProxy,
): Promise<ClosedProxyBypass> {
  try {
    const findings = await inspectProxyVariables(env, probe)
    const dropped = findings.filter((finding) => finding.reach === 'closed')
    return { env: dropped.length ? withoutClosedProxyVariables(env, findings) : env, dropped }
  } catch {
    return { env, dropped: [] }
  }
}

/** 日志只写变量名和本机端口，不写原值：原值里可能带着代理的用户名和密码。 */
export function describeDroppedProxies(dropped: readonly ProxyVariableFinding[]): Record<string, string> {
  return {
    variables: dropped.map((finding) => finding.name).join(','),
    ports: [...new Set(dropped.map((finding) => String(finding.target?.port ?? '')))].filter(Boolean).join(','),
  }
}

export interface ProxyVariableScopes {
  /** 当前 Windows 账号自己的那一份（HKCU\Environment）。 */
  user: Partial<Record<StaleProxyVariableName, string>>
  /** 整台电脑的那一份，要管理员才能改。 */
  machine: Partial<Record<StaleProxyVariableName, string>>
}

export type PowerShellRunner = (script: string, env: NodeJS.ProcessEnv) => Promise<string>

export async function runPowerShell(script: string, env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync(resolveWindowsPowerShellExecutable(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    env,
    windowsHide: true,
    timeout: windowsProxyPowerShellTimeoutMs,
    maxBuffer: 64 * 1024,
  })
  return stdout
}

const powerShellNameList = staleProxyVariableNames.map((name) => `"${name}"`).join(',')

// 读代理设置这条跑在 trustedCommandEnvironment() 下：ConvertTo-Json 要是留给 PowerShell
// 自己去找模块，就得把系统模块整个扫一遍（CI 上 20 多秒），超过这里的 8 秒，检查页
// 就读不到代理设置。所以先按名字导入。清除那两条脚本不调任何命令，不用导入。
export const readProxyScopesModules = ['Microsoft.PowerShell.Utility'] as const

export const windowsProxyPowerShellTimeoutMs = 8_000

export function buildReadProxyScopesScript(): string {
  return [
    '$ErrorActionPreference = "Stop"',
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    buildPowerShellModuleImportStatement(readProxyScopesModules),
    `$names = @(${powerShellNameList})`,
    '$user = @{}',
    '$machine = @{}',
    'foreach ($name in $names) {',
    '  $value = [Environment]::GetEnvironmentVariable($name, "User")',
    '  if ($value) { $user[$name] = $value }',
    '  $value = [Environment]::GetEnvironmentVariable($name, "Machine")',
    '  if ($value) { $machine[$name] = $value }',
    '}',
    '@{ user = $user; machine = $machine } | ConvertTo-Json -Compress',
  ].join('\n')
}

function parseScope(value: unknown): Partial<Record<StaleProxyVariableName, string>> {
  const result: Partial<Record<StaleProxyVariableName, string>> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [key, entry] of Object.entries(value)) {
    const name = canonicalName(key)
    if (name && typeof entry === 'string' && entry.trim()) result[name] = entry
  }
  return result
}

export function parseProxyScopesOutput(stdout: string): ProxyVariableScopes {
  const last = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)
  if (!last) throw new Error('没能读到电脑里的代理设置')
  const parsed: unknown = JSON.parse(last)
  if (!parsed || typeof parsed !== 'object') throw new Error('没能读到电脑里的代理设置')
  const record = parsed as Record<string, unknown>
  return { user: parseScope(record.user), machine: parseScope(record.machine) }
}

/** 读当前账号与整台电脑各设了哪几个。只在 Windows 上有意义，异步起 PowerShell。 */
export async function readWindowsProxyScopes(run: PowerShellRunner = runPowerShell): Promise<ProxyVariableScopes> {
  return parseProxyScopesOutput(await run(buildReadProxyScopesScript(), trustedCommandEnvironment()))
}

/**
 * 删掉当前 Windows 账号下 `$env:XINGMANG_CLEAR_PROXY` 列出的几个变量。名字经环境
 * 变量传入、不拼进脚本；脚本里再对照固定名单过一遍，名单外的一律不碰。
 * SetEnvironmentVariable 删值时会广播设置变化，之后新开的命令行窗口就看不到它了。
 */
export function buildClearUserProxyScript(): string {
  return [
    '$ErrorActionPreference = "Stop"',
    '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    `$allowed = @(${powerShellNameList})`,
    '$cleared = @()',
    'foreach ($name in ($env:XINGMANG_CLEAR_PROXY -split ";")) {',
    '  if (-not ($allowed -contains $name)) { continue }',
    '  [Environment]::SetEnvironmentVariable($name, $null, "User")',
    '  $cleared += $name',
    '}',
    '"cleared:" + ($cleared -join ";")',
  ].join('\n')
}

export function parseClearUserProxyOutput(stdout: string): StaleProxyVariableName[] {
  const last = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)
  if (!last?.startsWith('cleared:')) throw new Error('没能确认旧的代理设置是否已经清掉')
  return last.slice('cleared:'.length).split(';')
    .map((entry) => canonicalName(entry))
    .filter((name): name is StaleProxyVariableName => name !== null)
}

export interface StaleProxyClearResult {
  /** 这次清掉的变量名。 */
  cleared: StaleProxyVariableName[]
  /** 整台电脑那一份里也有指向没开的本机代理的，要管理员才能改，这次没动。 */
  machineRemaining: boolean
}

export interface ClearStaleProxyOptions {
  platform?: NodeJS.Platform
  run?: PowerShellRunner
  probe?: LoopbackProbe
  /** 清掉之后同步改本进程的环境，下次打开工具、跑检查就不再看到它；缺省 = process.env。 */
  processEnv?: NodeJS.ProcessEnv
}

/**
 * 「清掉这条旧设置」：点的那一刻在主进程重新读、重新探一遍，只删当前账号下那几条
 * 确实指向没开的本机代理的；开着的、指向别的机器的、整台电脑那一份都不碰，不提权。
 * 渲染层不传任何名字或值进来。
 */
export async function clearStaleUserProxyVariables(options: ClearStaleProxyOptions = {}): Promise<StaleProxyClearResult> {
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('只有 Windows 上能在这里清掉这条设置')
  const run = options.run ?? runPowerShell
  const probe = options.probe ?? probeLoopbackProxy
  const scopes = await readWindowsProxyScopes(run)
  const userFindings = await inspectProxyVariables(scopes.user, probe)
  const machineFindings = await inspectProxyVariables(scopes.machine, probe)
  const targets = userFindings.filter((finding) => finding.reach === 'closed').map((finding) => finding.name)
  const machineRemaining = machineFindings.some((finding) => finding.reach === 'closed')
  if (!targets.length) return { cleared: [], machineRemaining }
  const cleared = parseClearUserProxyOutput(await run(buildClearUserProxyScript(), {
    ...trustedCommandEnvironment(),
    XINGMANG_CLEAR_PROXY: targets.join(';'),
  }))
  const processEnv = options.processEnv ?? process.env
  for (const name of cleared) {
    for (const key of Object.keys(processEnv)) {
      if (canonicalName(key) === name) delete processEnv[key]
    }
    // 用户那一份盖着整台电脑那一份；删掉之后新开的窗口看到的是整台电脑的值。
    const machineValue = scopes.machine[name]
    if (machineValue) processEnv[name] = machineValue
  }
  return { cleared, machineRemaining }
}
