import { codexDesktopPackageProbeName } from './codex-desktop-probe-failure'

export interface StartAppEntry {
  name: string
  appId: string
}

export interface CodexDesktopPackageEntry {
  name: string
  version: string
  packageFullName: string
  packageFamilyName: string
  installLocation: string
}

export type CodexDesktopPackageProbeSource = 'current-user' | 'all-users' | null

/**
 * Reconstructs the package identity from a running Store app executable.
 * Process paths remain readable when an elevated process cannot enumerate a
 * different user's AppX registration, so this is a useful discovery fallback.
 */
export function parseCodexDesktopPackagePath(executablePath: string): CodexDesktopPackageEntry | null {
  const normalized = executablePath.replace(/\//g, '\\')
  const match = normalized.match(
    /[\\/]WindowsApps[\\/](OpenAI\.Codex(?:Beta)?_(\d+(?:\.\d+){3})_(x64|arm64|neutral)__([A-Za-z0-9.]+))(?:[\\/]|$)/i,
  )
  if (!match) return null
  const packageFullName = match[1]
  const name = /^OpenAI\.CodexBeta_/i.test(packageFullName) ? 'OpenAI.CodexBeta' : 'OpenAI.Codex'
  const version = match[2]
  const familyPublisher = match[4]
  const installMarker = `\\WindowsApps\\${packageFullName}`
  const markerIndex = normalized.toLowerCase().indexOf(installMarker.toLowerCase())
  if (markerIndex < 0) return null
  const installLocation = normalized.slice(0, markerIndex + installMarker.length)
  return {
    name,
    version,
    packageFullName,
    packageFamilyName: `${name}_${familyPublisher}`,
    installLocation,
  }
}

export interface CodexDesktopUpdateManifest {
  schemaVersion: 1
  buildVersion: string
  storeProductId: '9PLM9XGG6VKS'
  packageIdentity: 'OpenAI.Codex'
}

export interface CodexDesktopPackageMetadata {
  name: string
  version: string
  architecture: string
  publisher: string
  hasSignature: boolean
}

export interface CodexDesktopMirrorRelease {
  version: string
  architecture: 'x64' | 'arm64'
  contentLength: number
  sha256Base64: string
}

const officialCodexDesktopPublisher = 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B'

export function parseCodexDesktopAppManifest(input: string): string | null {
  if (!input.trim() || Buffer.byteLength(input, 'utf8') > 64 * 1024) return null
  try {
    const value = JSON.parse(input) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (
      record.name !== 'openai-codex-electron'
      || record.productName !== 'Codex'
      || typeof record.version !== 'string'
      || !/^\d+(?:\.\d+){2,3}$/.test(record.version)
    ) return null
    return record.version
  } catch {
    return null
  }
}

export interface WindowsProcessEntry {
  processId: number
  parentProcessId: number
  name: string
  executablePath: string
  ownerSid?: string
  sessionId?: number
  packageFamilyName?: string
}

export interface CodexDesktopProcessController {
  requestClose(processId: number): Promise<void>
  forceClose(processId: number): Promise<void>
  waitUntilStopped(timeoutMs: number): Promise<WindowsProcessEntry[]>
}

export interface CodexDesktopStopTimeouts {
  gracefulMs: number
  forcedMs: number
}

function asStartAppEntry(value: unknown): StartAppEntry | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const name = record.Name
  const appId = record.AppID
  if (typeof name !== 'string' || typeof appId !== 'string') return null
  return { name, appId }
}

export function parseStartAppsJson(output: string): StartAppEntry[] {
  const trimmed = output.trim().replace(/^\uFEFF/, '')
  if (!trimmed) return []

  try {
    const parsed = JSON.parse(trimmed) as unknown
    const values = Array.isArray(parsed) ? parsed : [parsed]
    return values
      .map(asStartAppEntry)
      .filter((entry): entry is StartAppEntry => entry !== null)
  } catch {
    return []
  }
}

