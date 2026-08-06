import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { trustedCommandEnvironment } from './command-runner'
import { windowsSystemExecutable } from './command-runner'
import {
  inspectCurrentWindowsProcessAdministrator,
  resolveWindowsPowerShellExecutable,
} from './windows-elevation'
import {
  inspectWindowsDirectoryTreeAcl,
  resolveWindowsMachinePaths,
  type WindowsMachinePaths,
} from './windows-machine-paths'
import {
  isRegisteredTrustedManagedWindowsPath,
  registerTrustedManagedWindowsRoot,
} from './managed-path-trust'

const execFileAsync = promisify(execFile)
const PRODUCT_DIRECTORY = 'XingMangAI'
const INSTALLER_CACHE_DIRECTORY = 'InstallerCache'
const SAFE_PREFIX = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
let administratorCheck: Promise<boolean> | null = null

export interface TrustedTemporaryDirectoryOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  baseDirectory?: string
  applyWindowsAcl?: ApplyWindowsAcl
  machinePaths?: WindowsMachinePaths
  inspectDirectoryOwnership?: InspectWindowsDirectoryOwnership
}

export type ApplyWindowsAcl = (directory: string, env: NodeJS.ProcessEnv) => Promise<void>

export type InspectWindowsDirectoryOwnership = (
  directory: string,
  machinePaths: WindowsMachinePaths,
) => unknown

export interface TrustedDirectoryOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  applyWindowsAcl?: ApplyWindowsAcl
  machinePaths?: WindowsMachinePaths
  inspectDirectoryOwnership?: InspectWindowsDirectoryOwnership
}

export interface ProtectWindowsDirectoryOptions {
  preexisting?: boolean
  inspectOwnership?: InspectWindowsDirectoryOwnership
}

export interface WindowsAclSnapshot {
  protected: boolean
  owner: string
  rules: Array<{
    identity: string
    type: string
    rights: number
  }>
}

const SYSTEM_SID = 'S-1-5-18'
const ADMINISTRATORS_SID = 'S-1-5-32-544'
const dangerousWriteRights = 278 | 64 | 65_536 | 262_144 | 524_288
/** 0.1.5 与 0.1.6 曾在受保护根写入这个只写不读的标记文件。它建在加固完成之后，
 * 因而带着继承来的 ACL，会让下一次启动的递归 ACL 校验直接失败。 */
const LEGACY_ROOT_MARKER_FILE = '.xingmang-root'

function inspectManagedRootOwnership(directory: string, machinePaths: WindowsMachinePaths): unknown {
  // 根一旦注册，后续对子目录的 ensure 都会在注册检查处早退，深层目录不会再
  // 被单独探测；只看顶层会放过「顶层可信、深层被抢占」的预置目录树。
  return inspectWindowsDirectoryTreeAcl(directory, machinePaths)
}

function ownedByWindowsAdministrators(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false
  const entries = (snapshot as Record<string, unknown>).entries
  if (!Array.isArray(entries) || entries.length === 0) return false
  const trustedOwners = new Set([SYSTEM_SID, ADMINISTRATORS_SID])
  return entries.every((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const entry = value as Record<string, unknown>
    // ProgramData 继承 ACL 的默认形态正是「owner=Administrators 但 Users 可写」，
    // 只看属主会放行首次加固中断后停留在该形态的目录；已加固目录的写 ACE
    // 只剩 SYSTEM 与 Administrators，仍能通过。
    return typeof entry.ownerSid === 'string'
      && trustedOwners.has(entry.ownerSid.toUpperCase())
      && entry.reparsePoint === false
      && Array.isArray(entry.allowWriteSids)
      && entry.allowWriteSids.length > 0
      && entry.allowWriteSids.every((sid) => typeof sid === 'string' && trustedOwners.has(sid.toUpperCase()))
  })
}

/** Reports whether the tree holds any non-directory entry, stopping at the first
 * hit. Anything it cannot enumerate counts as content so the caller stays strict. */
function directoryTreeHasFiles(directory: string, budget = 4096): boolean {
  const pending = [directory]
  let inspected = 0
  while (pending.length > 0) {
    if (inspected++ > budget) return true
    const current = pending.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return true
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) return true
      pending.push(path.join(current, entry.name))
    }
  }
  return false
}

