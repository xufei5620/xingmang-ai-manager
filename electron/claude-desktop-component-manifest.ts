/**
 * 从 Claude Desktop 自己的 app.asar 里读出它要的两样组件的清单（2026-11-03 拆 4.4212.0 读到的写法）：
 *
 * - Claude Code 那份：`JSON.parse('{"version":"2.1.309","manifest":{…"platforms":{…}}…}')`。Windows 那一项
 *   claude-desktop-code-seed.ts 已经在读；这里取 Mac 的程序包（`darwin-*` 的 `bundle`）和 Cowork 虚拟机里那份
 *   Linux 版（`linux-*`）。
 * - Cowork 工作区那份：一段对象字面量 `versions:[{sha:"072b…",publishedAt:"2026-10-22",files:{unix:{arm64:[…],
 *   x64:[…]},win32:{arm64:[…],x64:[…]}}},…]`，新的在前（那段注释说旧版留着是为了生成差量）。每个文件
 *   `{name, checksum, size, rawChecksum, rawSize, …}`，checksum 是官网那份 `.zst` 的 sha256。
 *
 * 读法跟 claude-desktop-code-seed.ts 一样只读、限大小：先读文件表，再按大小从大到小读 `.vite/build/` 下的脚本，
 * 两样都找到就停。Claude 换了写法就读不出来（null），调用方什么都不放，交还 Claude 自己去下。
 */
import fs from 'node:fs'
import path from 'node:path'
import { decodeSingleQuotedLiteral, listAsarBuildScripts, parseAsarHeaderJson, parseAsarSizePrefix } from './claude-desktop-code-seed'

export type ClaudeDesktopVmPlatformKey = 'win32' | 'unix'
export type ClaudeDesktopVmArchitecture = 'x64' | 'arm64'
export type ClaudeCodeMacPlatform = 'darwin-arm64' | 'darwin-x64'
export type ClaudeCodeLinuxPlatform = 'linux-x64' | 'linux-arm64'

export interface ClaudeDesktopVmFile {
  /** 解开以后的文件名（rootfs.vhdx、vmlinuz……），官网那份叫 `<name>.zst`。 */
  name: string
  /** 官网 `<name>.zst` 的 sha256。 */
  checksum: string
  /** 官网 `<name>.zst` 的字节数。 */
  size: number
  /** 解开以后的 sha256 和字节数；老清单没有就是 null。 */
  rawChecksum: string | null
  rawSize: number | null
}

export interface ClaudeDesktopVmBundle {
  /** 工作区版本号（40 位十六进制），`.<name>.origin` 里写的就是它。 */
  sha: string
  files: Record<ClaudeDesktopVmPlatformKey, Partial<Record<ClaudeDesktopVmArchitecture, ClaudeDesktopVmFile[]>>>
}

export interface ClaudeCodePackagePin {
  checksum: string
  size: number
}

export interface ClaudeCodeLinuxPin extends ClaudeCodePackagePin {
  /** 官网那份叫什么：claude.zst（checksum 是压缩包的）或 claude。 */
  binary: 'claude.zst' | 'claude'
}

export interface ClaudeCodeComponentPins {
  version: string
  /** Mac 的程序包 `claude.app.tar.zst`（带 Anthropic 签名的小程序包，npm 上的不是同一个文件）。 */
  macBundles: Partial<Record<ClaudeCodeMacPlatform, ClaudeCodePackagePin>>
  /** Cowork 虚拟机里跑的 Linux 版。 */
  linux: Partial<Record<ClaudeCodeLinuxPlatform, ClaudeCodeLinuxPin>>
}

export interface ClaudeDesktopComponentManifest {
  code: ClaudeCodeComponentPins | null
  vm: ClaudeDesktopVmBundle | null
}

