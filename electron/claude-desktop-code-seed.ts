/**
 * Windows 上从星芒打开 Claude Desktop 之前，替它把 Claude Code 程序先放好（2026-11-03 探测，yoyo「开探测」）。
 *
 * Claude Desktop 的聊天、Code 都靠一份 Claude Code 程序，它第一次用、每次自己升级换了版本以后，都要从
 * downloads.claude.ai 下一份（压缩后约 100MB），国内直连下不动，网络加速 10-30 下线以后就一直卡在这。
 * 拆了 4.4212.0 看到（/mnt/project-files/加速下线/Claude放程序-实现要点-1103.md）：
 * - 要哪一版、那份压缩包的 sha256 编在它自己程序里（app.asar 里 `.vite/build/` 下某个 JS 的一段
 *   `JSON.parse('{"version":"2.1.309","manifest":{…"platforms":{"win32-x64":{"binary":"claude.exe.zst",
 *   "checksum":"…","size":…}}}…}')`）。
 * - 放在 `<userData>\claude-code\<版本>\<checksum 前 12 位>\claude.exe`；启动时只看程序在不在、旁边 `.verified`
 *   里写的是不是那份 checksum，Windows 上不重算整个文件。它自己的离线版就是解压、核对、写 claude.exe、
 *   `.payload`（解压后的 sha256 和大小）、`.verified` 三样，`.verified` 最后写。
 * - npm 上 `@anthropic-ai/claude-code-win32-x64` 那一版的 `package/claude.exe` 跟官网压缩包解开的逐字节相同
 *   （2.1.309、2.1.317 都比过），国内 npm 镜像下得动。
 *
 * 所以这里：读出它要的那一版，从 npm 镜像下同一版的包（照旧拿 npm 官方源的 SHA-512 对账，不放宽），照它的
 * 格式放进它的文件夹。只在 Windows、星芒以当前用户身份在跑（same-user）、Claude 没开着的时候做；
 * 读不出版本、拿不到官方源的对账值、下不动、盘不够，一律放弃，照常打开，交还 Claude 自己去下，客户
 * 不会比没有这一步更差。Claude 每一版都可能改放法，对不上就不放；放错了它会当成没下过、自己重下，不会坏。
 *
 * Mac 不做：那边要的是带签名的 claude.app 包，npm 里的不是同一个文件。Cowork 的工作区国内没有来源，也不做。
 */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import { readBoundedResponseText } from './bounded-response'
import { readDiskSpace, installMinimumFreeBytes, type DiskSpaceReading } from './disk-space'
import type { ExternalClientLaunchProgress } from './external-client-contract'
import { downloadWithResume, DownloadStalledError } from './download-retry'
import { npmMirrorRegistry, npmOfficialRegistry, npmPackageVersionUrl } from './npm-registry'
import { fetchLandingWithRedirectAllowlist } from './redirect-allowlist-fetch'
import {
  assertNoReparseComponents, assertSafeDataFile, ensureSafeDataDirectory, removeSafeDataFile,
  renameWithTransientRetry, writeAtomicSafeUtf8File,
} from './safe-local-data'
import { redactHomeDirectory } from './startup-log'
import type { WindowsCliExecutionMode } from './windows-elevation'

export type ClaudeCodeSeedPlatform = 'win32-x64' | 'win32-arm64'

/** Claude Desktop 编在自己程序里的那一版 Claude Code（M_() 返回的那一份里当前平台那一项）。 */
export interface ClaudeCodeBuildPin {
  version: string
  platform: ClaudeCodeSeedPlatform
  /** 官网那份文件的 sha256（小写十六进制）。`.verified` 里要写的就是它，编号目录也由它的前 12 位得来。 */
  checksum: string
  /** 官网那份文件叫什么：现在是压缩包 claude.exe.zst；是 claude.exe 时 checksum 就是程序本身的。 */
  binary: 'claude.exe.zst' | 'claude.exe'
  size: number
}

export interface ClaudeCodeSeedPaths {
  /** `<userData>\claude-code`。 */
  storageDirectory: string
  /** `<userData>\claude-code\<版本>`：老版本 Claude 直接装在这一层，它自己会挪进编号目录。 */
  versionDirectory: string
  /** `<userData>\claude-code\<版本>\<编号>`。 */
  installDirectory: string
  binaryPath: string
  payloadPath: string
  verifiedPath: string
}

export type ClaudeDesktopCodeSeedSkipReason =
  | 'unsupported-platform'
  | 'not-same-user'
  | 'remote-off'
  | 'running'
  | 'asar-missing'
  | 'asar-unreadable'
  | 'pin-not-found'
  | 'profile-unresolved'
  | 'disk-space'
  | 'metadata-failed'
  | 'download-failed'
  | 'started-meanwhile'
  | 'write-failed'
  | 'timeout'

export type ClaudeDesktopCodeSeedOutcome =
  | { status: 'present'; version: string }
  | { status: 'placed'; version: string }
  | { status: 'skipped'; reason: ClaudeDesktopCodeSeedSkipReason }

/** 打开前那次检测认出来的 Claude Desktop：装在哪、这会儿开没开，和再问一次「开着没有」的办法。 */
export interface ClaudeDesktopSeedClient {
  path: string
  running: boolean
  /** 下完、放进去之前再问一次：true / false / null（查不出来）。 */
  isRunning?(): Promise<boolean | null>
}

export interface ClaudeDesktopCodeSeedProgress {
  phase: 'downloading' | 'placing'
  version: string
  transferred: number
  total: number | null
}

const asarHeaderLimitBytes = 16 * 1024 * 1024
const asarScriptLimitBytes = 32 * 1024 * 1024
const asarScanLimitBytes = 96 * 1024 * 1024
const asarScanLimitFiles = 128
// 那段 JSON 现在约 6 KB（各平台八项加上 SDK 兼容表）；给到 256 KB，再大就不是它了。
const pinLiteralLimitChars = 256 * 1024
const pinMarker = 'JSON.parse(\'{"version":"'
const pinMarkerBytes = Buffer.from(pinMarker, 'latin1')
const pinVersionPattern = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/
const checksumPattern = /^[0-9a-f]{64}$/
const buildIdLength = 12
const tarBlock = 512
// 包里只有 LICENSE.md、README.md、package.json、claude.exe 四样；多出一大堆就不是我们认得的那种包。
const tarEntryLimit = 64
const tarMetadataLimitBytes = 64 * 1024
// 2.1.309 实测（11-03 GitHub 的 Windows 机器）：claude.exe 298 MB，npm 包 136 MB；2.1.317 的 claude.exe 是 338 MB。
const tarballLimitBytes = 768 * 1024 * 1024
const binaryLimitBytes = 1024 * 1024 * 1024
const binaryMinimumBytes = 1024 * 1024
const npmMetadataLimitBytes = 256 * 1024
const npmMetadataTimeoutMs = 20_000
const tarballRedirectLimit = 3
const markerLimitBytes = 4 * 1024
// 下完要等它退出、放进去之前那次「开着没有」：一个 PowerShell，给 20 秒。
const runningProbeTimeoutMs = 20_000
/** 一次最多为这件事等多久：包约 136 MB，按每秒 150 KB 刚好下得完；再慢就先照常打开，下次再放。 */
export const claudeDesktopCodeSeedTimeoutMs = 15 * 60_000
const temporaryNamePattern = /^claude\.exe\.xingmang-[0-9a-f-]{36}\.(?:tgz|tmp)$/

