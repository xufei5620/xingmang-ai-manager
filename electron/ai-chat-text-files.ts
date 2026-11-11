import path from 'node:path'
import { AI_CHAT_TEXT_FILE_LIMITS, chatTextFileFullMessage } from './ai-chat-protocol'
import type { AiChatTextFile } from './ipc-contract'

// 聊天里附带的文字类文件（Fable 第二轮 Q2 第 1 步）。跟图片一样只从系统的选文件框来，路径在主进程里拿到、
// 读完就丢，渲染层只拿到读出来的字（I15 同一思路）。PDF、Word、Excel 要另加解析库，不在这一步。

// 30,000 个字最多 120 KB（UTF-8 每字最多 4 字节）；读到这么多就够截了，几百 MB 的日志也只读开头这一截。
export const CHAT_TEXT_FILE_READ_BYTES = 256 * 1024

/** 本来就是文字的文件。按扩展名认，选文件框也只列这些；读出来带 NUL 的照样当不是文字。 */
export const chatTextFileExtensions: readonly string[] = [
  'txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'log', 'xml', 'yaml', 'yml', 'ini', 'conf', 'cfg', 'toml',
  'properties', 'html', 'htm', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'py', 'java',
  'kt', 'kts', 'scala', 'groovy', 'gradle', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'm',
  'mm', 'dart', 'lua', 'r', 'pl', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd', 'sql', 'graphql', 'proto', 'diff',
  'patch', 'srt', 'vtt', 'tex', 'rst', 'adoc', 'org',
]
const textFileExtensionSet = new Set(chatTextFileExtensions)

export const chatTextFileUnsupportedMessage = '现在只能读文字类的文件（txt、md、csv、json、代码、日志）。PDF 和 Word 请先把文字复制出来再粘贴。'
export const chatTextFileUnreadableMessage = '这个文件读不出来，可能正被别的软件占着，关掉它再试。'
export { chatTextFileFullMessage }
export function chatTextFileCountMessage(): string { return `一条消息最多带 ${AI_CHAT_TEXT_FILE_LIMITS.filesPerMessage} 个文件` }

export function isChatTextFileName(fileName: string): boolean {
  const extension = path.extname(fileName).slice(1).toLowerCase()
  return extension !== '' && textFileExtensionSet.has(extension)
}

function decodeWith(encoding: string, bytes: Uint8Array, complete: boolean): string | null {
  try {
    // stream: true while the bytes are only the start of the file, so a character cut in half at the
    // end is held back instead of failing the whole file.
    return new TextDecoder(encoding, { fatal: true, ignoreBOM: false }).decode(bytes, { stream: !complete })
  } catch {
    return null
  }
}

/**
 * The file's text, or null when it is not text. UTF-8 first (with or without a BOM), UTF-16 when it
 * starts with that BOM, then GB18030: Excel's CSV and Notepad's ANSI files on Chinese Windows are GBK,
 * which strict UTF-8 refuses. A NUL anywhere means a binary file renamed to .txt.
 */
export function decodeChatTextBytes(bytes: Uint8Array, complete: boolean): string | null {
  let text: string | null
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) text = decodeWith('utf-16le', bytes, complete)
  else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) text = decodeWith('utf-16be', bytes, complete)
  else text = decodeWith('utf-8', bytes, complete) ?? decodeWith('gb18030', bytes, complete)
  if (text === null || text.includes('\u0000')) return null
  return text
}

/** Cuts to at most maxChars without splitting a surrogate pair. */
export function truncateChatText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  let end = Math.max(0, maxChars)
  const last = text.charCodeAt(end - 1)
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1
  return { text: text.slice(0, end), truncated: true }
}

/**
 * Splits the budget so that files shorter than an even share keep all of their text and the rest is
 * shared out evenly among the longer ones, instead of the first long file eating everything.
 */
export function shareChatTextBudget(lengths: readonly number[], budget: number): number[] {
  const shares = lengths.map(() => 0)
  const order = lengths.map((length, index) => ({ length, index })).sort((left, right) => left.length - right.length)
  let left = Math.max(0, budget)
  order.forEach(({ length, index }, position) => {
    shares[index] = Math.min(length, Math.floor(left / (order.length - position)))
    left -= shares[index]
  })
  return shares
}

export interface ChatTextFileRead {
  bytes: Buffer
  /** The whole file's size on disk, which may be more than was read. */
  size: number
  /** True when bytes is the whole file. */
  complete: boolean
}

export interface ChatTextFileServiceOptions {
  /** Opens the native picker and returns absolute paths, or an empty list when canceled. */
  pickFiles(): Promise<string[]>
  /** Reads at most maximumBytes from the start of the file, with the bounded-file checks (single-link regular file, no links on the way). */
  readPrefix(filePath: string, maximumBytes: number): Promise<ChatTextFileRead>
}

export interface ChatTextFileService {
  pick(remainingFiles: number, remainingChars: number): Promise<AiChatTextFile[]>
}

export function createChatTextFileService(options: ChatTextFileServiceOptions): ChatTextFileService {
  async function pick(remainingFiles: number, remainingChars: number): Promise<AiChatTextFile[]> {
    if (!Number.isSafeInteger(remainingFiles) || remainingFiles < 1 || remainingFiles > AI_CHAT_TEXT_FILE_LIMITS.filesPerMessage) {
      throw new Error(chatTextFileCountMessage())
    }
    if (!Number.isSafeInteger(remainingChars) || remainingChars < 1 || remainingChars > AI_CHAT_TEXT_FILE_LIMITS.charsPerMessage) {
      throw new Error(chatTextFileFullMessage)
    }
    const paths = await options.pickFiles()
    if (!paths.length) return []
    if (paths.length > remainingFiles) throw new Error(`这条消息还能加 ${remainingFiles} 个文件，这次选了 ${paths.length} 个，请少选几个`)
    // 先全部读完、查完再交回去，一个读不出来就整批不加，不会加上一半。
    const decoded: { name: string; size: number; text: string; complete: boolean }[] = []
    for (const filePath of paths) {
      const name = path.basename(filePath)
      if (!isChatTextFileName(name)) throw new Error(chatTextFileUnsupportedMessage)
      let read: ChatTextFileRead
      try {
        read = await options.readPrefix(filePath, CHAT_TEXT_FILE_READ_BYTES)
      } catch {
        throw new Error(chatTextFileUnreadableMessage)
      }
      const text = decodeChatTextBytes(read.bytes, read.complete)
      if (text === null) throw new Error(chatTextFileUnsupportedMessage)
      decoded.push({ name, size: read.size, text, complete: read.complete })
    }
    const shares = shareChatTextBudget(decoded.map((file) => file.text.length), remainingChars)
    const files = decoded.map((file, index) => {
      const cut = truncateChatText(file.text, shares[index])
      return { name: file.name, size: file.size, text: cut.text, truncated: cut.truncated || !file.complete }
    })
    // 一个长日志加一个短文件时，短的整份留下、长的截短；字数已经少到连一个字都分不到，才说满了。
    if (files.some((file, index) => file.text.length === 0 && decoded[index].text.length > 0)) throw new Error(chatTextFileFullMessage)
    return files
  }
  return { pick }
}