export function selectCodexDesktopApp(entries: StartAppEntry[]): StartAppEntry | null {
  const candidates = entries.filter((entry) => /^OpenAI\.Codex(?:Beta)?_.*!App$/i.test(entry.appId))
  candidates.sort((left, right) => {
    const leftIsStable = /^OpenAI\.Codex_/i.test(left.appId)
    const rightIsStable = /^OpenAI\.Codex_/i.test(right.appId)
    if (leftIsStable !== rightIsStable) return leftIsStable ? -1 : 1
    return left.appId.localeCompare(right.appId)
  })
  return candidates[0] ?? null
}

function asCodexDesktopPackageEntry(value: unknown): CodexDesktopPackageEntry | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const name = record.Name
  const version = record.Version
  const packageFullName = record.PackageFullName
  const packageFamilyName = record.PackageFamilyName
  const installLocation = record.InstallLocation
  if (
    typeof name !== 'string'
    || !/^OpenAI\.Codex(?:Beta)?$/i.test(name)
    || typeof version !== 'string'
    || !/^\d+(?:\.\d+){3}$/.test(version)
    || typeof packageFullName !== 'string'
    || typeof packageFamilyName !== 'string'
    || typeof installLocation !== 'string'
  ) return null
  return { name, version, packageFullName, packageFamilyName, installLocation }
}

export function parseCodexDesktopPackagesJson(output: string): CodexDesktopPackageEntry[] {
  const trimmed = output.trim().replace(/^\uFEFF/, '')
  if (!trimmed) return []

  try {
    const parsed = JSON.parse(trimmed) as unknown
    const values = Array.isArray(parsed) ? parsed : [parsed]
    return values
      .map(asCodexDesktopPackageEntry)
      .filter((entry): entry is CodexDesktopPackageEntry => entry !== null)
  } catch {
    return []
  }
}

/**
 * 查包脚本自己会写进 error 的唯一一句：当前账户的 Get-AppxPackage 报错时。它本来就是写给客户看的、
 * 带着下一步，所以是查包结果里唯一能原样上屏的话。脚本照这一份拼（buildCodexDesktopPackageProbeScript），
 * 解析时也只认这一份。
 */
export const codexDesktopPackageProbeAccountMessage = '读不到这台电脑上 Codex 桌面端的安装信息，请换成当初装它的那个 Windows 账户登录，再打开星芒重试。'

// 原话进日志时最多留多长：够看出是哪个字段不对、是不是更新到一半，又不把整段输出塞进一行日志。
const maximumPackageProbeDetailLength = 600

function packageProbeDetail(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, maximumPackageProbeDetailLength)
}

/**
 * 查包那段答了话、答的却不是认得的结果。摘要是英文、开头是 codexDesktopPackageProbeName，
 * 界面认出开头就换成自己的话（isCodexDesktopProbeFailure）；原话放在 detail 里，只进日志。
 * 以前这里直接写中文「Windows Appx 探测返回数据格式无效」，渲染层见是中文就原样上屏，而且
 * 原话被丢了，日志里看不出到底缺了什么（11-18 客户）。
 */
function unrecognizedCodexDesktopPackageProbe(reason: string, output: string): {
  value: null
  error: string
  source: null
  confirmedAbsent: false
  detail?: string
} {
  const detail = packageProbeDetail(output)
  return {
    value: null,
    error: `${codexDesktopPackageProbeName}: unrecognized result (${reason})`,
    source: null,
    confirmedAbsent: false,
    ...(detail ? { detail } : {}),
  }
}

/**
 * Parses the structured result emitted by the Windows Appx probe. The probe
 * deliberately reports whether an empty result is authoritative: a regular
 * user may enumerate its own packages but is not allowed to use
 * `Get-AppxPackage -AllUsers` to inspect another account.
 *
 * Only `codexDesktopPackageProbeAccountMessage` may come back as `error`
 * verbatim. Anything else the probe says, and any output that does not parse,
 * becomes an English summary for the log with the raw text in `detail`, never
 * a sentence the renderer would put on screen as-is.
 */