class SeedSkip extends Error {
  constructor(readonly reason: ClaudeDesktopCodeSeedSkipReason, message: string, readonly detail?: Record<string, unknown>) {
    super(message)
    this.name = 'SeedSkip'
  }
}

/**
 * Claude 要哪个平台那一项。商店版的安装位置里写着包的架构（x64 跑在 arm64 电脑上也写 x64，Claude 按自己进程的
 * 架构要），认不出就按星芒自己的架构猜：猜错了只是放进一个它不看的编号目录，不碍事。
 */
export function claudeCodeSeedPlatform(installationPath: string, architecture: string): ClaudeCodeSeedPlatform | null {
  const store = installationPath.replace(/\//g, '\\').match(/\\WindowsApps\\Claude_\d+(?:\.\d+){3}_(x64|arm64|neutral)__pzs8sxrjxfjjc\\app\\Claude\.exe$/i)
  const packaged = store?.[1]?.toLowerCase()
  const resolved = packaged && packaged !== 'neutral' ? packaged : architecture
  if (resolved === 'x64') return 'win32-x64'
  if (resolved === 'arm64') return 'win32-arm64'
  return null
}

/** Claude.exe 旁边 resources\app.asar：商店版是 `<安装位置>\app\resources\app.asar`。 */
export function claudeDesktopAsarPath(installationPath: string): string {
  return path.win32.join(path.win32.dirname(installationPath), 'resources', 'app.asar')
}

/**
 * asar 开头 8 个字节是一个 Chromium Pickle：先写负载长度 4，再写后面那个头的字节数。头紧跟着它，文件内容从
 * `8 + 头的字节数` 开始。
 */
export function parseAsarSizePrefix(prefix: Buffer, fileSize: number): number {
  if (prefix.length < 8 || prefix.readUInt32LE(0) !== 4) throw new Error('asar-prefix')
  const headerSize = prefix.readUInt32LE(4)
  if (headerSize < 8 || headerSize > asarHeaderLimitBytes || 8 + headerSize > fileSize) throw new Error('asar-header-size')
  return headerSize
}

/** 头也是一个 Pickle：负载长度，再一个带长度的字符串，就是文件表那段 JSON。 */
export function parseAsarHeaderJson(header: Buffer): string {
  if (header.length < 8) throw new Error('asar-header')
  const payload = header.readUInt32LE(0)
  const length = header.readUInt32LE(4)
  if (payload + 4 > header.length || length + 4 > payload) throw new Error('asar-header')
  return header.subarray(8, 8 + length).toString('utf8')
}

export interface AsarScriptEntry {
  name: string
  offset: number
  size: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/**
 * 文件表里 `.vite/build/` 这一层的 .js（不往下翻）：打进包里的、大小在上限以内的才算，大的排前面——4.4212.0 里
 * 那段写在最大的那个 index.chunk 里。
 */
export function listAsarBuildScripts(index: unknown, dataBytes: number): AsarScriptEntry[] {
  const vite = asRecord(asRecord(asRecord(index)?.files)?.['.vite'])
  const build = asRecord(asRecord(vite?.files)?.build)
  const files = asRecord(build?.files)
  if (!files) return []
  const entries: AsarScriptEntry[] = []
  for (const [name, value] of Object.entries(files)) {
    const entry = asRecord(value)
    if (!entry || !/^[A-Za-z0-9._-]{1,128}\.js$/.test(name) || entry.unpacked === true || entry.files || entry.link) continue
    const size = entry.size
    const offset = typeof entry.offset === 'string' && /^\d{1,15}$/.test(entry.offset) ? Number(entry.offset) : NaN
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > asarScriptLimitBytes) continue
    if (!Number.isSafeInteger(offset) || offset + size > dataBytes) continue
    entries.push({ name, offset, size })
  }
  return entries.sort((left, right) => right.size - left.size || left.name.localeCompare(right.name)).slice(0, asarScanLimitFiles)
}

function hexValue(text: string): number | null {
  return /^[0-9a-fA-F]+$/.test(text) ? Number.parseInt(text, 16) : null
}

/**
 * 从 `start`（开头那个单引号的后一位）读一段 JavaScript 单引号字符串，按 JavaScript 的转义规则还原。读到没转义的
 * 单引号就结束；碰到换行、八进制转义、写坏的转义、超过上限，一律当读不出（null），不猜。
 */
export function decodeSingleQuotedLiteral(text: string, start: number, maximumLength = pinLiteralLimitChars): string | null {
  const parts: string[] = []
  let run = start
  let index = start
  while (index < text.length && index - start <= maximumLength) {
    const character = text[index]
    if (character === '\'') {
      parts.push(text.slice(run, index))
      return parts.join('')
    }
    if (character === '\n' || character === '\r' || character === '\u2028' || character === '\u2029') return null
    if (character !== '\\') {
      index += 1
      continue
    }
    parts.push(text.slice(run, index))
    const escaped = text[index + 1]
    if (escaped === undefined) return null
    let consumed = 2
    switch (escaped) {
      case 'n': parts.push('\n'); break
      case 'r': parts.push('\r'); break
      case 't': parts.push('\t'); break
      case 'b': parts.push('\b'); break
      case 'f': parts.push('\f'); break
      case 'v': parts.push('\v'); break
      case '0':
        if (/[0-9]/.test(text[index + 2] ?? '')) return null
        parts.push('\0')
        break
      case 'x': {
        const code = hexValue(text.slice(index + 2, index + 4))
        if (code === null || text.slice(index + 2, index + 4).length !== 2) return null
        parts.push(String.fromCharCode(code))
        consumed = 4
        break
      }
      case 'u': {
        if (text[index + 2] === '{') {
          const close = text.indexOf('}', index + 3)
          const code = close > index + 3 && close - index <= 10 ? hexValue(text.slice(index + 3, close)) : null
          if (code === null || code > 0x10ffff) return null
          parts.push(String.fromCodePoint(code))
          consumed = close - index + 1
        } else {
          const digits = text.slice(index + 2, index + 6)
          const code = digits.length === 4 ? hexValue(digits) : null
          if (code === null) return null
          parts.push(String.fromCharCode(code))
          consumed = 6
        }
        break
      }
      case '\r':
        consumed = text[index + 2] === '\n' ? 3 : 2
        break
      case '\n':
      case '\u2028':
      case '\u2029':
        break
      default:
        if (/[1-9]/.test(escaped)) return null
        parts.push(escaped)
    }
    index += consumed
    run = index
  }
  return null
}

/** 解出来的那份是不是 Claude Code 的版本清单，是就取当前平台那一项。形状对不上（Claude 改了放法）给 null。 */
export function parseClaudeCodeBuildPin(json: string, platform: ClaudeCodeSeedPlatform): ClaudeCodeBuildPin | null {
  let parsed: unknown
  try { parsed = JSON.parse(json) as unknown }
  catch { return null }
  const record = asRecord(parsed)
  const manifest = asRecord(record?.manifest)
  const version = record?.version
  if (typeof version !== 'string' || !pinVersionPattern.test(version) || !manifest) return null
  if (manifest.version !== undefined && manifest.version !== version) return null
  const entry = asRecord(asRecord(manifest.platforms)?.[platform])
  if (!entry) return null
  // 带 bundle 的那种（Mac 的 claude.app）放法不一样；Windows 哪天也改成那样，就不是这里会放的东西了。
  if (entry.bundle !== undefined) return null
  const binary = entry.binary
  const checksum = entry.checksum
  const size = entry.size
  if (binary !== 'claude.exe.zst' && binary !== 'claude.exe') return null
  if (typeof checksum !== 'string' || !checksumPattern.test(checksum)) return null
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > binaryLimitBytes) return null
  return { version, platform, checksum, binary, size }
}

