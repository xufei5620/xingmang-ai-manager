/**
 * Antigravity 桌面端官方怎么发版：它自己更新用 electron-updater，`resources/app-update.yml` 指向
 * `<更新站>/manifest/`，实际读的是按芯片、系统分开的 `latest-<x64|arm64>-<win|mac>.yml`（标准的
 * latest.yml、latest-mac.yml 都是 404）。每份只列一个文件：Windows 是谷歌签名的 NSIS 安装包，Mac 是
 * 装着 Antigravity.app 的 zip，带 SHA-512（base64）和大小。2026-11-23 在 GitHub 的临时机器上读过四份
 * （2.34.0，构建号 5887025308631040），也拆过 Mac 的 zip，没有碰中转。
 *
 * Trust: the feed host and the artifact host are constants, and a feed is only accepted when its
 * one file URL is exactly the artifact URL this module builds from the version and build number
 * it names, for the platform it was asked for. The feed is read as the small fixed YAML shape the
 * updater writes, line by line, not handed to a YAML library: anything else in it is refused, not
 * guessed at. The SHA-512 and size only bind the download to the feed (both come from Google); the
 * installer still checks Google's signature on what it downloaded before running or installing it.
 */

export const antigravityDesktopFeedOrigin = 'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app'
export const antigravityDesktopArtifactOrigin = 'https://storage.googleapis.com'
const artifactPathPrefix = '/antigravity-public/antigravity-hub/'

// 2.34.0 的四份都是四百字节上下。
export const maximumAntigravityDesktopFeedBytes = 16 * 1024
// 2.34.0：Windows 安装包 160、170 MB，Mac 的 zip 212、223 MB。
export const minimumAntigravityDesktopArtifactBytes = 16 * 1024 * 1024
export const maximumAntigravityDesktopArtifactBytes = 1024 * 1024 * 1024

/** 星芒替客户装的四种。Linux 先不做（「Linux 先不发」）。 */
export type AntigravityDesktopPlatform = 'windows-x64' | 'windows-arm64' | 'macos-x64' | 'macos-arm64'

interface AntigravityDesktopLayout {
  feedName: string
  directory: string
  fileName: string
  packaging: 'nsis-installer' | 'app-zip'
}

const layouts: Record<AntigravityDesktopPlatform, AntigravityDesktopLayout> = {
  'windows-x64': { feedName: 'latest-x64-win.yml', directory: 'windows-x64', fileName: 'Antigravity-x64.exe', packaging: 'nsis-installer' },
  'windows-arm64': { feedName: 'latest-arm64-win.yml', directory: 'windows-arm', fileName: 'Antigravity-arm64.exe', packaging: 'nsis-installer' },
  'macos-x64': { feedName: 'latest-x64-mac.yml', directory: 'darwin-x64', fileName: 'Antigravity.zip', packaging: 'app-zip' },
  'macos-arm64': { feedName: 'latest-arm64-mac.yml', directory: 'darwin-arm', fileName: 'Antigravity.zip', packaging: 'app-zip' },
}

export interface AntigravityDesktopRelease {
  platform: AntigravityDesktopPlatform
  version: string
  /** 谷歌给每次构建的编号，版本目录名是 `<版本>-<编号>`。 */
  build: string
  url: string
  bytes: number
  /** Lower-case hex (the feed writes base64). */
  sha512: string
  packaging: AntigravityDesktopLayout['packaging']
}

const versionPattern = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/
const buildPattern = /^[1-9]\d{0,24}$/
const base64Sha512Pattern = /^[A-Za-z0-9+/]{86}==$/

/** 这台电脑该装哪一种；不是 64 位 Windows、Mac 就是 null。 */
export function resolveAntigravityDesktopPlatform(platform: NodeJS.Platform, architecture: NodeJS.Architecture): AntigravityDesktopPlatform | null {
  const chip = architecture === 'x64' ? 'x64' : architecture === 'arm64' ? 'arm64' : null
  if (!chip) return null
  if (platform === 'win32') return `windows-${chip}`
  if (platform === 'darwin') return `macos-${chip}`
  return null
}

