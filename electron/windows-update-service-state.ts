import { execFile } from 'node:child_process'
import path from 'node:path'
import { runRegistryQuery, type RegistryQueryRunner } from './windows-live-path'
import { resolveWindowsSystemRoot } from './windows-system-root'

// Codex 桌面端第一次在这台电脑上启动时，要借 Windows 更新服务向微软完成验证。2026-11-23 一台
// Win11 家庭版 21H2 22000.2245：客户找人关了 Windows 更新，办法是给 SoftwareDistribution\Download
// 加一条「所有人拒绝完全控制」，服务设置、策略全是默认，更新服务每 2 分钟被叫起来一次、每次都以
// 「一般性拒绝访问错误」退出（系统日志 7023）。Codex 激活回 0x800705B4，自带的后台服务卡在「正在启动」；
// 去掉那条拒绝 5 秒内两边都起来了，加回去、重启以后照样能开，所以只有第一次要放开。
//
// 这里只读两样，什么都不改：服务的启动类型（被禁用就是 4），和最近一小时系统日志里更新服务因
// 「拒绝访问」退出了几次。两样都读不到就当没被拦，失败框照旧是通用那一版。

const WUAUSERV_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\wuauserv'
const SERVICE_START_DISABLED = 4
/** 往回看多久。那台是每 2 分钟一条；一小时里两条以上才算「一直起不来」，偶尔失败一次不算。 */
const REFUSED_START_WINDOW_MS = 60 * 60 * 1000
const MIN_REFUSED_STARTS = 2
const MAX_EVENTS = 20
/**
 * 「wuauserv」加结尾的 0，按 UTF-16LE 写成十六进制。服务控制管理器把服务名放在 7023 事件的
 * Binary 里，显示名会随系统语言变，这一段不会。
 */
const WUAUSERV_EVENT_BINARY = '770075006100750073006500720076000000'
/** 7023 的 param2：0x80070005 写成十进制（那台实际记的就是它），和 Win32 的 ERROR_ACCESS_DENIED。 */
const ACCESS_DENIED_PARAMS = new Set(['%%2147942405', '%%5'])

export type WindowsEventQueryRunner = (executable: string, argv: string[], env: NodeJS.ProcessEnv) => Promise<Buffer>

export interface WindowsUpdateServiceState {
  /** 注册表里 wuauserv 的 Start；读不到为 null。 */
  startType: number | null
  /** 最近一小时（最多看最新 20 条）里更新服务因拒绝访问退出的次数。 */
  refusedStarts: number
}

/** reg.exe query 的输出里取 Start；没有这一项返回 null。 */
export function parseWindowsServiceStartType(output: string): number | null {
  const value = output.match(/^\s*Start\s+REG_DWORD\s+0x([0-9a-f]+)\s*$/im)?.[1]
  return value === undefined ? null : Number.parseInt(value, 16)
}

/** 给 wevtutil 的 XPath：服务控制管理器最近一小时的 7023（服务因错误而停止）。 */
export function buildWindowsUpdateRefusedStartQuery(): string {
  return `*[System[Provider[@Name='Service Control Manager'] and (EventID=7023) and TimeCreated[timediff(@SystemTime) <= ${REFUSED_START_WINDOW_MS}]]]`
}

/**
 * wevtutil 写进管道的字随系统代码页（中文系统是 GBK），要看的几处（事件号、Binary、%%码）全是 ASCII，
 * 按 latin1 读就够；万一是 UTF-16LE（带 BOM 或第二个字节是 0），换着读。
 */
export function decodeWindowsEventQueryOutput(output: Buffer): string {
  if (output.length >= 2 && output[0] === 0xff && output[1] === 0xfe) return output.subarray(2).toString('utf16le')
  if (output.length >= 2 && output[0] !== 0 && output[1] === 0) return output.toString('utf16le')
  return output.toString('latin1')
}