/** 在一段脚本里找那份清单：同一个写法的 JSON.parse 不止一处（工作区那份也是），一处一处试，只认形状对的。 */
export function findClaudeCodeBuildPin(text: string, platform: ClaudeCodeSeedPlatform): ClaudeCodeBuildPin | null {
  let from = 0
  while (from < text.length) {
    const at = text.indexOf(pinMarker, from)
    if (at < 0) return null
    const literal = decodeSingleQuotedLiteral(text, at + 'JSON.parse(\''.length)
    const pin = literal === null ? null : parseClaudeCodeBuildPin(literal, platform)
    if (pin) return pin
    from = at + pinMarker.length
  }
  return null
}

async function readExactly(handle: fs.promises.FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled)
    if (bytesRead <= 0) throw new Error('asar-truncated')
    filled += bytesRead
  }
  return buffer
}

/**
 * 只读、限大小地从 Claude 的 app.asar 里找那份清单：先读文件表，再按大小从大到小读 `.vite/build/` 下的脚本，
 * 读到就停。整份 asar 约 58 MB，这一步通常只读一个约 7 MB 的脚本。找不到给 null。
 */
export async function readClaudeCodeBuildPin(asarPath: string, platform: ClaudeCodeSeedPlatform): Promise<ClaudeCodeBuildPin | null> {
  const handle = await fs.promises.open(asarPath, 'r')
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw new Error('asar-not-file')
    const headerSize = parseAsarSizePrefix(await readExactly(handle, 8, 0), stats.size)
    const index = JSON.parse(parseAsarHeaderJson(await readExactly(handle, headerSize, 8))) as unknown
    const dataStart = 8 + headerSize
    let scanned = 0
    for (const script of listAsarBuildScripts(index, stats.size - dataStart)) {
      if (scanned + script.size > asarScanLimitBytes) break
      scanned += script.size
      const content = await readExactly(handle, script.size, dataStart + script.offset)
      const at = content.indexOf(pinMarkerBytes)
      if (at < 0) continue
      const pin = findClaudeCodeBuildPin(content.subarray(at).toString('utf8'), platform)
      if (pin) return pin
    }
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** 照 Claude 自己的算法拼出它会去找的那几个位置；版本号和 checksum 先过格式，防路径穿越。 */
export function claudeCodeSeedPaths(profileDirectory: string, pin: Pick<ClaudeCodeBuildPin, 'version' | 'checksum'>, paths: path.PlatformPath = path.win32): ClaudeCodeSeedPaths {
  if (!pinVersionPattern.test(pin.version) || !checksumPattern.test(pin.checksum)) throw new Error('Claude Code 版本号或校验值格式无效')
  const storageDirectory = paths.join(profileDirectory, 'claude-code')
  const versionDirectory = paths.join(storageDirectory, pin.version)
  const installDirectory = paths.join(versionDirectory, pin.checksum.slice(0, buildIdLength))
  const relative = paths.relative(storageDirectory, installDirectory)
  if (!relative || relative.startsWith('..') || paths.isAbsolute(relative)) throw new Error('Claude Code 放置位置超出了 Claude 的数据目录')
  return {
    storageDirectory,
    versionDirectory,
    installDirectory,
    binaryPath: paths.join(installDirectory, 'claude.exe'),
    payloadPath: paths.join(installDirectory, '.payload'),
    verifiedPath: paths.join(installDirectory, '.verified'),
  }
}

export function claudeCodeNpmPackageName(platform: ClaudeCodeSeedPlatform): string {
  return `@anthropic-ai/claude-code-${platform}`
}

/** npm 的固定写法：`<源>/@scope/name/-/name-<版本>.tgz`。不用镜像元数据里给的地址，地址由我们自己拼。 */
export function claudeCodeTarballUrl(registry: string, packageName: string, version: string): string {
  const bare = packageName.slice(packageName.indexOf('/') + 1)
  return `${registry.replace(/\/+$/, '')}/${packageName}/-/${bare}-${version}.tgz`
}

/**
 * 下载这一路认的地址：两个 npm 源上这一个包这一版的那个文件，和国内镜像跳去的 CDN 上同一个文件。别的主机、别的
 * 路径、带账号端口参数的一律拒绝（I10）。内容最后还要跟官方源的 SHA-512 对得上，这一层是多一道防线。
 */
export function validateClaudeCodeTarballUrl(candidate: string, packageName: string, version: string): URL {
  let url: URL
  try { url = new URL(candidate) }
  catch { throw new Error('Claude Code 程序下载地址格式无效') }
  const bare = packageName.slice(packageName.indexOf('/') + 1)
  const file = `${bare}-${version}.tgz`
  const registryPath = `/${packageName}/-/${file}`
  // 镜像 302 去 CDN 时 scope 前那个 @ 写成 %40（11-03 实测 Location 就是这样）：解开以后整段跟预期逐字相同才算，解不开的直接拒。
  let pathname: string | null
  try { pathname = decodeURIComponent(url.pathname) }
  catch { pathname = null }
  const allowed = (url.hostname === 'registry.npmmirror.com' && pathname === registryPath)
    || (url.hostname === 'registry.npmjs.org' && pathname === registryPath)
    || (url.hostname === 'cdn.npmmirror.com' && pathname === `/packages/${packageName}/${version}/${file}`)
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || !allowed) {
    throw new Error('Claude Code 程序下载重定向到了没核实过的地址')
  }
  return url
}