function assertTrustedExistingWindowsRoot(directory: string, snapshot: unknown): void {
  // ProgramData 默认允许普通用户抢先创建同名目录；采信一个不是本进程创建的
  // 目录之前必须确认属主可信，否则加固会把攻击者预置的内容一并采信。
  if (!ownedByWindowsAdministrators(snapshot)) {
    throw new Error(
      `受保护目录 ${directory} 的所有者不是管理员，且其中已存在文件，无法安全接管。`
      + '请确认这些文件来源可信后手工删除该目录，然后重新启动。',
    )
  }
}

export function validateWindowsAclSnapshot(snapshot: WindowsAclSnapshot): void {
  const trustedOwners = new Set([SYSTEM_SID, ADMINISTRATORS_SID])
  if (!snapshot.protected) throw new Error('受保护目录仍在继承上级 ACL')
  if (!trustedOwners.has(snapshot.owner.toUpperCase())) {
    throw new Error('受保护目录所有者不是 SYSTEM 或 Administrators')
  }
  const allowedWriters = new Set([SYSTEM_SID, ADMINISTRATORS_SID])
  for (const rule of snapshot.rules) {
    if (rule.type.toLowerCase() !== 'allow') continue
    if ((rule.rights & dangerousWriteRights) === 0) continue
    if (!allowedWriters.has(rule.identity.toUpperCase())) {
      throw new Error(`受保护目录仍允许非管理员身份写入：${rule.identity}`)
    }
  }
  for (const required of allowedWriters) {
    const writable = snapshot.rules.some((rule) => (
      rule.type.toLowerCase() === 'allow'
      && rule.identity.toUpperCase() === required
      && (rule.rights & dangerousWriteRights) === dangerousWriteRights
    ))
    if (!writable) throw new Error(`受保护目录缺少 ${required} 完整管理权限`)
  }
}

function normalizedPath(value: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(value).replace(/[\\/]$/, '')
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function assertPlainDirectory(directory: string, platform: NodeJS.Platform): void {
  const stats = fs.lstatSync(directory)
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('安装缓存目录不是普通目录，已停止安装')
  }
  const resolved = fs.realpathSync(directory)
  if (normalizedPath(resolved, platform) !== normalizedPath(directory, platform)) {
    throw new Error('安装缓存目录经过了符号链接或目录联接，已停止安装')
  }
}

/** Clears explicit ACEs on the whole tree so every descendant goes back to
 * inheriting. Must run before the root is hardened: it is also what repairs
 * trees whose files were left with an empty DACL by releases up to 0.1.7. */
export function windowsAclResetArguments(directory: string): string[] {
  return [directory, '/reset', '/T', '/C', '/Q']
}

/** Hardens only the root. `(OI)(CI)` are container-inheritance flags, so a
 * `/grant:r` carrying them is silently dropped on file objects - combined with
 * `/inheritance:r /T` that left every file in the tree with an empty DACL,
 * unreadable and undeletable even by an administrator. Granting on the root
 * alone lets descendants pick the rights up by inheritance instead. */
export function windowsAclHardeningArguments(directory: string): string[] {
  return [
    directory,
    '/inheritance:r',
    '/grant:r',
    '*S-1-5-18:(OI)(CI)F',
    '*S-1-5-32-544:(OI)(CI)F',
    '/Q',
  ]
}

async function currentProcessIsAdministrator(
  env: NodeJS.ProcessEnv,
  machinePaths: WindowsMachinePaths,
): Promise<boolean> {
  administratorCheck ??= inspectCurrentWindowsProcessAdministrator({ env, machinePaths }).catch(() => false)
  return administratorCheck
}

