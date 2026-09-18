import path from 'node:path'
import os from 'node:os'
import { runCommand, trustedCommandEnvironment } from './command-runner'
import { resolveWindowsPowerShellExecutable } from './windows-elevation'

export interface ClaudeDesktopStoreVirtualization {
  localProfileVirtualized: boolean
  roamingProfileVirtualized: boolean
  roamingDeveloperVirtualized: boolean
}

export interface ClaudeDesktopManifestOptions {
  platform?: NodeJS.Platform
  /** Runtime resolver already verified this executable's package identity and path. */
  installationPath?: string | null
  osRelease?: string
  execute?: typeof runCommand
  resolvePowerShell?: () => string
}

const maximumManifestBytes = 1024 * 1024
const storeExecutablePattern = /\\WindowsApps\\Claude_(\d+(?:\.\d+){3})_(x64|arm64|neutral)__pzs8sxrjxfjjc\\app\\Claude\.exe$/i

function parseVirtualization(value: unknown, windowsBuild: number): ClaudeDesktopStoreVirtualization {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-manifest-result')
  const record = value as Record<string, unknown>
  if (!['enabled', 'disabled'].includes(String(record.globalMode)) || !Array.isArray(record.excludedDirectories)
    || record.excludedDirectories.length > 512) throw new Error('invalid-manifest-result')
  const excluded = record.excludedDirectories.map((entry: unknown) => {
    if (typeof entry !== 'string' || !entry.trim() || entry.length > 4096 || /[\x00-\x1f]/.test(entry)) throw new Error('invalid-manifest-result')
    const normalized = path.win32.normalize(entry.trim().replace(/\//g, '\\')).replace(/\\+$/, '').toLowerCase()
    if (normalized.includes('*') || normalized.includes('?')) throw new Error('unsupported-manifest-exclusion')
    return normalized
  })
  // The virtualization namespace needs build 20348. Windows 10 19045 ignores
  // these exclusions while still applying the older desktop6 global setting.
  const virtualized = (directory: string) => record.globalMode !== 'disabled'
    && !(windowsBuild >= 20348 && excluded.some((entry) => directory === entry || directory.startsWith(`${entry}\\`)))
  return {
    localProfileVirtualized: virtualized('$(knownfolder:localappdata)\\claude-3p'),
    roamingProfileVirtualized: virtualized('$(knownfolder:roamingappdata)\\claude-3p'),
    roamingDeveloperVirtualized: virtualized('$(knownfolder:roamingappdata)\\claude'),
  }
}

/** Manifest inspection is read-only and must precede resolving Store profile paths. */
export async function inspectClaudeDesktopStoreVirtualization(options: ClaudeDesktopManifestOptions): Promise<ClaudeDesktopStoreVirtualization | undefined> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32' || !options.installationPath) return undefined
  const executable = options.installationPath.replace(/\//g, '\\')
  const match = storeExecutablePattern.exec(executable)
  if (!match) return undefined
  const release = /^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(options.osRelease ?? os.release())
  if (!release || Number(release[1]) !== 10 || Number(release[2]) !== 0 || Number(release[3]) < 18362) {
    throw new Error('Claude Desktop 商店版目录规则不支持此 Windows 版本，请更新系统后重试')
  }
  const windowsBuild = Number(release[3])
  if (!/^[a-z]:\\/i.test(executable) || /[\x00-\x1f]/.test(executable)
    || path.win32.normalize(executable) !== executable) throw new Error('Claude Desktop 商店版安装路径无效')
  const manifestPath = path.win32.join(path.win32.dirname(path.win32.dirname(executable)), 'AppxManifest.xml')
  const encodedPath = Buffer.from(manifestPath, 'utf16le').toString('base64')
  const script = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$manifestPath=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}'))
if(([IO.File]::GetAttributes($manifestPath) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'manifest-reparse-point'}
$stream=[IO.File]::Open($manifestPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {
  if($stream.Length -le 0 -or $stream.Length -gt ${maximumManifestBytes}){throw 'manifest-size-limit'}
  $settings=[Xml.XmlReaderSettings]::new()
  $settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit
  $settings.XmlResolver=$null
  $settings.MaxCharactersInDocument=${maximumManifestBytes}
  $reader=[Xml.XmlReader]::Create($stream,$settings)
  try {
    $manifest=[Xml.XmlDocument]::new()
    $manifest.XmlResolver=$null
    $manifest.Load($reader)
  } finally {$reader.Dispose()}
} finally {$stream.Dispose()}
$namespaces=[Xml.XmlNamespaceManager]::new($manifest.NameTable)
$namespaces.AddNamespace('p','http://schemas.microsoft.com/appx/manifest/foundation/windows10')
$namespaces.AddNamespace('d6','http://schemas.microsoft.com/appx/manifest/desktop/windows10/6')
$namespaces.AddNamespace('v','http://schemas.microsoft.com/appx/manifest/virtualization/windows10')
$identity=$manifest.SelectSingleNode('/p:Package/p:Identity',$namespaces)
if($null -eq $identity -or $identity.GetAttribute('Name') -cne 'Claude' -or $identity.GetAttribute('Version') -cne '${match[1]}' -or $identity.GetAttribute('ProcessorArchitecture') -ine '${match[2]}'){throw 'manifest-identity-mismatch'}
$globalNodes=$manifest.SelectNodes('/p:Package/p:Properties/d6:FileSystemWriteVirtualization',$namespaces)
if($globalNodes.Count -gt 1){throw 'ambiguous-virtualization'}
$globalMode='enabled'
if($globalNodes.Count -eq 1){$globalMode=$globalNodes[0].InnerText.Trim().ToLowerInvariant()}
if($globalMode -notin @('enabled','disabled')){throw 'unsupported-virtualization'}
$excluded=@($manifest.SelectNodes('/p:Package/p:Properties/v:FileSystemWriteVirtualization/v:ExcludedDirectories/v:ExcludedDirectory',$namespaces) | ForEach-Object {$_.InnerText})
if($excluded.Count -gt 512){throw 'manifest-exclusions-limit'}
@{globalMode=$globalMode;excludedDirectories=$excluded} | ConvertTo-Json -Depth 3 -Compress
`
  try {
    const result = await (options.execute ?? runCommand)({
      executable: (options.resolvePowerShell ?? resolveWindowsPowerShellExecutable)(),
      argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    }, { env: trustedCommandEnvironment(), trustedOnly: true, windowsHide: true, timeoutMs: 15000, maxOutputBytes: 512 * 1024 })
    return parseVirtualization(JSON.parse(result.stdout.replace(/^\uFEFF/, '')), windowsBuild)
  } catch {
    throw new Error('Claude Desktop 商店版安装包清单无法安全读取，未确认配置目录，请重新检测或修复安装')
  }
}