export interface ClaudeCodeNpmRelease {
  /** 官方源给的 SHA-512（64 字节）。 */
  sha512: Buffer
  /** 官方源给的解开后总字节数；没给就是 null，按默认上限。 */
  unpackedSize: number | null
}

/** npm 官方源那一版的元数据：名字、版本得对，SHA-512 得是 64 字节，才拿来对账。 */
export function parseClaudeCodeNpmRelease(body: string, packageName: string, version: string): ClaudeCodeNpmRelease | null {
  let parsed: unknown
  try { parsed = JSON.parse(body) as unknown }
  catch { return null }
  const record = asRecord(parsed)
  const dist = asRecord(record?.dist)
  if (record?.name !== packageName || record?.version !== version || !dist) return null
  const integrity = typeof dist.integrity === 'string' ? dist.integrity.trim().match(/^sha512-([A-Za-z0-9+/]{86}==)$/) : null
  if (!integrity) return null
  const sha512 = Buffer.from(integrity[1], 'base64')
  if (sha512.length !== 64) return null
  const unpacked = dist.unpackedSize
  const unpackedSize = typeof unpacked === 'number' && Number.isSafeInteger(unpacked) && unpacked > 0 && unpacked <= binaryLimitBytes ? unpacked : null
  return { sha512, unpackedSize }
}

function tarString(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end < 0 ? slice.length : end).toString('utf8')
}

function tarNumber(block: Buffer, start: number, length: number): number | null {
  const raw = tarString(block, start, length).trim()
  if (!/^[0-7]{1,12}$/.test(raw)) return raw === '' ? 0 : null
  const value = Number.parseInt(raw, 8)
  return Number.isSafeInteger(value) ? value : null
}

function tarChecksumValid(block: Buffer): boolean {
  const recorded = tarNumber(block, 148, 8)
  if (recorded === null) return false
  let sum = 0
  for (let index = 0; index < tarBlock; index += 1) sum += index >= 148 && index < 156 ? 0x20 : block[index]
  return sum === recorded
}

/** pax 扩展头里的 path、size 两项（`<长度> <键>=<值>\n` 一条一条）。别的键不管。 */
export function parsePaxRecords(content: Buffer): { path?: string; size?: number } | null {
  const result: { path?: string; size?: number } = {}
  let offset = 0
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset)
    if (space < 0) return null
    const length = Number(content.subarray(offset, space).toString('latin1'))
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > content.length) return null
    const record = content.subarray(space + 1, offset + length).toString('utf8')
    if (!record.endsWith('\n')) return null
    const equals = record.indexOf('=')
    if (equals < 0) return null
    const key = record.slice(0, equals)
    const value = record.slice(equals + 1, -1)
    if (key === 'path') result.path = value
    if (key === 'size') {
      if (!/^\d{1,15}$/.test(value)) return null
      result.size = Number(value)
    }
    offset += length
  }
  return result
}

export interface TarEntryResult {
  found: boolean
  size: number
}

/**
 * 边解压边从 tar 里取出名叫 `entryName` 的那一个普通文件，交给 `write`；别的条目只数着跳过。不认得的头（校验和
 * 不对、链接、目录以外的怪类型叫这个名字）、同名出现两次、条目太多、超过上限，一律报错。只读、不落盘任何别的条目。
 */
