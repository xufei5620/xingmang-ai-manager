import { execFile } from 'node:child_process'
import path from 'node:path'

// 星芒自己的 process.env 是它启动那一刻的快照：星芒开着的时候客户装了 PowerShell 7
// 一类会往 PATH 里加一段的程序，要等星芒重开才看得见；客户新开的终端却立刻看得见。
// 这里读注册表里整台电脑和当前账号那两份 PATH，拼出「现在新开一个终端会拿到的」PATH。
// 只用来推 Grok 会拿哪个 shell 跑钩子、以及从星芒打开 Grok 时补上新加的那几段，
// 不改 process.env，也不参与任何提权执行的路径解析（那边只认 trustedCommandEnvironment）。

const MACHINE_ENVIRONMENT_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
const USER_ENVIRONMENT_KEY = 'HKCU\\Environment'

export type RegistryQueryRunner = (executable: string, argv: string[], env: NodeJS.ProcessEnv) => Promise<string>

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lower && typeof value === 'string') return value
  }
  return undefined
}

/** reg.exe query 的输出里取 Path 那一行的值；没有这一项返回 null。 */
export function parseRegistryPathValue(output: string): string | null {
  return output.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/im)?.[1] ?? null
}

/** 照 Windows 的规矩展开 %NAME%；不认识的名字原样留着，与系统自己的行为一致。 */
export function expandWindowsEnvironmentReferences(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => environmentValue(env, name) ?? whole)
}

/** 在 base 后面补上 extra 里 base 还没有的段，已有的次序一点不动（Windows 路径不分大小写）。 */
export function appendWindowsPathEntries(base: string, extra: string): string {
  const entries = base.split(';').map((entry) => entry.trim()).filter(Boolean)
  const seen = new Set(entries.map((entry) => entry.replace(/^"(.*)"$/, '$1').replace(/\\+$/, '').toLowerCase()))
  for (const raw of extra.split(';')) {
    const entry = raw.trim()
    const key = entry.replace(/^"(.*)"$/, '$1').replace(/\\+$/, '').toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    entries.push(entry)
  }
  return entries.join(';')
}

function runRegistryQuery(executable: string, argv: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, argv, { encoding: 'utf8', env, windowsHide: true, timeout: 3_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/**
 * 整台电脑那份在前、当前账号那份在后，与 Windows 给新开的进程拼 PATH 的次序一致。
 * reg.exe 用 System32 里那一份的绝对路径（I14），异步起，不挡主线程；任何一份读不到就当它是空的，
 * 两份都读不到返回 null，调用方照旧用快照。
 */
export async function readWindowsLivePath(
  system32: string,
  env: NodeJS.ProcessEnv,
  run: RegistryQueryRunner = runRegistryQuery,
): Promise<string | null> {
  const executable = path.win32.join(system32, 'reg.exe')
  const systemRoot = path.win32.dirname(system32)
  const queryEnv = { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: system32 }
  const read = async (key: string) => {
    try {
      const value = parseRegistryPathValue(await run(executable, ['query', key, '/v', 'Path'], queryEnv))
      return value === null ? null : expandWindowsEnvironmentReferences(value, env)
    } catch {
      return null
    }
  }
  const [machine, user] = await Promise.all([read(MACHINE_ENVIRONMENT_KEY), read(USER_ENVIRONMENT_KEY)])
  if (machine === null && user === null) return null
  return appendWindowsPathEntries(machine ?? '', user ?? '')
}

/**
 * 在 env 原有 PATH 后面补上 extra 里新出现的段，返回一份新对象。Windows 的 process.env 里
 * PATH 常写作 Path：原来那个键一律换成 PATH 一个，免得两份 PATH 并存、谁先被读到看运气。
 */
export function withAppendedWindowsPath(env: NodeJS.ProcessEnv, extra: string | null): NodeJS.ProcessEnv {
  if (!extra) return env
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() !== 'path') result[key] = value
  }
  result.PATH = appendWindowsPathEntries(environmentValue(env, 'PATH') ?? '', extra)
  return result
}
