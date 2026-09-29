import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { resolveWindowsMachinePaths, type WindowsMachinePaths } from './windows-machine-paths'

const execFileAsync = promisify(execFile)

export type WindowsProcessorArchitecture = 'x64' | 'arm64'
export type WindowsExecutableMachine = 'x64' | 'arm64' | 'x86'

export interface WindowsProcessorProbeOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  machinePaths?: () => WindowsMachinePaths
  /** 读一个 HKLM 值的原始输出；测试用它造 ARM 电脑。读不到就 reject。 */
  queryRegistry?: (key: string, name: string) => Promise<string>
}

const systemEnvironmentKey = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
const centralProcessorKey = 'HKLM\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0'

// x64 星芒在 ARM 版 Windows 上是被系统模拟运行的：process.arch、GetNativeSystemInfo
// 和本进程收到的 PROCESSOR_ARCHITECTURE 都报 x64（AMD64），只有机器级的那份环境变量
// 和 CPU 描述还是真话。所以先读注册表，读不到才看本进程的环境变量。
function registryString(output: string, name: string): string | null {
  if (!output || Buffer.byteLength(output, 'utf8') > 64 * 1024) return null
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return output.match(new RegExp(`^\\s*${escapedName}\\s+REG_(?:EXPAND_)?SZ\\s+(.+?)\\s*$`, 'im'))?.[1] ?? null
}

/** 机器级 PROCESSOR_ARCHITECTURE（reg query 的原样输出）→ 芯片；认不出返回 null。 */
export function parseWindowsSystemProcessorArchitecture(output: string): WindowsProcessorArchitecture | null {
  const value = registryString(output, 'PROCESSOR_ARCHITECTURE')?.toUpperCase()
  if (value === 'ARM64') return 'arm64'
  if (value === 'AMD64') return 'x64'
  return null
}

/** CentralProcessor\0 的 Identifier（「ARMv8 (64-bit) Family 8 …」/「Intel64 Family 6 …」）。 */
export function parseWindowsProcessorIdentifier(output: string): WindowsProcessorArchitecture | null {
  const value = registryString(output, 'Identifier')
  if (!value) return null
  if (/^ARMv[89]\b.*64-bit/i.test(value)) return 'arm64'
  if (/^(?:Intel64|AMD64|EM64T)\b/i.test(value)) return 'x64'
  return null
}

/**
 * 本进程环境变量里的芯片。模拟运行的 32 位进程会带 PROCESSOR_ARCHITEW6432=ARM64；
 * 模拟运行的 64 位进程多半两个都报 AMD64，这时认不出，只能靠注册表。
 */
export function resolveWindowsProcessorFromEnvironment(env: NodeJS.ProcessEnv): WindowsProcessorArchitecture | null {
  for (const name of ['PROCESSOR_ARCHITEW6432', 'PROCESSOR_ARCHITECTURE']) {
    const value = env[name]?.trim().toUpperCase()
    if (value === 'ARM64') return 'arm64'
  }
  const value = env.PROCESSOR_ARCHITECTURE?.trim().toUpperCase()
  return value === 'AMD64' ? 'x64' : null
}

async function defaultQueryRegistry(
  machinePaths: () => WindowsMachinePaths,
  key: string,
  name: string,
): Promise<string> {
  const roots = machinePaths()
  const { stdout } = await execFileAsync(path.win32.join(roots.system32, 'reg.exe'), [
    'query',
    key,
    '/v',
    name,
    '/reg:64',
  ], {
    encoding: 'utf8',
    env: {
      SystemRoot: roots.systemRoot,
      WINDIR: roots.systemRoot,
      PATH: roots.system32,
    },
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  })
  return stdout
}

/**
 * 这台 Windows 电脑真实的芯片。非 Windows、或哪里都认不出时返回 null，调用方按
 * 「不知道」处理（沿用 process.arch 的旧行为），不要当成 x64 去做决定。
 */
export async function inspectWindowsProcessorArchitecture(
  options: WindowsProcessorProbeOptions = {},
): Promise<WindowsProcessorArchitecture | null> {
  if ((options.platform ?? process.platform) !== 'win32') return null
  const machinePaths = options.machinePaths ?? (() => resolveWindowsMachinePaths())
  const query = options.queryRegistry ?? ((key: string, name: string) => defaultQueryRegistry(machinePaths, key, name))
  const probes: Array<[string, string, (output: string) => WindowsProcessorArchitecture | null]> = [
    [systemEnvironmentKey, 'PROCESSOR_ARCHITECTURE', parseWindowsSystemProcessorArchitecture],
    [centralProcessorKey, 'Identifier', parseWindowsProcessorIdentifier],
  ]
  for (const [key, name, parse] of probes) {
    try {
      const architecture = parse(await query(key, name))
      if (architecture) return architecture
    } catch {
      // 读不到就换下一条线索；全都读不到再看本进程的环境变量。
    }
  }
  return resolveWindowsProcessorFromEnvironment(options.env ?? process.env)
}

/** PE 文件头里的机器类型。只认三种，其余（含读不全、不是 PE）返回 null。 */
export function parseWindowsExecutableMachine(header: Uint8Array): WindowsExecutableMachine | null {
  if (header.byteLength < 0x40 || header[0] !== 0x4d || header[1] !== 0x5a) return null
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  const peOffset = view.getUint32(0x3c, true)
  if (peOffset + 6 > header.byteLength || view.getUint32(peOffset, true) !== 0x00004550) return null
  const machine = view.getUint16(peOffset + 4, true)
  if (machine === 0x8664) return 'x64'
  if (machine === 0xaa64) return 'arm64'
  if (machine === 0x014c) return 'x86'
  return null
}

/** 读一个 exe 的头 4 KB 判断它是给哪种芯片编的；读不了返回 null，只读不写。 */
export async function inspectWindowsExecutableMachine(filePath: string): Promise<WindowsExecutableMachine | null> {
  if (!path.win32.isAbsolute(filePath) || path.win32.extname(filePath).toLowerCase() !== '.exe') return null
  let handle: fs.promises.FileHandle | null = null
  try {
    handle = await fs.promises.open(filePath, 'r')
    const buffer = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0)
    return parseWindowsExecutableMachine(buffer.subarray(0, bytesRead))
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/**
 * 装 Node.js 时挑哪一版。本机没有 Node.js 才按真实芯片挑；已经有一份（哪怕版本太旧
 * 要换）就跟它保持一致——x64 和 arm64 的安装包不互相升级，混着装会在同一个目录里
 * 留下两份。都认不出就返回 undefined，让安装器沿用 process.arch。
 */
export function chooseNodeRuntimeArchitecture(input: {
  processor: WindowsProcessorArchitecture | null
  existingNodeMachine: WindowsExecutableMachine | null
  nodeInstalled: boolean
}): WindowsProcessorArchitecture | undefined {
  if (input.nodeInstalled) {
    return input.existingNodeMachine === 'x64' || input.existingNodeMachine === 'arm64'
      ? input.existingNodeMachine
      : undefined
  }
  return input.processor ?? undefined
}