export async function extractTarEntry(
  source: AsyncIterable<Buffer | Uint8Array | string>,
  entryName: string,
  write: (chunk: Buffer) => Promise<void>,
  maximumBytes: number,
): Promise<TarEntryResult> {
  let pending = Buffer.alloc(0)
  let state: 'header' | 'body' | 'meta' | 'end' = 'header'
  let remaining = 0
  let padding = 0
  let target = false
  let metaKind: 'pax' | 'longname' | 'skip' = 'skip'
  let meta: Buffer[] = []
  let metaBytes = 0
  let nextPath: string | undefined
  let nextSize: number | undefined
  let entries = 0
  let zeroBlocks = 0
  let found = false
  let size = 0
  let consumed = 0
  // 不是要的那几个条目也要解压着跳过去：总量也设个顶，免得一个压缩炸弹把 CPU 白白耗上几分钟。
  const totalLimit = maximumBytes + tarEntryLimit * tarMetadataLimitBytes + 16 * 1024 * 1024

  function startEntry(block: Buffer): void {
    if (!tarChecksumValid(block)) throw new Error('程序包里的文件头校验不对')
    entries += 1
    if (entries > tarEntryLimit) throw new Error('程序包里的文件太多')
    const type = String.fromCharCode(block[156] || 0x30)
    const prefix = tarString(block, 345, 155)
    const baseName = tarString(block, 0, 100)
    const name = nextPath ?? (prefix ? `${prefix}/${baseName}` : baseName)
    const declared = nextSize ?? tarNumber(block, 124, 12)
    nextPath = undefined
    nextSize = undefined
    if (declared === null || declared < 0) throw new Error('程序包里的文件大小读不出来')
    remaining = declared
    padding = (tarBlock - (declared % tarBlock)) % tarBlock
    if (type === 'x' || type === 'L' || type === 'g') {
      if (declared > tarMetadataLimitBytes) throw new Error('程序包里的扩展头太大')
      metaKind = type === 'x' ? 'pax' : type === 'L' ? 'longname' : 'skip'
      meta = []
      metaBytes = 0
      state = remaining > 0 ? 'meta' : 'header'
      if (remaining === 0 && padding === 0) finishMeta()
      return
    }
    target = name === entryName
    if (target) {
      if (found) throw new Error('程序包里有两个同名的程序')
      if (type !== '0' && type !== '\0') throw new Error('程序包里的程序不是普通文件')
      if (declared > maximumBytes) throw new Error('程序包里的程序超过安全上限')
      found = true
    }
    state = remaining > 0 || padding > 0 ? 'body' : 'header'
  }

  function finishMeta(): void {
    const content = Buffer.concat(meta)
    if (metaKind === 'pax') {
      const records = parsePaxRecords(content)
      if (!records) throw new Error('程序包里的扩展头读不出来')
      nextPath = records.path ?? nextPath
      nextSize = records.size ?? nextSize
    } else if (metaKind === 'longname') {
      const end = content.indexOf(0)
      nextPath = content.subarray(0, end < 0 ? content.length : end).toString('utf8')
    }
    meta = []
    metaBytes = 0
  }

  // 读到结尾那两个空块以后也要接着读完：调用方边读边算整个包的 SHA-512，中途停下就算不全。
  for await (const raw of source) {
    let chunk: Buffer = typeof raw === 'string' ? Buffer.from(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    consumed += chunk.length
    if (consumed > totalLimit) throw new Error('程序包解开后超过安全上限')
    while (chunk.length > 0 && state !== 'end') {
      if (state === 'header') {
        const need = tarBlock - pending.length
        pending = Buffer.concat([pending, chunk.subarray(0, need)])
        chunk = chunk.subarray(need)
        if (pending.length < tarBlock) break
        const block = pending
        pending = Buffer.alloc(0)
        if (block.every((byte) => byte === 0)) {
          zeroBlocks += 1
          if (zeroBlocks >= 2) state = 'end'
          continue
        }
        zeroBlocks = 0
        startEntry(block)
        continue
      }
      if (remaining > 0) {
        const take = Math.min(remaining, chunk.length)
        const part = chunk.subarray(0, take)
        chunk = chunk.subarray(take)
        remaining -= take
        if (state === 'meta') {
          metaBytes += part.length
          if (metaBytes > tarMetadataLimitBytes) throw new Error('程序包里的扩展头太大')
          meta.push(Buffer.from(part))
        } else if (target) {
          size += part.length
          if (size > maximumBytes) throw new Error('程序包里的程序超过安全上限')
          await write(Buffer.from(part))
        }
        if (remaining > 0) continue
      }
      if (padding > 0) {
        const skip = Math.min(padding, chunk.length)
        chunk = chunk.subarray(skip)
        padding -= skip
        if (padding > 0) continue
      }
      if (state === 'meta') finishMeta()
      target = false
      state = 'header'
    }
  }
  if (state !== 'end' && (state !== 'header' || pending.length > 0)) throw new Error('程序包不完整')
  return { found, size }
}

async function readSmallFile(filePath: string): Promise<string | null> {
  try {
    const stats = await fs.promises.lstat(filePath)
    if (!stats.isFile() || stats.size > markerLimitBytes) return null
    return await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return null
  }
}

async function isNonEmptyFile(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.lstat(filePath)
    return stats.isFile() && stats.size > 0
  } catch {
    return false
  }
}

/**
 * Claude 启动时会认的那一份在不在：编号目录里程序在、`.verified` 对得上；老版本直接装在版本目录、`.verified`
 * 也对得上的同样算（它自己会挪进编号目录）。
 */
export async function inspectClaudeCodeSeed(paths: ClaudeCodeSeedPaths, checksum: string, pathModule: path.PlatformPath = path.win32): Promise<'present' | 'missing'> {
  if ((await readSmallFile(paths.verifiedPath))?.trim() === checksum && await isNonEmptyFile(paths.binaryPath)) return 'present'
  const legacyVerified = pathModule.join(paths.versionDirectory, '.verified')
  const legacyBinary = pathModule.join(paths.versionDirectory, 'claude.exe')
  if ((await readSmallFile(legacyVerified))?.trim() === checksum && await isNonEmptyFile(legacyBinary)) return 'present'
  return 'missing'
}

/** 上回没放完（星芒中途被关掉）留在编号目录里的临时文件：只认我们自己起的名字。 */
async function removeStaleTemporaryFiles(directory: string): Promise<void> {
  let names: string[]
  try { names = await fs.promises.readdir(directory) }
  catch { return }
  for (const name of names.filter((entry) => temporaryNamePattern.test(entry)).slice(0, 16)) {
    await removeSafeDataFile(path.join(directory, name), 'Claude Code 临时文件').catch(() => undefined)
  }
}

function sha512Tap(hash: ReturnType<typeof createHash>): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    },
  })
}

interface ExtractedBinary {
  sha256: string
  size: number
}

/**
 * 一遍读完下好的包：边算整个包的 SHA-512，边解压取出 claude.exe 写进临时文件、算它的 sha256。SHA-512 对不上
 * 官方源的，取出来的东西当场作废（调用方删掉临时文件），不会放进 Claude 的文件夹。
 */
export async function verifyAndExtractClaudeCodeTarball(
  tarballPath: string,
  destination: string,
  release: ClaudeCodeNpmRelease,
  signal?: AbortSignal,
): Promise<ExtractedBinary> {
  const tarballHash = createHash('sha512')
  const binaryHash = createHash('sha256')
  const limit = release.unpackedSize ?? binaryLimitBytes
  const output = await fs.promises.open(destination, 'wx', 0o700)
  let result: TarEntryResult = { found: false, size: 0 }
  let written = 0
  try {
    await pipeline(
      fs.createReadStream(tarballPath, { highWaterMark: 1024 * 1024 }),
      sha512Tap(tarballHash),
      zlib.createGunzip(),
      async (source: AsyncIterable<Buffer>) => {
        result = await extractTarEntry(source, 'package/claude.exe', async (chunk) => {
          binaryHash.update(chunk)
          let offset = 0
          while (offset < chunk.length) {
            const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset, written + offset)
            if (bytesWritten <= 0) throw new Error('Claude Code 程序写入磁盘失败')
            offset += bytesWritten
          }
          written += chunk.length
        }, limit)
      },
      { signal },
    )
    await output.sync()
  } finally {
    await output.close().catch(() => undefined)
  }
  if (!tarballHash.digest().equals(release.sha512)) throw new Error('下载的 Claude Code 程序包与 npm 官方源的 SHA-512 不一致')
  if (!result.found) throw new Error('程序包里没有 claude.exe')
  if (result.size < binaryMinimumBytes) throw new Error('程序包里的 claude.exe 太小')
  const head = Buffer.alloc(2)
  const check = await fs.promises.open(destination, 'r')
  try { await check.read(head, 0, 2, 0) }
  finally { await check.close().catch(() => undefined) }
  if (head.toString('latin1') !== 'MZ') throw new Error('程序包里的 claude.exe 不是 Windows 程序')
  return { sha256: binaryHash.digest('hex'), size: result.size }
}

