import { isUtf8 } from 'node:buffer'
import * as TOML from '@iarna/toml'

/**
 * Codex 自己读不读得了这份 config.toml。读不了时桌面端一启动就停在「无法加载组织设置」，
 * 命令行直接报错退出（2026-10-02 客户报的那个窗）；首页据此说「配置文件坏了」。
 *
 * 只在确定 Codex 也会拒绝时才算坏：本软件用的 @iarna/toml 只懂 TOML 0.5，Codex 读的是
 * TOML 1.1。类型混在一起的数组、跨行或带注释的内联表、\e 与 \x 转义、不带秒的时间、紧挨着
 * 结尾三引号的引号，Codex 都认，@iarna/toml 却报错。拿桌面端 26.930 自带的 Codex
 * （0.159.0-alpha.12.1）逐条比对过，只有下面这几类是两边都拒绝的；别的报错一律不下结论。
 */

// TOML 1.0 与 1.1 在注释、字符串里都不许有的控制字符（Tab 除外），以及后面不跟换行的回车。
// 断电后整份被写成 0 字节的 config.toml 就落在这一条（openai/codex#26421）。
const forbiddenCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]|\r(?!\n)/

// @iarna/toml 报这几类错时 Codex 一样读不了：键或表重复（别的工具追加写出来的）、写到一半
// （字符串没收尾、键没有值）、混进了不认识的字符（合并冲突标记、全角符号、文件中间的 BOM）、
// Windows 路径里的反斜杠没写成两个（"C:\Users" 被当成 \U 转义）。
const codexFatalTomlErrors = [
  "Can't redefine existing key",
  "Can't redefine an existing key",
  "Can't extend an inline array",
  "Can't extend an inline table",
  'Unterminated string',
  'Unterminated multi-line string',
  'Key without value',
  'Key ended without value',
  'Invalid character, expected "="',
  'Unknown character',
  'Invalid character in unicode sequence',
  'Unexpected character, expecting string, number, datetime, boolean, inline array or inline table',
]

// TOML 1.1 新加的转义只有 \e 和 \x；"D:\projects" 里的 \p 这类两边都不认。
const escapesOnlyCodexKnows: ReadonlySet<number> = new Set([0x65, 0x78])

export function isCodexConfigBroken(content: Buffer): boolean {
  // Codex 按严格 UTF-8 读，用 GBK 存过一行中文就整份读不了。解码会把坏字节悄悄换成
  // U+FFFD，所以要在解码之前看。
  if (!isUtf8(content)) return true
  const text = content.toString('utf8').replace(/^\uFEFF/, '')
  if (forbiddenCharacters.test(text)) return true
  try {
    TOML.parse(text)
    return false
  } catch (error) {
    return codexAlsoRejects(error)
  }
}

function codexAlsoRejects(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ''
  const escape = /^Unknown escape character: (\d+)/.exec(message)
  if (escape) return !escapesOnlyCodexKnows.has(Number(escape[1]))
  return codexFatalTomlErrors.some((prefix) => message.startsWith(prefix))
}