export async function protectWindowsDirectory(
  directory: string,
  env: NodeJS.ProcessEnv,
  machinePathsInput?: WindowsMachinePaths,
  hardeningOptions: ProtectWindowsDirectoryOptions = {},
): Promise<void> {
  const machinePaths = machinePathsInput ?? resolveWindowsMachinePaths()
  // 先清掉旧版本留下的标记文件，否则升级用户会永远卡在下面的递归 ACL 校验上。
  // 删不掉时不在此处报错，交给后续校验按实际 ACL 状态判定。
  try {
    fs.rmSync(path.join(directory, LEGACY_ROOT_MARKER_FILE), { force: true })
  } catch {
    // 忽略：清理失败不改变原有的安全判定
  }
  // 一个不含任何文件的目录树没有可被高权限执行的载荷，而应用自己在未提权
  // 模式下建出的托管根正是这种形态；对它拒绝采信只会误伤正常用户。下面的
  // 加固会用 /setowner 夺回属主并收紧 ACL，之后写入即受控。真正需要人工
  // 介入的是目录里已经存在文件的情况。
  if (hardeningOptions.preexisting && directoryTreeHasFiles(directory)) {
    // /setowner 之后属主必然是 Administrators，事后校验对被抢占的目录恒真；
    // 只有在第一条 icacls（乃至任何子进程）之前采样才能发现目录已被低权限
    // 账户占据，所以这一步必须先于管理员探测执行。
    let ownership: unknown
    try {
      ownership = (hardeningOptions.inspectOwnership ?? inspectManagedRootOwnership)(directory, machinePaths)
    } catch (error) {
      // 探测失败与属主不可信必须分开报告，否则排查时无法区分「目录真的被抢占」
      // 和「探测本身挂了」，两者的处置方式完全不同。
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`无法确认受保护目录 ${directory} 的所有者，已拒绝采信：${reason}`)
    }
    assertTrustedExistingWindowsRoot(directory, ownership)
  }
  if (!await currentProcessIsAdministrator(env, machinePaths)) {
    throw new Error('当前进程没有管理员权限，无法创建受保护的安装目录')
  }
  const icacls = windowsSystemExecutable('icacls.exe', env, 'win32', machinePaths)
  // 先把整棵树恢复为继承，再单独加固根。这一步同时修复历史版本遗留的空 DACL
  // 文件——它们连管理员都读不到，会让下面的校验必然失败。
  await execFileAsync(icacls, windowsAclResetArguments(directory), {
    env: trustedCommandEnvironment(env, machinePaths),
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  })
  await execFileAsync(icacls, windowsAclHardeningArguments(directory), {
    env: trustedCommandEnvironment(env, machinePaths),
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  })
  await execFileAsync(icacls, [directory, '/setowner', '*S-1-5-32-544', '/T', '/C', '/Q'], {
    env: trustedCommandEnvironment(env, machinePaths),
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  })

  const aclScript = [
    '$ErrorActionPreference = "Stop"',
    '$trusted = @("S-1-5-18", "S-1-5-32-544")',
    `$dangerousMask = [long]${dangerousWriteRights}`,
    '$target = Get-Item -LiteralPath $env:XINGMANG_ACL_TARGET -Force',
    '$items = @($target) + @(Get-ChildItem -LiteralPath $target.FullName -Force -Recurse)',
    '$rootSnapshot = $null',
    'foreach ($item in $items) {',
    '  $acl = Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $item.FullName',
    '  $rules = @($acl.Access | ForEach-Object {',
    '    $sid = $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value',
    '    [pscustomobject]@{ identity = $sid; type = [string]$_.AccessControlType; rights = [long]$_.FileSystemRights }',
    '  })',
    '  $owner = $acl.Owner',
    '  try { $owner = ([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value } catch {}',
    // 只有根断继承；子项按设计继承根的 ACL，要求它们各自 protected 会把正常
    // 的继承状态判成失败。子项的实际权限仍由下面两项检查覆盖。
    '  if ($item.FullName -eq $target.FullName -and -not $acl.AreAccessRulesProtected) { throw "受保护目录仍在继承上级 ACL: $($item.FullName)" }',
    '  if ($trusted -notcontains [string]$owner) { throw "受保护目录子项所有者不可信: $($item.FullName)" }',
    '  foreach ($rule in $rules) {',
    '    if ($rule.type -eq "Allow" -and (($rule.rights -band $dangerousMask) -ne 0) -and ($trusted -notcontains $rule.identity)) {',
    '      throw "受保护目录子项仍允许非管理员身份写入: $($item.FullName)"',
    '    }',
    '  }',
    '  foreach ($required in $trusted) {',
    '    $writable = @($rules | Where-Object { $_.type -eq "Allow" -and $_.identity -eq $required -and (($_.rights -band $dangerousMask) -eq $dangerousMask) }).Count -gt 0',
    '    if (-not $writable) { throw "受保护目录子项缺少完整管理权限: $($item.FullName)" }',
    '  }',
    '  if ($item.FullName -eq $target.FullName) {',
    '    $rootSnapshot = [pscustomobject]@{ protected = [bool]$acl.AreAccessRulesProtected; owner = [string]$owner; rules = $rules }',
    '  }',
    '}',
    '$rootSnapshot | ConvertTo-Json -Compress -Depth 4',
  ].join('; ')
  const { stdout } = await execFileAsync(
    resolveWindowsPowerShellExecutable({ env, machinePaths }),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', aclScript],
    {
      env: {
        ...trustedCommandEnvironment(env, machinePaths),
        XINGMANG_ACL_TARGET: directory,
      },
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 256 * 1024,
    },
  )
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim()) as unknown
  } catch {
    throw new Error('无法解析受保护目录 ACL 验证结果')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('受保护目录 ACL 验证结果无效')
  }
  const record = parsed as Record<string, unknown>
  const rules = Array.isArray(record.rules)
    ? record.rules
    : record.rules && typeof record.rules === 'object' ? [record.rules] : []
  const snapshot: WindowsAclSnapshot = {
    protected: record.protected === true,
    owner: typeof record.owner === 'string' ? record.owner : '',
    rules: rules.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
      const rule = entry as Record<string, unknown>
      return typeof rule.identity === 'string'
        && typeof rule.type === 'string'
        && typeof rule.rights === 'number'
        ? [{ identity: rule.identity, type: rule.type, rights: rule.rights }]
        : []
    }),
  }
  validateWindowsAclSnapshot(snapshot)
  registerTrustedManagedWindowsRoot(directory)
}

