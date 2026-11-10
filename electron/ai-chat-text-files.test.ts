import { describe, expect, it, vi } from 'vitest'
import { AI_CHAT_TEXT_FILE_LIMITS } from './ai-chat-protocol'
import {
  CHAT_TEXT_FILE_READ_BYTES,
  chatTextFileFullMessage,
  chatTextFileUnreadableMessage,
  chatTextFileUnsupportedMessage,
  createChatTextFileService,
  decodeChatTextBytes,
  isChatTextFileName,
  shareChatTextBudget,
  truncateChatText,
  type ChatTextFileRead,
} from './ai-chat-text-files'

function whole(text: string | Buffer): ChatTextFileRead {
  const bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : text
  return { bytes, size: bytes.length, complete: true }
}

function serviceFor(files: Record<string, ChatTextFileRead | Error>, picked = Object.keys(files)) {
  const readPrefix = vi.fn(async (filePath: string) => {
    const file = files[filePath]
    if (!file) throw new Error(`unexpected read ${filePath}`)
    if (file instanceof Error) throw file
    return file
  })
  const pickFiles = vi.fn(async () => picked)
  return { service: createChatTextFileService({ pickFiles, readPrefix }), readPrefix, pickFiles }
}

describe('chat text files', () => {
  it('recognizes text files by extension, case-insensitively, and nothing without one', () => {
    expect(isChatTextFileName('notes.md')).toBe(true)
    expect(isChatTextFileName('报表.CSV')).toBe(true)
    expect(isChatTextFileName('main.py')).toBe(true)
    expect(isChatTextFileName('report.pdf')).toBe(false)
    expect(isChatTextFileName('contract.docx')).toBe(false)
    expect(isChatTextFileName('Makefile')).toBe(false)
    expect(isChatTextFileName('.txt')).toBe(false)
  })

  it('decodes UTF-8, UTF-16 with a BOM, and the GBK that Excel and Notepad write on Chinese Windows', () => {
    expect(decodeChatTextBytes(Buffer.from('星芒,1\n', 'utf8'), true)).toBe('星芒,1\n')
    expect(decodeChatTextBytes(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('带 BOM')]), true)).toBe('带 BOM')
    expect(decodeChatTextBytes(Buffer.from([0xff, 0xfe, ...Buffer.from('宽字', 'utf16le')]), true)).toBe('宽字')
    const utf16be = Buffer.from('宽字', 'utf16le').swap16()
    expect(decodeChatTextBytes(Buffer.from([0xfe, 0xff, ...utf16be]), true)).toBe('宽字')
    // 「中文」 in GBK.
    expect(decodeChatTextBytes(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), true)).toBe('中文')
  })

  it('treats a NUL byte as a binary file in disguise', () => {
    expect(decodeChatTextBytes(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), true)).toBeNull()
  })

  it('holds back a character cut in half at the end of a partial read instead of refusing the file', () => {
    const bytes = Buffer.from('ab星', 'utf8')
    expect(decodeChatTextBytes(bytes.subarray(0, 4), false)).toBe('ab')
    expect(decodeChatTextBytes(bytes.subarray(0, 4), true)).not.toBe('ab')
  })

  it('cuts text to the limit without splitting a surrogate pair', () => {
    expect(truncateChatText('abc', 5)).toEqual({ text: 'abc', truncated: false })
    expect(truncateChatText('abcdef', 3)).toEqual({ text: 'abc', truncated: true })
    expect(truncateChatText('a😀b', 2)).toEqual({ text: 'a', truncated: true })
    expect(truncateChatText('a😀b', 3)).toEqual({ text: 'a😀', truncated: true })
  })

  it('hands back each picked file with its name, size and text, reading only the start of it', async () => {
    const { service, readPrefix } = serviceFor({
      '/home/me/notes.md': whole('# 会议记录'),
      '/home/me/data.csv': whole('a,b\n1,2'),
    })
    await expect(service.pick(3, 30_000)).resolves.toEqual([
      { name: 'notes.md', size: 14, text: '# 会议记录', truncated: false },
      { name: 'data.csv', size: 7, text: 'a,b\n1,2', truncated: false },
    ])
    expect(readPrefix).toHaveBeenCalledWith('/home/me/notes.md', CHAT_TEXT_FILE_READ_BYTES)
  })

  it('keeps a short file whole beside a long one and cuts only the long one', async () => {
    const { service } = serviceFor({
      '/long.log': whole('abcdefghij'),
      '/short.txt': whole('12'),
    })
    await expect(service.pick(3, 7)).resolves.toEqual([
      { name: 'long.log', size: 10, text: 'abcde', truncated: true },
      { name: 'short.txt', size: 2, text: '12', truncated: false },
    ])
  })

  it('shares the budget evenly among files longer than an even share', () => {
    expect(shareChatTextBudget([10, 10, 10], 9)).toEqual([3, 3, 3])
    expect(shareChatTextBudget([100, 2, 50], 30)).toEqual([14, 2, 14])
    expect(shareChatTextBudget([3, 4], 100)).toEqual([3, 4])
    expect(shareChatTextBudget([5, 5], 1)).toEqual([0, 1])
  })

  it('marks a file read only in part as cut even when its start fits', async () => {
    const { service } = serviceFor({ '/big.log': { bytes: Buffer.from('start'), size: 10_000_000, complete: false } })
    await expect(service.pick(1, 30_000)).resolves.toEqual([
      { name: 'big.log', size: 10_000_000, text: 'start', truncated: true },
    ])
  })

  it('refuses the whole batch when one file is not text, cannot be read, or the budget runs out', async () => {
    await expect(serviceFor({ '/a.txt': whole('ok'), '/b.pdf': whole('%PDF') }).service.pick(3, 100))
      .rejects.toThrow(chatTextFileUnsupportedMessage)
    await expect(serviceFor({ '/a.txt': whole(Buffer.from([0x41, 0x00])) }).service.pick(3, 100))
      .rejects.toThrow(chatTextFileUnsupportedMessage)
    await expect(serviceFor({ '/a.txt': new Error('EBUSY: resource busy') }).service.pick(3, 100))
      .rejects.toThrow(chatTextFileUnreadableMessage)
    await expect(serviceFor({ '/a.txt': whole('12345'), '/b.txt': whole('67890') }).service.pick(3, 1))
      .rejects.toThrow(chatTextFileFullMessage)
  })

  it('refuses more files than the message has room for, before reading any', async () => {
    const { service, readPrefix } = serviceFor({ '/a.txt': whole('a'), '/b.txt': whole('b') })
    await expect(service.pick(1, 100)).rejects.toThrow('这条消息还能加 1 个文件，这次选了 2 个，请少选几个')
    expect(readPrefix).not.toHaveBeenCalled()
  })

  it('returns nothing when the picker is canceled', async () => {
    const { service } = serviceFor({}, [])
    await expect(service.pick(3, 100)).resolves.toEqual([])
  })

  it('rejects counts and budgets outside the limits without opening the picker', async () => {
    const { service, pickFiles } = serviceFor({ '/a.txt': whole('a') })
    await expect(service.pick(0, 100)).rejects.toThrow(`最多带 ${AI_CHAT_TEXT_FILE_LIMITS.filesPerMessage} 个文件`)
    await expect(service.pick(AI_CHAT_TEXT_FILE_LIMITS.filesPerMessage + 1, 100)).rejects.toThrow('个文件')
    await expect(service.pick(1.5, 100)).rejects.toThrow('个文件')
    await expect(service.pick(1, 0)).rejects.toThrow(chatTextFileFullMessage)
    await expect(service.pick(1, AI_CHAT_TEXT_FILE_LIMITS.charsPerMessage + 1)).rejects.toThrow(chatTextFileFullMessage)
    expect(pickFiles).not.toHaveBeenCalled()
  })
})
