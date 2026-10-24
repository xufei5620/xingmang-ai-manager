import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import * as TOML from '@iarna/toml'
import { staleConfigBackups, uniqueConfigBackupPath } from './config-file-backups'
import { isRecord } from './input-guards'
import { resolveRelocatedPath } from './relocated-folders'
import {
  assertNoReparseComponents,
  assertSafeDataFile,
  ensureSafeDataDirectory,
  readSafeUtf8FileSync,
  renameWithTransientRetrySync,
} from './safe-local-data'

// 保存配置以外单改 Codex config.toml（和星芒存的那份星芒配置）的地方都走这里：扩展页启停插件和
// 技能、星芒画图技能跟着账号开关、Codex 桌面端语言。以前四处各读各写（#1068）：中间隔着 await
// 的那几处会把这段时间里别处刚写进去的改动整份盖掉，两处不留备份，两处整份重写把客户的注释抹掉。
//
// 整个读、改、写是同步的，中间不让出事件循环。保存配置的事务（config-files-context.ts 的
// executeFilePlans）本来就是同步的，所以本进程里谁也插不进这一段，不用另排一个队：排队只管得住
// 进了队的，那个事务要进队就得整条改成异步。别的程序（Codex 自己）同时写不在这里管。

export const MAX_CODEX_TOML_BYTES = 2 * 1024 * 1024

export interface CodexTomlMutation {
  /** 报错里怎么称呼这个文件，例如「Codex config.toml」。 */
  label: string
  /**
   * 读不懂时：给一句话就照这句报错。解析器的原话会把出错那行连同上下几行抄进来，旁边常是
   * 客户的令牌，不能上屏、进日志（I13）。'skip' = 不改也不报错。
   */
  unreadable: 'skip' | string | ((error: unknown) => string)
  /** 文件不在时从空配置改起；缺省 = 不在就不写。 */
  createIfMissing?: boolean
  /** 在读出来的配置上原地改，返回 false = 不用写。必须是同步的，理由见文件开头。 */
  mutate: (config: Record<string, unknown>) => boolean
  /**
   * 只动几行的写法，before 是原样、after 是改好的。拿不准就返回 null。写出来的解析回去和 after
   * 不一模一样时不用它，整份按 after 重写。
   */
  editText?: (source: string, before: Record<string, unknown>, after: Record<string, unknown>) => string | null
}

export interface CodexTomlMutationResult {
  changed: boolean
  /** true = 没能只动几行，整份重写了，手写的注释和排版没了。 */
  rewritten: boolean
  /** 改之前那份的备份；原来没有这个文件时为 null。 */
  backupPath: string | null
}

const unchanged: CodexTomlMutationResult = { changed: false, rewritten: false, backupPath: null }

export function mutateCodexConfigToml(filePath: string, mutation: CodexTomlMutation): CodexTomlMutationResult {
  const target = resolveRelocatedPath(path.resolve(filePath))
  const existing = readSafeUtf8FileSync(target, mutation.label, MAX_CODEX_TOML_BYTES)
  if (existing === null && !mutation.createIfMissing) return unchanged
  const source = (existing ?? '').replace(/^﻿/, '')
  let before: Record<string, unknown>
  let after: Record<string, unknown>
  try {
    before = TOML.parse(source)
    after = TOML.parse(source)
  } catch (error) {
    if (mutation.unreadable === 'skip') return unchanged
    throw new Error(typeof mutation.unreadable === 'function' ? mutation.unreadable(error) : mutation.unreadable)
  }
  if (!mutation.mutate(after)) return unchanged
  const { content, rewritten } = renderTomlEdit(source, after, mutation.editText?.(source, before, after) ?? null)
  const backupPath = replaceTomlFile(target, content, mutation.label)
  return { changed: true, rewritten, backupPath }
}

/**
 * 只动几行的结果解析回去和 expected 一模一样才用：多行字符串里像表头的那几行、少见的写法都可能
 * 让按行改错地方。对不上就整份按 expected 重写，换行符跟原文件。
 */
export function renderTomlEdit(
  source: string,
  expected: Record<string, unknown>,
  candidate: string | null,
): { content: string; rewritten: boolean } {
  if (candidate !== null) {
    try {
      if (isDeepStrictEqual(TOML.parse(candidate), expected)) return { content: candidate, rewritten: false }
    } catch {
      // A line edit that no longer parses falls back to the semantic rewrite.
    }
  }
  const serialized = TOML.stringify(expected as Parameters<typeof TOML.stringify>[0])
  return { content: source.includes('\r\n') ? serialized.replace(/\r?\n/g, '\r\n') : serialized, rewritten: true }
}