/** wevtutil /f:xml 的输出里数更新服务因拒绝访问退出的 7023 有几条；别的服务、别的错误都不算。 */
export function countWindowsUpdateRefusedStarts(output: string): number {
  let count = 0
  for (const event of output.match(/<Event[\s>][\s\S]*?<\/Event>/g) ?? []) {
    if (!/<EventID(?:\s[^>]*)?>\s*7023\s*<\/EventID>/.test(event)) continue
    if (!/<Provider\s[^>]*Name=['"]Service Control Manager['"]/.test(event)) continue
    const binary = event.match(/<Binary>\s*([0-9a-f]*)\s*<\/Binary>/i)?.[1]?.toLowerCase() ?? ''
    if (!binary.startsWith(WUAUSERV_EVENT_BINARY)) continue
    const params = [...event.matchAll(/<Data(?:\s[^>]*)?>([^<]*)<\/Data>/g)].map((match) => match[1].trim())
    if (params.some((param) => ACCESS_DENIED_PARAMS.has(param))) count += 1
  }
  return count
}

/** 被禁用，或最近一小时里至少两次因拒绝访问退出，就算这台电脑的 Windows 更新服务起不来。 */
export function isWindowsUpdateServiceBlocked(state: WindowsUpdateServiceState): boolean {
  return state.startType === SERVICE_START_DISABLED || state.refusedStarts >= MIN_REFUSED_STARTS
}

function runWindowsEventQuery(executable: string, argv: string[], env: NodeJS.ProcessEnv): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(executable, argv, { encoding: 'buffer', env, windowsHide: true, timeout: 5_000, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

function defaultSystem32(): string {
  return path.win32.join(resolveWindowsSystemRoot(), 'System32')
}

export interface WindowsUpdateServiceProbeDependencies {
  platform?: NodeJS.Platform
  resolveSystem32?: () => string
  queryRegistry?: RegistryQueryRunner
  queryEvents?: WindowsEventQueryRunner
}

/**
 * 只读地看一眼 Windows 更新服务起不起得来，从不抛错。照 windows-text-scale.ts 的读法：reg.exe 和
 * wevtutil.exe 都用 System32 里那一份的绝对路径（I14），参数是数组（I1），环境只给系统目录，异步起。
 */
export async function inspectWindowsUpdateServiceState(
  dependencies: WindowsUpdateServiceProbeDependencies = {},
): Promise<WindowsUpdateServiceState | null> {
  if ((dependencies.platform ?? process.platform) !== 'win32') return null
  let system32: string
  try {
    system32 = (dependencies.resolveSystem32 ?? defaultSystem32)()
  } catch {
    return null
  }
  const systemRoot = path.win32.dirname(system32)
  const env = { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: system32 }
  const queryRegistry = dependencies.queryRegistry ?? runRegistryQuery
  const queryEvents = dependencies.queryEvents ?? runWindowsEventQuery
  const [startType, refusedStarts] = await Promise.all([
    queryRegistry(path.win32.join(system32, 'reg.exe'), ['query', WUAUSERV_KEY, '/v', 'Start'], env)
      .then(parseWindowsServiceStartType, () => null),
    queryEvents(path.win32.join(system32, 'wevtutil.exe'), [
      'qe',
      'System',
      `/q:${buildWindowsUpdateRefusedStartQuery()}`,
      `/c:${MAX_EVENTS}`,
      '/rd:true',
      '/f:xml',
    ], env)
      .then((output) => countWindowsUpdateRefusedStarts(decodeWindowsEventQueryOutput(output)), () => 0),
  ])
  return { startType, refusedStarts }
}

export async function inspectWindowsUpdateServiceBlocked(
  dependencies: WindowsUpdateServiceProbeDependencies = {},
): Promise<boolean> {
  const state = await inspectWindowsUpdateServiceState(dependencies)
  return state !== null && isWindowsUpdateServiceBlocked(state)
}