export function parseCodexDesktopPackageProbeJson(output: string): {
  value: CodexDesktopPackageEntry | null
  error: string | null
  source: CodexDesktopPackageProbeSource
  confirmedAbsent: boolean
  /** 探测的原话（看不懂的输出、脚本里没有的那种报错），只进日志、不上屏。只跟着英文摘要出现。 */
  detail?: string
} {
  const trimmed = output.trim().replace(/^\uFEFF/, '')
  if (!trimmed) return unrecognizedCodexDesktopPackageProbe('empty output', '')

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed) as unknown
  } catch {
    return unrecognizedCodexDesktopPackageProbe('not JSON', trimmed)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return unrecognizedCodexDesktopPackageProbe('not a JSON object', trimmed)
  }
  const record = parsed as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(record, 'packages')) {
    return unrecognizedCodexDesktopPackageProbe('no packages field', trimmed)
  }
  if (!record.packages || typeof record.packages !== 'object') {
    return unrecognizedCodexDesktopPackageProbe('invalid packages field', trimmed)
  }

  const source = record.source === 'current-user' || record.source === 'all-users'
    ? record.source
    : null
  const confirmedAbsent = record.confirmedAbsent === true
  const rawError = typeof record.error === 'string' ? record.error.trim() : ''
  // 脚本只会写给客户的那一句；别的（旧版脚本的说法、编码坏掉的乱码）都不上屏，原话进日志。
  const knownError = rawError === codexDesktopPackageProbeAccountMessage
  const packageJson = JSON.stringify(record.packages)
  const packages = packageJson ? parseCodexDesktopPackagesJson(packageJson) : []
  const rawPackages = Array.isArray(record.packages) ? record.packages : [record.packages]
  if (rawPackages.length > 0 && packages.length === 0) {
    return unrecognizedCodexDesktopPackageProbe('no package entry has a usable name, version and install folder', trimmed)
  }
  if (packages.length > 0 && source === null) {
    return unrecognizedCodexDesktopPackageProbe('packages without a source', trimmed)
  }
  if (packages.length === 0 && !confirmedAbsent && !rawError) {
    return unrecognizedCodexDesktopPackageProbe('neither a package nor a confirmed absence', trimmed)
  }
  return {
    value: selectCodexDesktopPackage(packages),
    error: !rawError ? null : knownError ? rawError : `${codexDesktopPackageProbeName}: unrecognized result (unknown error text)`,
    source,
    confirmedAbsent,
    ...(rawError && !knownError ? { detail: packageProbeDetail(rawError) } : {}),
  }
}

export function selectCodexDesktopPackage(
  entries: CodexDesktopPackageEntry[],
): CodexDesktopPackageEntry | null {
  const candidates = [...entries]
  candidates.sort((left, right) => {
    const leftIsStable = /^OpenAI\.Codex$/i.test(left.name)
    const rightIsStable = /^OpenAI\.Codex$/i.test(right.name)
    if (leftIsStable !== rightIsStable) return leftIsStable ? -1 : 1
    return right.version.localeCompare(left.version, undefined, { numeric: true })
  })
  return candidates[0] ?? null
}

/**
 * Installing or updating always targets the stable package. Only a stable
 * package's own windows need closing first: a Beta-only machine gets the
 * stable app installed next to it and its Beta keeps running (#598).
 */
export function stableInstallFamilyName(
  installedPackage: CodexDesktopPackageEntry | null,
): string | null {
  if (!installedPackage || !/^OpenAI\.Codex$/i.test(installedPackage.name)) return null
  return installedPackage.packageFamilyName
}