const asarScriptScanLimitBytes = 96 * 1024 * 1024
const codeLiteralLimitChars = 256 * 1024
const codeMarker = 'JSON.parse(\'{"version":"'
const codeMarkerBytes = Buffer.from(codeMarker, 'latin1')
const vmMarker = 'versions:[{sha:"'
const vmMarkerBytes = Buffer.from(vmMarker, 'latin1')
// 4.4212.0 那段三个版本、四个平台、每个文件带差量，约 30 KB；给到 512 KB，再大就不是它了。
const vmLiteralLimitChars = 512 * 1024
const literalDepthLimit = 12
const literalNodeLimit = 50_000
const vmVersionLimit = 32
const vmFilesPerArchitectureLimit = 16
// 工作区最大的 rootfs 压缩后约 1.3 GB、解开约 10 GB；再大就当清单不对。
const vmFileLimitBytes = 4 * 1024 * 1024 * 1024
const vmRawFileLimitBytes = 64 * 1024 * 1024 * 1024
const codePackageLimitBytes = 1024 * 1024 * 1024
const versionPattern = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/
const checksumPattern = /^[0-9a-f]{64}$/
const shaPattern = /^[0-9a-f]{40}$/
const vmFileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const reservedKeys = new Set(['__proto__', 'constructor', 'prototype'])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function safeInteger(value: unknown, maximum: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : null
}

class LiteralError extends Error {}

/**
 * 读一段压缩过的 JavaScript 对象/数组字面量：键是标识符或双引号字符串，值只认对象、数组、双引号字符串、数字、
 * true/false/null 和压缩器写的 `!0`/`!1`。别的（函数调用、变量、模板字符串）一律当读不出。深度、节点数、长度都设顶。
 * 返回值和读到哪儿为止（结尾那个括号的后一位）。
 */
export function parseJsLiteral(text: string, start: number, maximumLength = vmLiteralLimitChars): { value: unknown; end: number } | null {
  const limit = Math.min(text.length, start + maximumLength)
  let index = start
  let nodes = 0

  function skipWhitespace(): void {
    while (index < limit && /\s/.test(text[index])) index += 1
  }

  function readString(): string {
    // index 停在开头那个双引号上。
    index += 1
    let result = ''
    while (index < limit) {
      const character = text[index]
      if (character === '"') {
        index += 1
        return result
      }
      if (character === '\n' || character === '\r' || character === ' ' || character === ' ') throw new LiteralError('newline')
      if (character !== '\\') {
        result += character
        index += 1
        continue
      }
      const escaped = text[index + 1]
      if (escaped === undefined) throw new LiteralError('escape')
      if (escaped === 'u') {
        const digits = text.slice(index + 2, index + 6)
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) throw new LiteralError('escape')
        result += String.fromCharCode(Number.parseInt(digits, 16))
        index += 6
        continue
      }
      const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '"': '"', '\'': '\'', '\\': '\\', '/': '/' }
      if (!(escaped in simple)) throw new LiteralError('escape')
      result += simple[escaped]
      index += 2
    }
    throw new LiteralError('unterminated')
  }

  function readKey(): string {
    skipWhitespace()
    if (text[index] === '"') return readString()
    const match = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}/.exec(text.slice(index, Math.min(limit, index + 64)))
    if (!match) throw new LiteralError('key')
    index += match[0].length
    return match[0]
  }

  function readValue(depth: number): unknown {
    if (depth > literalDepthLimit) throw new LiteralError('depth')
    nodes += 1
    if (nodes > literalNodeLimit) throw new LiteralError('nodes')
    skipWhitespace()
    const character = text[index]
    if (character === '{') {
      index += 1
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      skipWhitespace()
      if (text[index] === '}') {
        index += 1
        return result
      }
      while (index < limit) {
        const key = readKey()
        skipWhitespace()
        if (text[index] !== ':') throw new LiteralError('colon')
        index += 1
        const value = readValue(depth + 1)
        if (reservedKeys.has(key) || Object.prototype.hasOwnProperty.call(result, key)) throw new LiteralError('key')
        result[key] = value
        skipWhitespace()
        if (text[index] === ',') {
          index += 1
          continue
        }
        if (text[index] === '}') {
          index += 1
          return result
        }
        throw new LiteralError('object')
      }
      throw new LiteralError('unterminated')
    }
    if (character === '[') {
      index += 1
      const result: unknown[] = []
      skipWhitespace()
      if (text[index] === ']') {
        index += 1
        return result
      }
      while (index < limit) {
        result.push(readValue(depth + 1))
        skipWhitespace()
        if (text[index] === ',') {
          index += 1
          continue
        }
        if (text[index] === ']') {
          index += 1
          return result
        }
        throw new LiteralError('array')
      }
      throw new LiteralError('unterminated')
    }
    if (character === '"') return readString()
    if (text.startsWith('!0', index)) {
      index += 2
      return true
    }
    if (text.startsWith('!1', index)) {
      index += 2
      return false
    }
    for (const [word, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(word, index) && !/[A-Za-z0-9_$]/.test(text[index + word.length] ?? '')) {
        index += word.length
        return value
      }
    }
    const number = /^-?(?:0|[1-9]\d{0,20})(?:\.\d{1,20})?(?:[eE][+-]?\d{1,3})?/.exec(text.slice(index, Math.min(limit, index + 48)))
    if (number && !/[A-Za-z0-9_$.]/.test(text[index + number[0].length] ?? '')) {
      const value = Number(number[0])
      if (!Number.isFinite(value)) throw new LiteralError('number')
      index += number[0].length
      return value
    }
    throw new LiteralError('value')
  }

  try {
    const value = readValue(0)
    return { value, end: index }
  } catch (error) {
    if (error instanceof LiteralError) return null
    throw error
  }
}