async function createWindowsDirectoryLevels(
  directory: string,
  env: NodeJS.ProcessEnv,
  machinePathsInput: WindowsMachinePaths | undefined,
  hardenNewLevels: boolean,
): Promise<boolean> {
  const target = path.resolve(directory)
  const missing: string[] = []
  let current = target
  while (!fs.existsSync(current)) {
    missing.push(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  // C:\ProgramData 这类既有祖先必然存在，抢占判定只覆盖我们自己要创建的层级。
  if (missing.length === 0) return true
  let preexisted = false
  let icacls: string | null = null
  let machinePaths: WindowsMachinePaths | null = null
  if (hardenNewLevels) {
    machinePaths = machinePathsInput ?? resolveWindowsMachinePaths()
    // mkdir 必须晚于管理员确权：裸建出的目录继承 ProgramData 的 Users 可写
    // ACL，若确权在 mkdir 之后才失败，目录会停留在低权限可写状态被下次采信。
    if (!await currentProcessIsAdministrator(env, machinePaths)) {
      throw new Error('当前进程没有管理员权限，无法创建受保护的安装目录')
    }
    icacls = windowsSystemExecutable('icacls.exe', env, 'win32', machinePaths)
  }
  for (const level of missing.reverse()) {
    try {
      await fs.promises.mkdir(level)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (level === target) preexisted = true
      continue
    }
    if (!icacls || !machinePaths) continue
    // 新目录在加固前始终继承 Users 可写 ACL；逐级立即收掉继承（不带 /T），
    // 把暴露窗口压缩到单次 mkdir 与 icacls 之间。
    await execFileAsync(icacls, [
      level,
      '/inheritance:r',
      '/grant:r',
      '*S-1-5-18:(OI)(CI)F',
      '*S-1-5-32-544:(OI)(CI)F',
    ], {
      env: trustedCommandEnvironment(env, machinePaths),
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    })
  }
  return preexisted
}

/** 同一个受保护根的加固必须串行。加固过程中 `icacls /reset /T` 会让根短暂恢复
 * 为继承 ProgramData 的 ACL（对 Users 可写），此时并发进来的另一个调用会探测到
 * 这个中间状态并判定目录被抢占。MCP、Plugins、环境扫描都会各自触发 ensure，
 * 并发是常态而非例外。 */
const trustedDirectoryQueue = new Map<string, Promise<unknown>>()

export function ensureTrustedDirectory(
  directory: string,
  options: TrustedDirectoryOptions = {},
): Promise<void> {
  const key = path.resolve(directory).toLowerCase()
  const previous = trustedDirectoryQueue.get(key) ?? Promise.resolve()
  const run = previous
    .catch(() => undefined)
    .then(() => ensureTrustedDirectoryExclusive(directory, options))
  trustedDirectoryQueue.set(key, run.catch(() => undefined))
  return run
}

async function ensureTrustedDirectoryExclusive(
  directory: string,
  options: TrustedDirectoryOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (platform !== 'win32') {
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 })
    assertPlainDirectory(directory, platform)
    await fs.promises.chmod(directory, 0o700)
    return
  }
  // 注入的 ACL 应用器（测试接缝）整体接管加固流程；默认路径才在 mkdir 前
  // 确权并逐级收紧继承 ACL。加固前的属主探测只发生在 protectWindowsDirectory
  // 内部，避免对同一目录做两次同步 PowerShell 探测。
  const preexisted = await createWindowsDirectoryLevels(
    directory,
    env,
    options.machinePaths,
    !options.applyWindowsAcl,
  )
  assertPlainDirectory(directory, platform)
  if (isRegisteredTrustedManagedWindowsPath(directory)) return
  await (options.applyWindowsAcl
    ?? ((candidate, candidateEnv) => protectWindowsDirectory(candidate, candidateEnv, options.machinePaths, {
      preexisting: preexisted,
      inspectOwnership: options.inspectDirectoryOwnership,
    })))(directory, env)
  registerTrustedManagedWindowsRoot(directory)
}