export function parseCodexDesktopUpdateManifest(
  input: string,
): CodexDesktopUpdateManifest | null {
  if (!input.trim() || Buffer.byteLength(input, 'utf8') > 64 * 1024) return null
  try {
    const value = JSON.parse(input) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (
      record.schemaVersion !== 1
      || typeof record.buildVersion !== 'string'
      || !/^\d+(?:\.\d+){3}$/.test(record.buildVersion)
      || record.storeProductId !== '9PLM9XGG6VKS'
      || record.packageIdentity !== 'OpenAI.Codex'
    ) return null
    return {
      schemaVersion: 1,
      buildVersion: record.buildVersion,
      storeProductId: '9PLM9XGG6VKS',
      packageIdentity: 'OpenAI.Codex',
    }
  } catch {
    return null
  }
}

export function compareWindowsPackageVersions(
  current: string,
  latest: string,
): -1 | 0 | 1 | null {
  if (!/^\d+(?:\.\d+){3}$/.test(current) || !/^\d+(?:\.\d+){3}$/.test(latest)) return null
  const currentParts = current.split('.').map(Number)
  const latestParts = latest.split('.').map(Number)
  for (let index = 0; index < 4; index += 1) {
    if (!Number.isSafeInteger(currentParts[index]) || !Number.isSafeInteger(latestParts[index])) return null
    if (currentParts[index] < latestParts[index]) return -1
    if (currentParts[index] > latestParts[index]) return 1
  }
  return 0
}

export function parseCodexDesktopPackageMetadata(
  output: string,
): CodexDesktopPackageMetadata | null {
  const trimmed = output.trim().replace(/^\uFEFF/, '')
  if (!trimmed) return null
  try {
    const value = JSON.parse(trimmed) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (
      typeof record.name !== 'string'
      || typeof record.version !== 'string'
      || !/^\d+(?:\.\d+){3}$/.test(record.version)
      || typeof record.architecture !== 'string'
      || typeof record.publisher !== 'string'
      || typeof record.hasSignature !== 'boolean'
    ) return null
    return {
      name: record.name,
      version: record.version,
      architecture: record.architecture.toLowerCase(),
      publisher: record.publisher,
      hasSignature: record.hasSignature,
    }
  } catch {
    return null
  }
}

function validSha256Base64(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return false
  const decoded = Buffer.from(value, 'base64')
  return decoded.length === 32 && decoded.toString('base64') === value
}

export function parseCodexDesktopMirrorManifest(
  input: string,
  architecture: 'x64' | 'arm64',
): CodexDesktopMirrorRelease | null {
  if (!input.trim() || Buffer.byteLength(input, 'utf8') > 256 * 1024) return null
  try {
    const value = JSON.parse(input) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const root = value as Record<string, unknown>
    if (root.schemaVersion !== 5 || !root.sources || typeof root.sources !== 'object') return null
    const windows = (root.sources as Record<string, unknown>).windows
    if (!windows || typeof windows !== 'object' || Array.isArray(windows)) return null
    const windowsRecord = windows as Record<string, unknown>
    const updateManifest = windowsRecord.updateManifest
    const architectures = windowsRecord.architectures
    if (
      !updateManifest
      || typeof updateManifest !== 'object'
      || Array.isArray(updateManifest)
      || !architectures
      || typeof architectures !== 'object'
      || Array.isArray(architectures)
    ) return null
    const official = updateManifest as Record<string, unknown>
    if (
      official.storeProductId !== '9PLM9XGG6VKS'
      || official.packageIdentity !== 'OpenAI.Codex'
      || typeof official.buildVersion !== 'string'
      || !/^\d+(?:\.\d+){3}$/.test(official.buildVersion)
    ) return null
    const release = (architectures as Record<string, unknown>)[architecture]
    if (!release || typeof release !== 'object' || Array.isArray(release)) return null
    const record = release as Record<string, unknown>
    const catalog = record.catalog
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return null
    const catalogRecord = catalog as Record<string, unknown>
    if (
      record.architecture !== architecture
      || record.downloadable !== true
      || record.status !== 'downloadable'
      || typeof record.version !== 'string'
      || !/^\d+(?:\.\d+){3}$/.test(record.version)
      || !Number.isSafeInteger(record.contentLength)
      || Number(record.contentLength) < 10 * 1024 * 1024
      || Number(record.contentLength) > 1_500 * 1024 * 1024
      || catalogRecord.hashAlgorithm !== 'SHA256'
      || !validSha256Base64(catalogRecord.hash)
      || catalogRecord.contentLength !== record.contentLength
      || typeof catalogRecord.packageFullName !== 'string'
      || !catalogRecord.packageFullName.startsWith(`OpenAI.Codex_${record.version}_${architecture}__`)
    ) return null
    return {
      version: record.version,
      architecture,
      contentLength: Number(record.contentLength),
      sha256Base64: catalogRecord.hash,
    }
  } catch {
    return null
  }
}