function parseVmFile(value: unknown): ClaudeDesktopVmFile | null {
  const record = asRecord(value)
  if (!record) return null
  const name = record.name
  const checksum = record.checksum
  const size = safeInteger(record.size, vmFileLimitBytes)
  if (typeof name !== 'string' || !vmFileNamePattern.test(name) || name.includes('..')) return null
  if (typeof checksum !== 'string' || !checksumPattern.test(checksum) || size === null) return null
  const rawChecksum = typeof record.rawChecksum === 'string' && checksumPattern.test(record.rawChecksum) ? record.rawChecksum : null
  const rawSize = safeInteger(record.rawSize, vmRawFileLimitBytes)
  if (record.rawChecksum !== undefined && rawChecksum === null) return null
  if (record.rawSize !== undefined && rawSize === null) return null
  return { name, checksum, size, rawChecksum, rawSize }
}

function parseVmFiles(value: unknown): ClaudeDesktopVmFile[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > vmFilesPerArchitectureLimit) return null
  const files: ClaudeDesktopVmFile[] = []
  const names = new Set<string>()
  for (const item of value) {
    const file = parseVmFile(item)
    if (!file || names.has(file.name)) return null
    names.add(file.name)
    files.push(file)
  }
  return files
}

/** 清单里一个版本：sha 得对、四个平台里认得的那几项都得完整；有一项写坏了整个版本当读不出。 */
export function parseClaudeDesktopVmVersion(value: unknown): ClaudeDesktopVmBundle | null {
  const record = asRecord(value)
  const files = asRecord(record?.files)
  const sha = record?.sha
  if (typeof sha !== 'string' || !shaPattern.test(sha) || !files) return null
  const result: ClaudeDesktopVmBundle = { sha, files: { win32: {}, unix: {} } }
  let any = false
  for (const platformKey of ['win32', 'unix'] as const) {
    const platform = files[platformKey]
    if (platform === undefined) continue
    const architectures = asRecord(platform)
    if (!architectures) return null
    for (const architecture of ['x64', 'arm64'] as const) {
      if (architectures[architecture] === undefined) continue
      const parsed = parseVmFiles(architectures[architecture])
      if (!parsed) return null
      result.files[platformKey][architecture] = parsed
      any = true
    }
  }
  return any ? result : null
}

/** 在一段脚本里找工作区清单，取最新的那一版（排在最前面的）。找不到、形状对不上给 null。 */
export function findClaudeDesktopVmBundle(text: string): ClaudeDesktopVmBundle | null {
  let from = 0
  while (from < text.length) {
    const at = text.indexOf(vmMarker, from)
    if (at < 0) return null
    const parsed = parseJsLiteral(text, at + 'versions:'.length)
    if (parsed && Array.isArray(parsed.value) && parsed.value.length > 0 && parsed.value.length <= vmVersionLimit) {
      const current = parseClaudeDesktopVmVersion(parsed.value[0])
      if (current) return current
    }
    from = at + vmMarker.length
  }
  return null
}