export function trustedInstallerCacheRoot(
  _env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  machinePaths?: WindowsMachinePaths,
): string {
  if (platform !== 'win32') return path.join(os.tmpdir(), 'xingmang-installer-cache')
  const programData = (machinePaths ?? resolveWindowsMachinePaths()).programData
  if (!programData || !path.win32.isAbsolute(programData)) {
    throw new Error('未找到可信的 Windows ProgramData 目录，无法创建安装缓存')
  }
  return path.join(programData, PRODUCT_DIRECTORY, INSTALLER_CACHE_DIRECTORY)
}

export async function createTrustedTemporaryDirectory(
  prefix: string,
  options: TrustedTemporaryDirectoryOptions = {},
): Promise<string> {
  if (!SAFE_PREFIX.test(prefix)) throw new Error('安装缓存目录前缀格式错误')
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const cacheRoot = options.baseDirectory
    ? path.resolve(options.baseDirectory)
    : trustedInstallerCacheRoot(env, platform, options.machinePaths)

  if (platform === 'win32') {
    const productRoot = options.baseDirectory
      ? cacheRoot
      : path.dirname(cacheRoot)
    // 不再包一层 applyAcl 闭包：走 ensureTrustedDirectory 的默认路径才能把
    // 「目录是否已存在」的事实传给 protectWindowsDirectory 的加固前快照。
    const directoryOptions: TrustedDirectoryOptions = {
      platform,
      env,
      applyWindowsAcl: options.applyWindowsAcl,
      machinePaths: options.machinePaths,
      inspectDirectoryOwnership: options.inspectDirectoryOwnership,
    }
    await ensureTrustedDirectory(productRoot, directoryOptions)

    if (!options.baseDirectory) {
      await ensureTrustedDirectory(cacheRoot, directoryOptions)
    }

    const directory = await fs.promises.mkdtemp(path.join(cacheRoot, `${prefix}-`))
    await ensureTrustedDirectory(directory, directoryOptions)
    return directory
  }

  await fs.promises.mkdir(cacheRoot, { recursive: true, mode: 0o700 })
  assertPlainDirectory(cacheRoot, platform)
  const directory = await fs.promises.mkdtemp(path.join(cacheRoot, `${prefix}-`))
  await fs.promises.chmod(directory, 0o700)
  return directory
}