export interface ClaudeDesktopCodeSeederOptions {
  platform: NodeJS.Platform
  architecture: string
  executionMode: WindowsCliExecutionMode
  /** 下载用的 fetch（system-service 传接好系统代理、跳转一跳一跳交回来的那个）。 */
  fetch: typeof fetch
  /** 这份安装的 Claude 数据目录（Claude-3p，商店版可能被挪进 Packages 底下，见 claude-desktop-paths.ts）。 */
  resolveProfileDirectory(installationPath: string): Promise<string>
  /** 远程开关关了这件事（remote-features.ts 的 claude-desktop-code-seed）。 */
  isOff?(): boolean
  /** 包从哪几个源下，先后照这个顺序；缺省国内镜像在前、官方源兜底。对账值永远只从官方源取。 */
  tarballRegistries?: readonly string[]
  readDiskSpace?(target: string): Promise<DiskSpaceReading | null>
  readBuildPin?(asarPath: string, platform: ClaudeCodeSeedPlatform): Promise<ClaudeCodeBuildPin | null>
  /** 测试用：app.asar 在哪（缺省 Claude.exe 旁边的 resources\app.asar）。 */
  resolveAsarPath?(installationPath: string): string
  /** 每次最多等多久，缺省 claudeDesktopCodeSeedTimeoutMs。 */
  timeoutMs?: number
  /** 测试用：路径怎么拼（缺省 path.win32）。 */
  pathModule?: path.PlatformPath
  userHome: string
  onProgress?(event: ClaudeDesktopCodeSeedProgress): void
  log?(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void
  now?(): number
  /** 测试用：下载断了以后等多久再接着下。 */
  resumeDelaysMs?: readonly number[]
}

export interface ClaudeDesktopCodeSeeder {
  /** 永不抛错：调用方拿到什么结果都照常打开 Claude。 */
  prepare(client: ClaudeDesktopSeedClient): Promise<ClaudeDesktopCodeSeedOutcome>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withTimeout<T>(operation: Promise<T>, milliseconds: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), milliseconds)
    timer.unref?.()
    operation.then((value) => { clearTimeout(timer); resolve(value) }, () => { clearTimeout(timer); resolve(fallback) })
  })
}

