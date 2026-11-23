import { isRecord } from './input-guards'

/**
 * agy（Antigravity 命令行）官方怎么发版：谷歌的安装脚本先读一份按平台分的清单
 * `<清单站>/manifests/<平台>.json`（`version`、`url`、`sha512` 三项），再从 `url` 下载、
 * 核 SHA-512。Windows 上 `url` 指向签了名的 agy.exe 本身，Mac 上是装着它的 tar.gz。
 * 2026-11-23 在 GitHub 的临时机器上读过三个平台的清单并按清单装过（1.5.15），没有碰中转。
 *
 * Trust: the manifest host and the artifact host are constants, and a manifest is only
 * accepted when its `url` is exactly the artifact URL this module would build from the
 * version and build number it names, for the platform it was asked for. A manifest that
 * points anywhere else is refused, not followed. The SHA-512 only binds the download to the
 * manifest (both come from Google); the installer still checks Google's code signature on
 * what it unpacks before anything is put where a terminal will run it.
 */

export const antigravityCliManifestOrigin = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app'
export const antigravityCliArtifactOrigin = 'https://storage.googleapis.com'
const artifactPathPrefix = '/antigravity-public/antigravity-cli/'

// 清单只有三项，几百个字节；再大就不是清单了。
export const maximumAntigravityCliManifestBytes = 16 * 1024

/** 谷歌清单的平台名。Linux 先不做（「Linux 先不发」），等做的时候照实测补上。 */
export type AntigravityCliPlatform = 'windows_amd64' | 'windows_arm64' | 'darwin_amd64' | 'darwin_arm64'

interface AntigravityCliArtifactLayout {
  /** 版本目录下这个平台那一层的名字。 */
  directory: string
  fileName: string
  packaging: 'executable' | 'tar.gz'
}

// 1.5.15 的清单里实际写的就是这几个（三个平台各读过一遍，另两种芯片的文件在同一目录下）。
const artifactLayouts: Record<AntigravityCliPlatform, AntigravityCliArtifactLayout> = {
  windows_amd64: { directory: 'windows-x64', fileName: 'cli_windows_x64.exe', packaging: 'executable' },
  windows_arm64: { directory: 'windows-arm', fileName: 'cli_windows_arm64.exe', packaging: 'executable' },
  darwin_amd64: { directory: 'darwin-x64', fileName: 'cli_mac_x64.tar.gz', packaging: 'tar.gz' },
  darwin_arm64: { directory: 'darwin-arm', fileName: 'cli_mac_arm64.tar.gz', packaging: 'tar.gz' },
}

export interface AntigravityCliRelease {
  platform: AntigravityCliPlatform
  version: string
  /** 谷歌给每次构建的编号，版本目录名是 `<版本>-<编号>`。 */
  build: string
  url: string
  /** Lower-case hex. */
  sha512: string
  packaging: AntigravityCliArtifactLayout['packaging']
}

/** 这台电脑该读哪一份清单；不是 64 位 Windows、Mac 就是 null。 */
export function resolveAntigravityCliPlatform(platform: NodeJS.Platform, architecture: NodeJS.Architecture): AntigravityCliPlatform | null {
  const chip = architecture === 'x64' ? 'amd64' : architecture === 'arm64' ? 'arm64' : null
  if (!chip) return null
  if (platform === 'win32') return `windows_${chip}`
  if (platform === 'darwin') return `darwin_${chip}`
  return null
}

export function buildAntigravityCliManifestUrl(platform: AntigravityCliPlatform): string {
  return `${antigravityCliManifestOrigin}/manifests/${platform}.json`
}

const versionPattern = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/
const buildPattern = /^[1-9]\d{0,24}$/
const sha512Pattern = /^[0-9a-f]{128}$/i

/** The only artifact URL accepted for this platform, version and build. */
export function buildAntigravityCliArtifactUrl(platform: AntigravityCliPlatform, version: string, build: string): string {
  if (!versionPattern.test(version) || !buildPattern.test(build)) throw new Error('Antigravity 命令行的版本号无效')
  const layout = artifactLayouts[platform]
  return `${antigravityCliArtifactOrigin}${artifactPathPrefix}${version}-${build}/${layout.directory}/${layout.fileName}`
}

/**
 * Reads one platform's manifest. Anything that is not exactly the three
 * expected fields with the expected shapes, or whose URL is not the one
 * buildAntigravityCliArtifactUrl gives for its own version, is refused.
 */
export function parseAntigravityCliManifest(text: string, platform: AntigravityCliPlatform): AntigravityCliRelease {
  const failure = '无法读取 Antigravity 命令行的版本信息'
  if (!text.trim() || Buffer.byteLength(text, 'utf8') > maximumAntigravityCliManifestBytes) throw new Error(failure)
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    throw new Error(failure)
  }
  if (!isRecord(root)) throw new Error(failure)
  const { version, url, sha512 } = root
  if (typeof version !== 'string' || !versionPattern.test(version)) throw new Error(failure)
  if (typeof sha512 !== 'string' || !sha512Pattern.test(sha512)) throw new Error(failure)
  if (typeof url !== 'string') throw new Error(failure)
  const layout = artifactLayouts[platform]
  const prefix = `${antigravityCliArtifactOrigin}${artifactPathPrefix}${version}-`
  const suffix = `/${layout.directory}/${layout.fileName}`
  if (!url.startsWith(prefix) || !url.endsWith(suffix)) throw new Error(failure)
  const build = url.slice(prefix.length, url.length - suffix.length)
  if (!buildPattern.test(build) || buildAntigravityCliArtifactUrl(platform, version, build) !== url) throw new Error(failure)
  return { platform, version, build, url, sha512: sha512.toLowerCase(), packaging: layout.packaging }
}