export function codexDesktopPackageValidationError(
  metadata: CodexDesktopPackageMetadata,
  expectedVersion: string,
  expectedArchitecture: 'x64' | 'arm64',
): string | null {
  if (metadata.name !== 'OpenAI.Codex') return '官方安装包的产品身份不是 OpenAI.Codex'
  const comparison = compareWindowsPackageVersions(metadata.version, expectedVersion)
  if (comparison === null) return '官方安装包的版本号无效'
  if (comparison < 0) return `官方安装包版本 ${metadata.version} 低于更新清单 ${expectedVersion}`
  if (![expectedArchitecture, 'neutral'].includes(metadata.architecture)) {
    return `官方安装包架构 ${metadata.architecture} 与本机 ${expectedArchitecture} 不匹配`
  }
  if (metadata.publisher.trim().toUpperCase() !== officialCodexDesktopPublisher.toUpperCase()) {
    return '官方安装包的发布者身份不匹配'
  }
  if (!metadata.hasSignature) return '官方安装包缺少 Appx 签名'
  return null
}

function asWindowsProcessEntry(value: unknown): WindowsProcessEntry | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const processId = record.ProcessId
  const parentProcessId = record.ParentProcessId
  const name = record.Name
  const executablePath = record.ExecutablePath
  const ownerSid = record.OwnerSid
  const currentOwnerSid = record.CurrentOwnerSid
  const sessionId = record.SessionId
  const currentSessionId = record.CurrentSessionId
  const packageFamilyName = record.PackageFamilyName
  if (
    typeof processId !== 'number'
    || !Number.isInteger(processId)
    || processId <= 0
    || typeof parentProcessId !== 'number'
    || !Number.isInteger(parentProcessId)
    || parentProcessId < 0
    || typeof name !== 'string'
    || typeof executablePath !== 'string'
    || typeof ownerSid !== 'string'
    || !/^S-\d+(?:-\d+)+$/i.test(ownerSid)
    || ownerSid !== currentOwnerSid
    || typeof sessionId !== 'number'
    || !Number.isInteger(sessionId)
    || sessionId < 0
    || sessionId !== currentSessionId
    || typeof packageFamilyName !== 'string'
  ) {
    return null
  }
  const packageEntry = parseCodexDesktopPackagePath(executablePath)
  if (!packageEntry || packageEntry.packageFamilyName.toLowerCase() !== packageFamilyName.toLowerCase()) return null
  return { processId, parentProcessId, name, executablePath, ownerSid, sessionId, packageFamilyName }
}

export function isCodexDesktopExecutable(executablePath: string): boolean {
  return parseCodexDesktopPackagePath(executablePath) !== null
}

/**
 * Codex 桌面端在 Windows 上把自带的 codex.exe 放进 PATH。按命令名找到的若是它，不算装了 Codex CLI：
 * 首页（system-scan-service.ts）和扩展页（codex-extensions.ts 的 isCodexCliInstalled）都按这一句认。
 */
export function isCodexDesktopCliInstallation(installation: { source: string; commandPath: string }): boolean {
  return installation.source === 'native' && isCodexDesktopExecutable(installation.commandPath)
}

