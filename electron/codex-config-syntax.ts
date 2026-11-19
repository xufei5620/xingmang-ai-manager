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
 * 表头、数组、内联表少括号那几句是 2026-11-20 拿命令行 Codex 0.169.0 比对的。
 */

// TOML 1.0 与 1.1 在注释、字符串里都不许有的控制字符（Tab 除外），以及后面不跟换行的回车。
// 断电后整份被写成 0 字节的 config.toml 就落在这一条（openai/codex#26421）。
const forbiddenCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]|\r(?!\n)/

// @iarna/toml 报这几类错时 Codex 一样读不了：键或表重复（别的工具追加写出来的）、写到一半
// （字符串没收尾、键没有值）、混进了不认识的字符（合并冲突标记、全角符号、文件中间的 BOM）、
// Windows 路径里的反斜杠没写成两个（"C:\Users" 被当成 \U 转义）、表头没在该收的地方收住（「[model_providers.x」
// 后面直接换行、「[[a]」只收了一半、表名里夹着没加引号的空格或中文）。
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
  'Unexpected character, expected whitespace, . or ]',
]

// 数组少了 ]、内联表少了 } 时 @iarna/toml 报这两句，可碰上 Codex 认的写法它也报：跨行或带注释的内联表报
// 第二句，数组里紧挨着结尾三引号的引号（["""a"""""]）报第一句。所以这两句只在括号确实没配上时才算坏。
const bracketTomlErrors = [
  'Invalid character, expected whitespace, comma (,) or close bracket (])',
  'Unterminated inline array',
]

// TOML 1.1 新加的转义只有 \e 和 \x；"D:\projects" 里的 \p 这类两边都不认。
const escapesOnlyCodexKnows: ReadonlySet<number> = new Set([0x65, 0x78])

// parse 缺省用 @iarna/toml；看一遍配置时传进来的是同一份内容只解析一遍的那个（config-files.ts）。
export function isCodexConfigBroken(content: Buffer, parse: (text: string) => unknown = TOML.parse): boolean {
  // Codex 按严格 UTF-8 读，用 GBK 存过一行中文就整份读不了。解码会把坏字节悄悄换成
  // U+FFFD，所以要在解码之前看。
  if (!isUtf8(content)) return true
  const text = content.toString('utf8').replace(/^\uFEFF/, '')
  if (forbiddenCharacters.test(text)) return true
  try {
    parse(text)
    return false
  } catch (error) {
    return codexAlsoRejects(error, text)
  }
}

function codexAlsoRejects(error: unknown, text: string): boolean {
  const message = error instanceof Error ? error.message : ''
  const escape = /^Unknown escape character: (\d+)/.exec(message)
  if (escape) return !escapesOnlyCodexKnows.has(Number(escape[1]))
  if (bracketTomlErrors.some((prefix) => message.startsWith(prefix))) return !bracketsPairUp(text)
  return codexFatalTomlErrors.some((prefix) => message.startsWith(prefix))
}

// 字符串、注释以外的方括号和花括号是不是一一配上了。哪一版 TOML 里，字符串和注释以外的括号都是表头、数组、内联表
// 成对的括号，引号和井号也只用来起止字符串和注释，所以只要认得出字符串和注释，读得了的文件就一定配得上；
// 配不上的，Codex 一定读不了。
function bracketsPairUp(text: string): boolean {
  const expectedClosers: string[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '#') {
      const lineEnd = text.indexOf('\n', index)
      index = lineEnd === -1 ? text.length : lineEnd
    } else if (char === '"' || char === "'") {
      index = stringEnd(text, index)
    } else if (char === '[' || char === '{') {
      expectedClosers.push(char === '[' ? ']' : '}')
      index += 1
    } else if (char === ']' || char === '}') {
      if (expectedClosers.pop() !== char) return false
      index += 1
    } else {
      index += 1
    }
  }
  return expectedClosers.length === 0
}

// start 处的引号开头的字符串在哪里结束（返回它后面那个位置）。双引号的认反斜杠转义，单引号的不认；三个引号的
// 可以跨行，结尾最多还能多带两个引号（"""a""""" 里是 a""），一口气连着的引号都算结尾。单行的到行尾还没收尾，
// 文件本来就坏了，算到行尾为止。
function stringEnd(text: string, start: number): number {
  const quote = text[start]
  const triple = quote.repeat(3)
  const multiLine = text.startsWith(triple, start)
  let index = start + (multiLine ? 3 : 1)
  while (index < text.length) {
    const char = text[index]
    if (char === '\\' && quote === '"') {
      index += 2
    } else if (char === quote && !multiLine) {
      return index + 1
    } else if (char === quote && text.startsWith(triple, index)) {
      while (text[index] === quote) index += 1
      return index
    } else if (char === '\n' && !multiLine) {
      return index
    } else {
      index += 1
    }
  }
  return text.length
}

// 救回来时最多去掉几处。再多就不像是写坏了几行，是整份都坏了，照旧整份重建。
const salvageDropLimit = 20

