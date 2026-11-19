/**
 * 只读、限大小地读 Claude Desktop 的 app.asar：文件头、文件表、`.vite/build/` 下那几个脚本，再加一个 JavaScript
 * 单引号字符串的还原。Claude 把它要的组件版本和校验值编在这些脚本里（claude-desktop-component-manifest.ts 读），
 * 存储桶同步作业（scripts/sync-claude-components-cos.cjs）和客户端用的是同一份读法。
 *
 * 不解开整个 asar、不运行里面的任何东西；形状不对一律抛错或给空，不猜。
 */

const asarHeaderLimitBytes = 16 * 1024 * 1024
const asarScriptLimitBytes = 32 * 1024 * 1024
const asarScanLimitFiles = 128
// 默认的单个字符串上限；读清单的地方各自传更合适的上限。
const literalLimitChars = 256 * 1024

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
 * 那几段写在最大的那个 index.chunk 里。
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
export function decodeSingleQuotedLiteral(text: string, start: number, maximumLength = literalLimitChars): string | null {
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