export function buildAntigravityDesktopFeedUrl(platform: AntigravityDesktopPlatform): string {
  return `${antigravityDesktopFeedOrigin}/manifest/${layouts[platform].feedName}`
}

/** The only artifact URL accepted for this platform, version and build. */
export function buildAntigravityDesktopArtifactUrl(platform: AntigravityDesktopPlatform, version: string, build: string): string {
  if (!versionPattern.test(version) || !buildPattern.test(build)) throw new Error('Antigravity 桌面端的版本号无效')
  const layout = layouts[platform]
  return `${antigravityDesktopArtifactOrigin}${artifactPathPrefix}${version}-${build}/${layout.directory}/${layout.fileName}`
}

function scalar(value: string): string {
  const quoted = /^(['"])(.*)\1$/.exec(value)
  return quoted ? quoted[2] : value
}

function base64ToHex(value: string): string | null {
  if (!base64Sha512Pattern.test(value)) return null
  const bytes = Buffer.from(value, 'base64')
  return bytes.length === 64 && bytes.toString('base64') === value ? bytes.toString('hex') : null
}

/**
 * Reads one platform's feed: `version`, a `files` list with exactly one `url`/`sha512`/`size`
 * entry, and the legacy top-level `path`/`sha512` electron-builder repeats (which must then agree
 * with that entry). `releaseDate` and other plain top-level values are tolerated; a second file,
 * a repeated key, nesting or any line of another shape makes the whole feed unacceptable.
 */
export function parseAntigravityDesktopFeed(text: string, platform: AntigravityDesktopPlatform): AntigravityDesktopRelease | null {
  if (!text.trim() || Buffer.byteLength(text, 'utf8') > maximumAntigravityDesktopFeedBytes) return null
  const top = new Map<string, string>()
  const files: Map<string, string>[] = []
  let inFiles = false
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim()) continue
    const topLevel = /^([A-Za-z][A-Za-z0-9]*):(?:[ \t]+(\S(?:.*\S)?))?[ \t]*$/.exec(line)
    if (topLevel) {
      const [, key, value] = topLevel
      if (top.has(key) || (key === 'files') !== (value === undefined)) return null
      top.set(key, value === undefined ? '' : scalar(value))
      inFiles = key === 'files'
      continue
    }
    const item = /^[ \t]+(-[ \t]+)?([A-Za-z][A-Za-z0-9]*):[ \t]+(\S(?:.*\S)?)[ \t]*$/.exec(line)
    if (!item || !inFiles) return null
    const [, dash, key, value] = item
    if (dash) files.push(new Map())
    const entry = files[files.length - 1]
    if (!entry || entry.has(key)) return null
    entry.set(key, scalar(value))
  }
  if (files.length !== 1 || !top.has('files')) return null
  const file = files[0]
  const version = top.get('version')
  const url = file.get('url')
  const size = file.get('size')
  const sha512 = base64ToHex(file.get('sha512') ?? '')
  if (!version || !versionPattern.test(version) || !url || !size || !/^[1-9]\d{0,15}$/.test(size) || !sha512) return null
  const layout = layouts[platform]
  const prefix = `${antigravityDesktopArtifactOrigin}${artifactPathPrefix}${version}-`
  const suffix = `/${layout.directory}/${layout.fileName}`
  if (!url.startsWith(prefix) || !url.endsWith(suffix)) return null
  const build = url.slice(prefix.length, url.length - suffix.length)
  if (!buildPattern.test(build) || buildAntigravityDesktopArtifactUrl(platform, version, build) !== url) return null
  if (top.has('path') && top.get('path') !== layout.fileName) return null
  if (top.has('sha512') && base64ToHex(top.get('sha512') ?? '') !== sha512) return null
  const bytes = Number(size)
  if (!Number.isSafeInteger(bytes) || bytes < minimumAntigravityDesktopArtifactBytes || bytes > maximumAntigravityDesktopArtifactBytes) return null
  return { platform, version, build, url, bytes, sha512, packaging: layout.packaging }
}