export function parseWindowsProcessesJson(output: string): WindowsProcessEntry[] {
  const trimmed = output.trim().replace(/^\uFEFF/, '')
  if (!trimmed) return []

  try {
    const parsed = JSON.parse(trimmed) as unknown
    const values = Array.isArray(parsed) ? parsed : [parsed]
    return values
      .map(asWindowsProcessEntry)
      .filter((entry): entry is WindowsProcessEntry => entry !== null)
      .filter((entry) => isCodexDesktopExecutable(entry.executablePath))
  } catch {
    return []
  }
}

export function selectCodexDesktopProcessesForPackage(
  entries: WindowsProcessEntry[],
  packageFamilyName: string | null,
  originalProcessIds?: ReadonlySet<number>,
): WindowsProcessEntry[] {
  return entries.filter((entry) => (
    typeof entry.ownerSid === 'string'
    && typeof entry.sessionId === 'number'
    // null means "any verified Codex window"; only the open path passes it.
    && (packageFamilyName === null
      || entry.packageFamilyName?.toLowerCase() === packageFamilyName.toLowerCase())
    && (originalProcessIds === undefined || originalProcessIds.has(entry.processId))
  ))
}

export function selectRootProcessIds(entries: WindowsProcessEntry[]): number[] {
  const processIds = new Set(entries.map((entry) => entry.processId))
  const roots = entries
    .filter((entry) => !processIds.has(entry.parentProcessId))
    .map((entry) => entry.processId)
  return roots.length ? roots : entries.map((entry) => entry.processId)
}

function errorMessage(reason: unknown): string | null {
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim()
  if (typeof reason === 'string' && reason.trim()) return reason.trim()
  return null
}

function remainingProcessSummary(entries: WindowsProcessEntry[]): string {
  return entries
    .map((entry) => `${entry.name} (PID ${entry.processId})`)
    .join('、')
}

/**
 * Requests a normal close for each selected PID, then force-terminates only
 * the original processes that remain after the grace period. New PIDs seen
 * during the wait are never added to the termination set.
 */
export async function stopCodexDesktopProcesses(
  entries: WindowsProcessEntry[],
  controller: CodexDesktopProcessController,
  timeouts: CodexDesktopStopTimeouts = { gracefulMs: 5_000, forcedMs: 4_000 },
): Promise<void> {
  if (!entries.length) return

  const originalById = new Map(entries.map((entry) => [entry.processId, entry]))
  function originalProcesses(current: WindowsProcessEntry[]): WindowsProcessEntry[] {
    return current.filter((entry) => {
      const original = originalById.get(entry.processId)
      return original !== undefined
        && original.ownerSid === entry.ownerSid
        && original.sessionId === entry.sessionId
        && original.packageFamilyName?.toLowerCase() === entry.packageFamilyName?.toLowerCase()
        && original.executablePath.replace(/\//g, '\\').toLowerCase()
          === entry.executablePath.replace(/\//g, '\\').toLowerCase()
    })
  }

  const gracefulResults = await Promise.allSettled(
    entries.map((entry) => controller.requestClose(entry.processId)),
  )
  let remaining = originalProcesses(await controller.waitUntilStopped(timeouts.gracefulMs))
  if (!remaining.length) return

  const forcedResults = await Promise.allSettled(
    remaining.map((entry) => controller.forceClose(entry.processId)),
  )
  remaining = originalProcesses(await controller.waitUntilStopped(timeouts.forcedMs))
  if (!remaining.length) return

  const systemErrors = [...gracefulResults, ...forcedResults]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => errorMessage(result.reason))
    .filter((message): message is string => message !== null)
  const detail = systemErrors.length ? ` 系统返回：${systemErrors.at(-1)}` : ''
  throw new Error(
    `Codex 桌面端未能退出，仍在运行：${remainingProcessSummary(remaining)}。`
    + `请先在 Codex 中退出后重试。${detail}`,
  )
}