/** Claude Code 那份清单里 Mac 程序包和 Linux 版那几项。形状对不上给 null；某个平台写坏了只丢那一项。 */
export function parseClaudeCodeComponentPins(json: string): ClaudeCodeComponentPins | null {
  let parsed: unknown
  try { parsed = JSON.parse(json) as unknown }
  catch { return null }
  const record = asRecord(parsed)
  const manifest = asRecord(record?.manifest)
  const version = record?.version
  if (typeof version !== 'string' || !versionPattern.test(version) || !manifest) return null
  if (manifest.version !== undefined && manifest.version !== version) return null
  const platforms = asRecord(manifest.platforms)
  if (!platforms) return null
  const pins: ClaudeCodeComponentPins = { version, macBundles: {}, linux: {} }
  for (const platform of ['darwin-arm64', 'darwin-x64'] as const) {
    const bundle = asRecord(asRecord(platforms[platform])?.bundle)
    const checksum = bundle?.checksum
    const size = safeInteger(bundle?.size, codePackageLimitBytes)
    if (typeof checksum === 'string' && checksumPattern.test(checksum) && size !== null) pins.macBundles[platform] = { checksum, size }
  }
  for (const platform of ['linux-x64', 'linux-arm64'] as const) {
    const entry = asRecord(platforms[platform])
    const binary = entry?.binary
    const checksum = entry?.checksum
    const size = safeInteger(entry?.size, codePackageLimitBytes)
    if ((binary === 'claude.zst' || binary === 'claude') && typeof checksum === 'string' && checksumPattern.test(checksum) && size !== null && entry?.bundle === undefined) {
      pins.linux[platform] = { binary, checksum, size }
    }
  }
  return pins
}

/** 在一段脚本里找 Claude Code 那份清单：同一个写法的 JSON.parse 不止一处，一处一处试，只认形状对的。 */
export function findClaudeCodeComponentPins(text: string): ClaudeCodeComponentPins | null {
  let from = 0
  while (from < text.length) {
    const at = text.indexOf(codeMarker, from)
    if (at < 0) return null
    const literal = decodeSingleQuotedLiteral(text, at + 'JSON.parse(\''.length, codeLiteralLimitChars)
    const pins = literal === null ? null : parseClaudeCodeComponentPins(literal)
    if (pins) return pins
    from = at + codeMarker.length
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

/** 一遍扫完 app.asar 里的脚本，把两份清单都找出来；哪份没找到就是 null。 */
export async function readClaudeDesktopComponentManifest(asarPath: string): Promise<ClaudeDesktopComponentManifest> {
  const handle = await fs.promises.open(asarPath, 'r')
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw new Error('asar-not-file')
    const headerSize = parseAsarSizePrefix(await readExactly(handle, 8, 0), stats.size)
    const index = JSON.parse(parseAsarHeaderJson(await readExactly(handle, headerSize, 8))) as unknown
    const dataStart = 8 + headerSize
    let scanned = 0
    let code: ClaudeCodeComponentPins | null = null
    let vm: ClaudeDesktopVmBundle | null = null
    for (const script of listAsarBuildScripts(index, stats.size - dataStart)) {
      if (code && vm) break
      if (scanned + script.size > asarScriptScanLimitBytes) break
      scanned += script.size
      const content = await readExactly(handle, script.size, dataStart + script.offset)
      if (!code) {
        const at = content.indexOf(codeMarkerBytes)
        if (at >= 0) code = findClaudeCodeComponentPins(content.subarray(at).toString('utf8'))
      }
      if (!vm) {
        const at = content.indexOf(vmMarkerBytes)
        if (at >= 0) vm = findClaudeDesktopVmBundle(content.subarray(at).toString('utf8'))
      }
    }
    return { code, vm }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** Mac 上 Claude.app 里的 app.asar；Windows 上用 claude-desktop-code-seed.ts 的 claudeDesktopAsarPath。 */
export function claudeDesktopMacAsarPath(applicationPath: string): string {
  return path.posix.join(applicationPath, 'Contents', 'Resources', 'app.asar')
}
