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
  const architecture = match[3].toLowerCase()
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
  if (
    typeof processId !== 'number'
    || !Number.isInteger(processId)
    || processId <= 0
    || typeof parentProcessId !== 'number'
    || !Number.isInteger(parentProcessId)
    || parentProcessId < 0
    || typeof name !== 'string'
    || typeof executablePath !== 'string'
  ) {
    return null
  }
  return { processId, parentProcessId, name, executablePath }
}

export function isCodexDesktopExecutable(executablePath: string): boolean {
  return parseCodexDesktopPackagePath(executablePath) !== null
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
 * Requests a normal process-tree close first, then force-terminates only the
 * processes that remain after the grace period.
 */
export async function stopCodexDesktopProcesses(
  entries: WindowsProcessEntry[],
  controller: CodexDesktopProcessController,
  timeouts: CodexDesktopStopTimeouts = { gracefulMs: 5_000, forcedMs: 4_000 },
): Promise<void> {
  if (!entries.length) return

  const gracefulResults = await Promise.allSettled(
    selectRootProcessIds(entries).map((processId) => controller.requestClose(processId)),
  )
  let remaining = await controller.waitUntilStopped(timeouts.gracefulMs)
  if (!remaining.length) return

  const forcedResults = await Promise.allSettled(
    selectRootProcessIds(remaining).map((processId) => controller.forceClose(processId)),
  )
  remaining = await controller.waitUntilStopped(timeouts.forcedMs)
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