export function createClaudeDesktopCodeSeeder(options: ClaudeDesktopCodeSeederOptions): ClaudeDesktopCodeSeeder {
  const paths = options.pathModule ?? path.win32
  const registries = options.tarballRegistries ?? [npmMirrorRegistry, npmOfficialRegistry]
  const timeoutMs = options.timeoutMs ?? claudeDesktopCodeSeedTimeoutMs
  const now = options.now ?? Date.now
  const readPin = options.readBuildPin ?? readClaudeCodeBuildPin
  const diskSpace = options.readDiskSpace ?? ((target: string) => readDiskSpace(target))
  // 同一份 app.asar（路径、大小、修改时间都没变）读出来的那一版记着，不用每次打开都再读一遍几 MB 的脚本。
  const pins = new Map<string, { stamp: string; pin: ClaudeCodeBuildPin | null }>()
  // 这次运行里已经认过「放好了」的那几版：不再每次打开都记一行。
  const reportedPresent = new Set<string>()
  let inFlight: Promise<ClaudeDesktopCodeSeedOutcome> | null = null

  function log(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void {
    try { options.log?.(level, event, message, detail) }
    catch { /* 记日志失败不能挡住打开。 */ }
  }

  function redact(value: string): string {
    return redactHomeDirectory(value, options.userHome, 'win32')
  }

  function progress(event: ClaudeDesktopCodeSeedProgress): void {
    try { options.onProgress?.(event) }
    catch { /* 界面断开了不影响放程序。 */ }
  }

  async function pinFor(asarPath: string, platform: ClaudeCodeSeedPlatform): Promise<ClaudeCodeBuildPin | null> {
    let stats: fs.Stats
    try { stats = await fs.promises.stat(asarPath) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      throw new SeedSkip(code === 'ENOENT' ? 'asar-missing' : 'asar-unreadable', '读不到 Claude Desktop 的程序文件', { asar: redact(asarPath), code })
    }
    const stamp = `${stats.size}:${stats.mtimeMs}:${platform}`
    const cached = pins.get(asarPath)
    if (cached?.stamp === stamp) return cached.pin
    let pin: ClaudeCodeBuildPin | null
    try { pin = await readPin(asarPath, platform) }
    catch (error) {
      throw new SeedSkip('asar-unreadable', '读不出 Claude Desktop 要的 Claude Code 版本', { asar: redact(asarPath), cause: errorMessage(error) })
    }
    pins.set(asarPath, { stamp, pin })
    return pin
  }

  async function fetchRelease(packageName: string, version: string, signal: AbortSignal): Promise<ClaudeCodeNpmRelease> {
    const url = npmPackageVersionUrl(npmOfficialRegistry, packageName, version)
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(npmMetadataTimeoutMs)])
    let body: string
    try {
      const landing = await fetchLandingWithRedirectAllowlist(url, { headers: { Accept: 'application/json' }, credentials: 'omit', signal: requestSignal }, options.fetch, {
        label: 'npm 官方源包元数据',
        validate: (candidate) => {
          const parsed = new URL(candidate)
          if (parsed.href !== new URL(url).href) throw new Error('npm 官方源包元数据不许跳转')
          return parsed
        },
        maximumRedirects: 0,
      })
      if (!landing.response.ok) {
        await landing.response.body?.cancel().catch(() => undefined)
        throw new Error(`npm 官方源 HTTP ${landing.response.status}`)
      }
      body = await readBoundedResponseText(landing.response, npmMetadataLimitBytes, 'npm 官方源包元数据', { guard: { signal: requestSignal } })
    } catch (error) {
      if (signal.aborted) throw error
      throw new SeedSkip('metadata-failed', '拿不到 npm 官方源的对账值，这次不替 Claude Desktop 放程序', { cause: errorMessage(error) })
    }
    const release = parseClaudeCodeNpmRelease(body, packageName, version)
    if (!release) throw new SeedSkip('metadata-failed', 'npm 官方源返回的包名、版本或 SHA-512 无效', { package: packageName, version })
    return release
  }

  async function downloadFrom(registry: string, packageName: string, pin: ClaudeCodeBuildPin, tarballPath: string, signal: AbortSignal): Promise<void> {
    let current = claudeCodeTarballUrl(registry, packageName, pin.version)
    let first = true
    const download = await downloadWithResume({
      targetPath: tarballPath,
      fileMode: 0o600,
      maximumBytes: tarballLimitBytes,
      oversizeMessage: 'Claude Code 程序包超过安全上限',
      signal,
      responseTimeoutMs: 30_000,
      idleTimeoutMs: 45_000,
      ...(options.resumeDelaysMs ? { resumeDelaysMs: options.resumeDelaysMs } : {}),
      request: async (headers, requestSignal) => {
        const landing = await fetchLandingWithRedirectAllowlist(current, {
          headers: { Accept: 'application/octet-stream, */*', ...headers },
          credentials: 'omit',
          signal: requestSignal,
        }, options.fetch, {
          label: 'Claude Code 程序下载',
          validate: (candidate) => validateClaudeCodeTarballUrl(candidate, packageName, pin.version),
          // 接着下时只找上一次落到的那个文件，不再跟跳转（同 claude-desktop-msix-installer.ts）。
          maximumRedirects: first ? tarballRedirectLimit : 0,
          beyondLimit: first ? 'refuse' : 'return',
        })
        first = false
        current = landing.url.href
        return landing.response
      },
      acceptResponse: (response) => {
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
        const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
        if (/^text\/|json|xml|html/.test(contentType)) throw new Error(`返回的不是程序包（Content-Type: ${contentType}）`)
        const declared = response.headers.get('content-length')
        if (declared === null) return null
        const total = Number(declared)
        if (!Number.isSafeInteger(total) || total <= 0) throw new Error('返回的程序包大小无效')
        return total
      },
      onProgress: (transferred, total) => progress({ phase: 'downloading', version: pin.version, transferred, total }),
    })
    if (download.total !== null && download.size !== download.total) throw new Error('程序包没下完')
  }

  async function place(client: ClaudeDesktopSeedClient, pin: ClaudeCodeBuildPin, seedPaths: ClaudeCodeSeedPaths, release: ClaudeCodeNpmRelease, packageName: string, signal: AbortSignal): Promise<'placed' | 'present'> {
    const label = 'Claude Code 程序'
    try {
      ensureSafeDataDirectory(seedPaths.installDirectory, label)
    } catch (error) {
      throw new SeedSkip('write-failed', '建不了 Claude Desktop 放程序的文件夹', { cause: redact(errorMessage(error)) })
    }
    await removeStaleTemporaryFiles(seedPaths.installDirectory)
    const token = randomUUID()
    const tarballPath = paths.join(seedPaths.installDirectory, `claude.exe.xingmang-${token}.tgz`)
    const binaryTemporary = paths.join(seedPaths.installDirectory, `claude.exe.xingmang-${token}.tmp`)
    try {
      let extracted: ExtractedBinary | null = null
      let source: string | null = null
      const failures: string[] = []
      for (const registry of registries) {
        if (signal.aborted) break
        try {
          await downloadFrom(registry, packageName, pin, tarballPath, signal)
          progress({ phase: 'placing', version: pin.version, transferred: 0, total: null })
          extracted = await verifyAndExtractClaudeCodeTarball(tarballPath, binaryTemporary, release, signal)
          source = registry
          break
        } catch (error) {
          failures.push(`${registry === npmMirrorRegistry ? '国内 npm 镜像' : 'npm 官方源'}：${error instanceof DownloadStalledError ? '下载中途没有新数据' : errorMessage(error)}`)
          // 下一个源要用同一个名字重新建（都是只许新建的写法）。
          await fs.promises.rm(binaryTemporary, { force: true }).catch(() => undefined)
        } finally {
          await fs.promises.rm(tarballPath, { force: true }).catch(() => undefined)
        }
      }
      if (signal.aborted) throw new SeedSkip('timeout', '替 Claude Desktop 放程序超过了等待时长，先照常打开，下次打开再放', { failures })
      if (!extracted || !source) throw new SeedSkip('download-failed', '替 Claude Desktop 下程序没下成，照常打开', { failures })
      // 官网给的就是程序本身时，它的 sha256 就是 checksum，顺手对一下。
      if (pin.binary === 'claude.exe' && extracted.sha256 !== pin.checksum) {
        throw new SeedSkip('download-failed', 'npm 上的程序和 Claude Desktop 要的那份不是同一个文件', { version: pin.version })
      }
      // 下的这几分钟里客户可能自己从开始菜单开了 Claude：它开着就不动它的文件夹，下次打开再放。
      const running = client.isRunning ? await withTimeout(client.isRunning(), runningProbeTimeoutMs, null) : null
      if (running === true) throw new SeedSkip('started-meanwhile', 'Claude Desktop 在下载期间被打开了，这次不动它的文件夹')
      if (await inspectClaudeCodeSeed(seedPaths, pin.checksum, paths) === 'present') return 'present'
      try {
        // 照 Claude 自己装的顺序：先撤掉「装完了」的记号，再换程序，最后写记号。
        await removeSafeDataFile(seedPaths.verifiedPath, label)
        await removeSafeDataFile(seedPaths.payloadPath, label)
        await renameWithTransientRetry(binaryTemporary, seedPaths.binaryPath, () => {
          assertNoReparseComponents(seedPaths.installDirectory, label)
          assertSafeDataFile(seedPaths.binaryPath, label)
        })
        await writeAtomicSafeUtf8File(seedPaths.payloadPath, `${JSON.stringify({ sha256: extracted.sha256, size: extracted.size })}\n`, label)
        await writeAtomicSafeUtf8File(seedPaths.verifiedPath, pin.checksum, label)
      } catch (error) {
        throw new SeedSkip('write-failed', '没能把程序放进 Claude Desktop 的文件夹', { cause: redact(errorMessage(error)) })
      }
      log('info', 'claude-desktop.code-seed.placed', '已替 Claude Desktop 放好它要的 Claude Code 程序', {
        version: pin.version, build: pin.checksum.slice(0, buildIdLength), bytes: extracted.size,
        source: source === npmMirrorRegistry ? 'npm-mirror' : 'npm-official',
      })
      return 'placed'
    } finally {
      await fs.promises.rm(tarballPath, { force: true }).catch(() => undefined)
      await fs.promises.rm(binaryTemporary, { force: true }).catch(() => undefined)
    }
  }

  async function prepareNow(client: ClaudeDesktopSeedClient): Promise<ClaudeDesktopCodeSeedOutcome> {
    if (options.platform !== 'win32') throw new SeedSkip('unsupported-platform', '只在 Windows 上替 Claude Desktop 放程序')
    if (options.executionMode !== 'same-user') throw new SeedSkip('not-same-user', '星芒正以管理员身份运行，不往 Claude Desktop 的文件夹里写东西')
    if (options.isOff?.() === true) throw new SeedSkip('remote-off', '替 Claude Desktop 放程序已被远程关掉')
    if (client.running) throw new SeedSkip('running', 'Claude Desktop 开着，这次不动它的文件夹')
    const platform = claudeCodeSeedPlatform(client.path, options.architecture)
    if (!platform) throw new SeedSkip('unsupported-platform', '认不出 Claude Desktop 的处理器架构')
    const asarPath = (options.resolveAsarPath ?? claudeDesktopAsarPath)(client.path)
    const pin = await pinFor(asarPath, platform)
    if (!pin) throw new SeedSkip('pin-not-found', 'Claude Desktop 程序里没找到它要的 Claude Code 版本，可能它换了放法', { asar: redact(asarPath), platform })
    let profileDirectory: string
    try { profileDirectory = await options.resolveProfileDirectory(client.path) }
    catch (error) {
      throw new SeedSkip('profile-unresolved', '找不到 Claude Desktop 的数据目录', { cause: redact(errorMessage(error)) })
    }
    const seedPaths = claudeCodeSeedPaths(profileDirectory, pin, paths)
    if (await inspectClaudeCodeSeed(seedPaths, pin.checksum, paths) === 'present') {
      const key = `${pin.version}:${pin.checksum}`
      if (!reportedPresent.has(key)) {
        reportedPresent.add(key)
        log('info', 'claude-desktop.code-seed.present', 'Claude Desktop 要的 Claude Code 程序已经在了', { version: pin.version, build: pin.checksum.slice(0, buildIdLength) })
      }
      return { status: 'present', version: pin.version }
    }
    const space = await diskSpace(profileDirectory).catch(() => null)
    // 读不到空间照样放行（disk-space.ts 的 fail-open）。程序解开约 300 MB，包约 136 MB，同一道 1 GB 门槛。
    if (space && space.availableBytes < installMinimumFreeBytes) {
      throw new SeedSkip('disk-space', '盘上空间不够，这次不替 Claude Desktop 放程序', { availableBytes: space.availableBytes })
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    timer.unref?.()
    const startedAt = now()
    try {
      const packageName = claudeCodeNpmPackageName(platform)
      const release = await fetchRelease(packageName, pin.version, controller.signal)
      const placed = await place(client, pin, seedPaths, release, packageName, controller.signal)
      if (placed === 'placed') log('info', 'claude-desktop.code-seed.timing', '替 Claude Desktop 放程序用时', { ms: now() - startedAt })
      return { status: placed, version: pin.version }
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof SeedSkip && error.reason === 'timeout')) {
        throw new SeedSkip('timeout', '替 Claude Desktop 放程序超过了等待时长，先照常打开，下次打开再放', { cause: errorMessage(error) })
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    prepare(client) {
      if (inFlight) return inFlight
      const pending = prepareNow(client).catch((error: unknown): ClaudeDesktopCodeSeedOutcome => {
        if (error instanceof SeedSkip) {
          // 这几样是「本来就不该做」，不是出了岔子。
          const quiet = error.reason === 'unsupported-platform' || error.reason === 'running' || error.reason === 'remote-off' || error.reason === 'not-same-user'
          log(quiet ? 'info' : 'warn', 'claude-desktop.code-seed.skipped', error.message, { reason: error.reason, ...error.detail })
          return { status: 'skipped', reason: error.reason }
        }
        log('warn', 'claude-desktop.code-seed.skipped', '替 Claude Desktop 放程序没成，照常打开', { reason: 'write-failed', cause: redact(errorMessage(error)) })
        return { status: 'skipped', reason: 'write-failed' }
      })
      inFlight = pending
      void pending.finally(() => { if (inFlight === pending) inFlight = null })
      return pending
    },
  }
}