/** 先写临时文件，再备份原来那份，最后换上去；只留最近 5 份备份。 */
function replaceTomlFile(target: string, content: string, label: string): string | null {
  const directory = path.dirname(target)
  ensureSafeDataDirectory(directory, label)
  const temporaryPath = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`)
  let backupPath: string | null = null
  try {
    const descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
    try {
      fs.writeFileSync(descriptor, content, 'utf8')
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    if (assertSafeDataFile(target, label)) {
      backupPath = uniqueConfigBackupPath(target)
      fs.copyFileSync(target, backupPath, fs.constants.COPYFILE_EXCL)
    }
    // Windows 上安全软件正扫着 config.toml 时换不过去（EPERM / EBUSY），等一下再试。每次试之前
    // 再查一遍：等的那一下，路径可能被换成联接，文件也可能多了硬链接。
    renameWithTransientRetrySync(temporaryPath, target, () => {
      assertNoReparseComponents(directory, label)
      assertSafeDataFile(target, label)
    })
  } finally {
    try {
      fs.rmSync(temporaryPath, { force: true })
    } catch {
      // 换上去以后它已经不在；没换上去时删不掉只是多一个临时文件，原来的错照样报。
    }
  }
  // 换上去以后才清旧备份，换不上去时还能靠最新那份恢复。
  for (const stale of staleConfigBackups(target)) {
    try {
      const info = fs.lstatSync(stale)
      if (info.isFile() && !info.isSymbolicLink()) fs.rmSync(stale)
    } catch {
      // 删不掉只是多留一份备份。
    }
  }
  return backupPath
}

// @iarna/toml 把日期时间解析成 Date，它是对象但不是表。
function isTomlTable(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !(value instanceof Date)
}

/** 按键一层层往下找，路上哪一层不是表就返回 undefined。 */
export function tomlValueAt(config: Record<string, unknown>, keyPath: readonly string[]): unknown {
  let node: unknown = config
  for (const key of keyPath) {
    if (!isTomlTable(node)) return undefined
    node = node[key]
  }
  return node
}

function nestTomlValue(keyPath: readonly string[], value: unknown): Record<string, unknown> {
  return keyPath.reduceRight<Record<string, unknown>>((inner, key) => ({ [key]: inner }), value as Record<string, unknown>)
}

// --- 按行改 ---------------------------------------------------------------------------------
// 只认最普通的写法：表头单占一行，要改的键在那张表自己的表头下面、值写在一行里。别的写法
// （行内表、点号键、多行值）返回 null，由 renderTomlEdit 整份重写。

const headerProbeKey = '__xingmang_header_probe__'

interface TomlHeader {
  keyPath: string[]
  array: boolean
}

/** 表头的键路径交给解析器去认，引号、空格、行尾注释各种写法都不用自己猜。 */
function tomlHeader(line: string): TomlHeader | null {
  if (!/^\s*\[/.test(line)) return null
  let node: unknown
  try {
    node = TOML.parse(`${line}\n${headerProbeKey} = true\n`)
  } catch {
    // A continuation line of a multiline array also starts with '['.
    return null
  }
  const keyPath: string[] = []
  for (;;) {
    if (Array.isArray(node)) node = node[node.length - 1]
    if (!isTomlTable(node)) return null
    const keys = Object.keys(node)
    if (keys.length !== 1) return null
    if (keys[0] === headerProbeKey) return { keyPath, array: /^\s*\[\[/.test(line) }
    keyPath.push(keys[0])
    node = node[keys[0]]
  }
}

function lineText(line: string): string {
  return line.replace(/\r?\n$/, '')
}

/** 返回表头所在行和这张表结束的行（下一个表头或文件末尾）。index 给了就是第 index 段 [[keyPath]]。 */
function findTomlSection(
  lines: readonly string[],
  keyPath: readonly string[],
  index?: number,
): { header: number; end: number } | null {
  let header = -1
  let seen = 0
  for (let line = 0; line < lines.length; line += 1) {
    const parsed = tomlHeader(lineText(lines[line] ?? ''))
    if (!parsed) continue
    if (header >= 0) return { header, end: line }
    if (parsed.array !== (index !== undefined) || !isDeepStrictEqual(parsed.keyPath, [...keyPath])) continue
    if (index !== undefined && seen++ !== index) continue
    header = line
  }
  return header >= 0 ? { header, end: lines.length } : null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function keySpellings(key: string): string {
  const spellings = [JSON.stringify(key)]
  if (/^[A-Za-z0-9_-]+$/.test(key)) spellings.push(key)
  if (!/['\r\n]/.test(key)) spellings.push(`'${key}'`)
  return spellings.map(escapeRegExp).join('|')
}

/** 只写字符串、布尔和数。 */
function tomlScalarLiteral(value: unknown): string | null {
  // JSON's escapes are all valid in a TOML basic string; TOML additionally
  // forbids a raw DEL. The parser's own stringify is not used for strings: with
  // a quote or backslash inside it picks a literal string, where control
  // characters cannot be escaped at all.
  if (typeof value === 'string') return JSON.stringify(value).replace(/\u007f/g, '\\u007f')
  if (typeof value === 'boolean') return String(value)
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return TOML.stringify({ value }).replace(/^value = /, '').replace(/\r?\n$/, '')
}

/**
 * 把 keyPath 那张表（给了 index 就是第 index 段 [[keyPath]]）里的 key 改成 value：有这一行就只换
 * 值、行尾注释留着，没有就接在这张表最后一个键后面。找不到表或那一行不是单行值返回 null。
 */
export function setTomlKeyText(
  source: string,
  section: { keyPath: readonly string[]; index?: number },
  key: string,
  value: unknown,
): string | null {
  const literal = tomlScalarLiteral(value)
  if (literal === null) return null
  const lines = source.split(/(?<=\n)/)
  const range = findTomlSection(lines, section.keyPath, section.index)
  if (!range) return null
  const spellings = keySpellings(key)
  const assignment = new RegExp(`^\\s*(?:${spellings})\\s*=`)
  const singleLine = new RegExp(`^(\\s*(?:${spellings})\\s*=\\s*)(?:"(?:[^"\\\\]|\\\\.)*"|'[^']*'|true|false|[+-]?\\d[\\d_]*(?:\\.\\d[\\d_]*)?)(\\s*(?:#.*)?)$`)
  for (let line = range.header + 1; line < range.end; line += 1) {
    const text = lineText(lines[line] ?? '')
    if (!assignment.test(text)) continue
    const match = text.match(singleLine)
    if (!match) return null
    lines[line] = `${match[1]}${literal}${match[2]}${(lines[line] ?? '').slice(text.length)}`
    return lines.join('')
  }
  let after = range.header
  for (let line = range.end - 1; line > range.header; line -= 1) {
    const text = lineText(lines[line] ?? '').trim()
    if (text && !text.startsWith('#')) {
      after = line
      break
    }
  }
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const previous = lines[after] ?? ''
  if (!/\n$/.test(previous)) lines[after] = `${previous}${newline}`
  lines.splice(after + 1, 0, `${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)} = ${literal}${newline}`)
  return lines.join('')
}