// 只去掉一行就能收拾干净的那几类：写到一半的值、认不出的转义或字符、少了 ] 的表头（连它下面那张表一起去掉）。
// 键或表重复不在里面：两份里留哪一份说不准，删错了反倒丢掉客户后写的那份。数组、内联表没收尾的也不在里面：
// 报错落在下一行，去掉的不是坏的那行。
const lineLocalTomlErrors = [
  'Unknown escape character',
  'Invalid character in unicode sequence',
  'Unterminated string',
  'Unknown character',
  'Invalid character, expected "="',
  'Unexpected character, expecting string, number, datetime, boolean, inline array or inline table',
  'Unexpected character, expected whitespace, . or ]',
]

// 一行就是一条完整的「键 = 值」。键可以是裸键、带引号的键，或者用点连起来的几段。
const keyValueStart = /^\s*(?:[A-Za-z0-9_-]+|"(?:[^"\\\n]|\\.)*"|'[^'\n]*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"(?:[^"\\\n]|\\.)*"|'[^'\n]*'))*\s*=/
const tableHeader = /^\s*\[/

/**
 * 「修好它」碰上 Codex 读不了的 config.toml 时，先试着只去掉读不了的那几行，客户自己的设置（信任过的文件夹、
 * 加的连接、推理强度）照留；以前一律整份换成星芒的模板，这些全没了。原文件照旧先备份。
 *
 * 2026-11-18 那位客户就是这样：PowerShell 5.1 按 GBK 读、UTF-8 写回，中文用户名后面的反斜杠被吃掉，
 * 「\A」「\.」成了认不出的转义，整份读不了；坏的只是带用户名路径的那几行。
 *
 * 只在去掉的东西不会让别的键挪了地方时才动手，有一点拿不准就返回 null，由调用方照旧整份重建：
 * - 坏的是一条「键 = 值」，而且一整条都在这一行里（括号配得上），只去掉这一行；
 * - 坏的是表头，连表头带它下面的键一起去掉，不让那些键落进上一张表；
 * - 有跨行字符串（三个引号）、错误不是上面那几类、去掉的超过 salvageDropLimit 处，都不救；
 * - 救完必须星芒读得懂、Codex 也认（isCodexConfigBroken），而且不是空的（空的跟整份重建没区别，模板还更全）。
 *
 * 去掉的那几行不另存：修之前的备份里都有。
 */
export function salvageCodexConfigText(text: string, parse: (text: string) => unknown = TOML.parse): string | null {
  if (/"""|'''/.test(text)) return null
  const lines = text.replace(/^﻿/, '').split('\n')
  let dropped = 0
  // TOML 1.0/1.1 都不许的控制字符：那一行本身一定是坏的，先去掉（断电写坏的整份 0 字节，去完是空的，下面照旧不救）。
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!forbiddenCharacters.test(lines[index].replace(/\r$/, ''))) continue
    if (!removeStatement(lines, index)) return null
    dropped += 1
  }
  while (dropped <= salvageDropLimit) {
    const candidate = lines.join('\n')
    let failure: unknown = null
    let parsed: unknown = null
    try {
      parsed = parse(candidate)
    } catch (error) {
      failure = error
    }
    if (failure === null) {
      if (dropped === 0 || !isNonEmptyRecord(parsed)) return null
      return isCodexConfigBroken(Buffer.from(candidate, 'utf8'), parse) ? null : candidate
    }
    const line = tomlErrorLine(failure)
    const message = failure instanceof Error ? failure.message : ''
    if (line === null || line >= lines.length || !lineLocalTomlErrors.some((prefix) => message.startsWith(prefix))) return null
    if (!removeStatement(lines, line)) return null
    dropped += 1
  }
  return null
}

// 去掉 index 这一行（表头连同它下面那张表）；去不得就返回 false，什么都不改。
function removeStatement(lines: string[], index: number): boolean {
  const line = lines[index]
  if (/^\s*(?:#|$)/.test(line)) {
    lines.splice(index, 1)
    return true
  }
  if (tableHeader.test(line)) {
    let end = index + 1
    while (end < lines.length && !tableHeader.test(lines[end])) end += 1
    lines.splice(index, end - index)
    return true
  }
  if (!keyValueStart.test(line) || !closesOnSameLine(line)) return false
  lines.splice(index, 1)
  return true
}

// 括号在这一行里配平了（引号里、注释里的不算）：这条值没有接到下一行去。字符串没收尾也算在这一行里：
// 单行字符串本来就不许跨行。
function closesOnSameLine(line: string): boolean {
  let depth = 0
  let quote: '"' | "'" | null = null
  for (let index = line.indexOf('=') + 1; index < line.length; index += 1) {
    const char = line[index]
    if (quote === '"') {
      if (char === '\\') index += 1
      else if (char === '"') quote = null
    } else if (quote === "'") {
      if (char === "'") quote = null
    } else if (char === '"' || char === "'") quote = char
    else if (char === '#') break
    else if (char === '[' || char === '{') depth += 1
    else if (char === ']' || char === '}') depth -= 1
  }
  return depth === 0
}

// @iarna/toml 的错误带着从 0 数起的行号。
function tomlErrorLine(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('line' in error)) return null
  const line = error.line
  return typeof line === 'number' && Number.isInteger(line) && line >= 0 ? line : null
}

function isNonEmptyRecord(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0
}