/** 工具行上那个百分比：下载时按已下 / 总量取整（0~100）；服务器没说包多大、或者已经在解包时为 null。 */
export function claudeCodeSeedPercent(event: ClaudeDesktopCodeSeedProgress): number | null {
  if (event.phase !== 'downloading' || event.total === null || event.total <= 0) return null
  return Math.min(100, Math.max(0, Math.floor(event.transferred * 100 / event.total)))
}

/** 能收进度的那个窗口（主窗口点「打开」时的 event.sender；同 system-service 的 RendererMessageTarget）。 */
export interface ClaudeCodeSeedProgressTarget {
  isDestroyed(): boolean
  send(channel: string, payload: ExternalClientLaunchProgress): void
}

export interface ClaudeCodeSeedProgressRelay {
  /** 这次「打开」等着的窗口；打开结束（成不成都算）调返回的函数撤掉。 */
  watch(target: ClaudeCodeSeedProgressTarget): () => void
  report(event: ClaudeDesktopCodeSeedProgress): void
}

/**
 * 把放程序的进度转给点了「打开」的窗口。同一次放程序可能被几次「打开」共用（seeder 的 inFlight），
 * 所以按「这会儿谁在等」发，不按是谁先点的。下载时每收到一块数据都报一次，百分比和阶段都没变就不发，
 * 免得一次下载往界面发几千条。
 */
export function createClaudeCodeSeedProgressRelay(): ClaudeCodeSeedProgressRelay {
  const watchers = new Set<{ target: ClaudeCodeSeedProgressTarget }>()
  let lastSent = ''
  return {
    watch(target) {
      const watcher = { target }
      watchers.add(watcher)
      // 新来的窗口还没收过任何一条：下一条不管变没变都发给它。
      lastSent = ''
      return () => { watchers.delete(watcher) }
    },
    report(event) {
      const progress: ExternalClientLaunchProgress = { tool: 'claudeDesktop', phase: event.phase, percent: claudeCodeSeedPercent(event) }
      const key = `${progress.phase}:${progress.percent}`
      if (key === lastSent) return
      lastSent = key
      for (const { target } of watchers) {
        try {
          if (!target.isDestroyed()) target.send('external-clients:launch-progress', progress)
        } catch { /* 界面关了照样放程序。 */ }
      }
    },
  }
}