/** 把 fragment 整段接在文件末尾，前面空一行。 */
export function appendTomlText(source: string, fragment: Record<string, unknown>): string {
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const text = TOML.stringify(fragment as Parameters<typeof TOML.stringify>[0]).replace(/\r?\n/g, newline)
  if (!source.trim()) return text
  const ended = /\n$/.test(source) ? source : `${source}${newline}`
  return `${ended}${/\n\s*\n$/.test(ended) ? '' : newline}${text}`
}

/**
 * keyPath 那张表里值变了、或新加的单行键逐个按行改；原来没有这张表就整张接在末尾。
 * 删了键或改了子表返回 null。
 */
export function editTomlTableText(
  source: string,
  keyPath: readonly string[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string | null {
  const was = tomlValueAt(before, keyPath)
  const now = tomlValueAt(after, keyPath)
  if (!isTomlTable(now)) return null
  if (was === undefined) return appendTomlText(source, nestTomlValue(keyPath, now))
  if (!isTomlTable(was)) return null
  return editTomlEntryText(source, { keyPath }, was, now)
}

/**
 * [[keyPath]] 一条一段：已有的那几条按位置逐个改键，多出来的接在文件末尾；只删了几条、剩下的
 * 一点没动时，把删掉的那几段整段拿掉。又删又改、删了键或改了子表返回 null。
 */
export function editTomlArrayTableText(
  source: string,
  keyPath: readonly string[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string | null {
  const was = tomlValueAt(before, keyPath) ?? []
  // 最后一条也删了的时候，调用方连这个键一起删掉，解析回去才对得上。
  const now = tomlValueAt(after, keyPath) ?? []
  if (!Array.isArray(was) || !Array.isArray(now)) return null
  if (now.length < was.length) return removeTomlArrayEntriesText(source, keyPath, was, now)
  let content: string | null = source
  for (let index = 0; index < was.length && content !== null; index += 1) {
    const entry = was[index]
    const next = now[index]
    if (isDeepStrictEqual(entry, next)) continue
    if (!isTomlTable(entry) || !isTomlTable(next)) return null
    content = editTomlEntryText(content, { keyPath, index }, entry, next)
  }
  if (content === null) return null
  const added = now.slice(was.length)
  return added.length > 0 ? appendTomlText(content, nestTomlValue(keyPath, added)) : content
}

/** now 必须是 was 按原顺序去掉几条，剩下的原样不动；不是就返回 null。 */
function removeTomlArrayEntriesText(
  source: string,
  keyPath: readonly string[],
  was: readonly unknown[],
  now: readonly unknown[],
): string | null {
  const removed: number[] = []
  let kept = 0
  for (const [index, entry] of was.entries()) {
    if (kept < now.length && isDeepStrictEqual(entry, now[kept])) kept += 1
    else removed.push(index)
  }
  if (kept !== now.length) return null
  let content: string | null = source
  // 从后往前删，前面那几段还是第几段不变。
  for (const index of removed.reverse()) {
    if (content === null) return null
    content = removeTomlSectionText(content, { keyPath, index })
  }
  return content
}

/**
 * 拿掉一段：表头到这张表最后一个键，连同紧跟着的空行。再往后的注释多半是写给下一张表的，留着；
 * 这段是文件里最后的东西时，前面的空行也一起去掉。
 */
function removeTomlSectionText(source: string, section: { keyPath: readonly string[]; index?: number }): string | null {
  const lines = source.split(/(?<=\n)/)
  const range = findTomlSection(lines, section.keyPath, section.index)
  if (!range) return null
  removeTomlSectionLines(lines, range)
  return lines.join('')
}

/**
 * 拿掉 keyPath 那张表连同它下面各自单占表头的子表（[mcp_servers.docs] 和 [mcp_servers.docs.env]），
 * 每段的拿法同上。一段也没找到返回 null；写在上一层里的（行内表、点号键）也找不到，交给
 * renderTomlEdit 整份重写。
 */
export function removeTomlTableText(source: string, keyPath: readonly string[]): string | null {
  const lines = source.split(/(?<=\n)/)
  const sections: Array<{ header: number; end: number }> = []
  for (let line = 0; line < lines.length; line += 1) {
    const parsed = tomlHeader(lineText(lines[line] ?? ''))
    if (!parsed) continue
    const previous = sections[sections.length - 1]
    if (previous && previous.end === lines.length) previous.end = line
    if (keyPath.every((key, index) => parsed.keyPath[index] === key)) sections.push({ header: line, end: lines.length })
  }
  if (!sections.length) return null
  // 从后往前删，前面那几段的表头还在原来那行；后一段连它前面的空行一起拿掉时，前一段的结尾跟着收回来。
  for (const range of sections.reverse()) removeTomlSectionLines(lines, { header: range.header, end: Math.min(range.end, lines.length) })
  return lines.join('')
}

function removeTomlSectionLines(lines: string[], range: { header: number; end: number }): void {
  const blank = (line: number) => !lineText(lines[line] ?? '').trim()
  let last = range.header
  for (let line = range.end - 1; line > range.header; line -= 1) {
    const text = lineText(lines[line] ?? '').trim()
    if (text && !text.startsWith('#')) {
      last = line
      break
    }
  }
  let end = last + 1
  while (end < range.end && blank(end)) end += 1
  let start = range.header
  if (end === lines.length) while (start > 0 && blank(start - 1)) start -= 1
  lines.splice(start, end - start)
}

function editTomlEntryText(
  source: string,
  section: { keyPath: readonly string[]; index?: number },
  was: Record<string, unknown>,
  now: Record<string, unknown>,
): string | null {
  if (Object.keys(was).some((key) => !(key in now))) return null
  let content: string | null = source
  for (const [key, value] of Object.entries(now)) {
    if (content === null) return null
    if (isDeepStrictEqual(was[key], value)) continue
    content = setTomlKeyText(content, section, key, value)
  }
  return content
}
