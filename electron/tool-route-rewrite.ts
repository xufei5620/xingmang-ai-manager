import { isDeepStrictEqual } from 'node:util'
import * as TOML from '@iarna/toml'

/**
 * 换线路时只改配置里的那一个地址，文件其余字节原样（xm 三线路 C9）。整份重写会把客户自己的
 * 注释、键的顺序、空行全冲掉，还要先查一遍模型、同步一遍 Key，任何一步不通工具就卡在旧线路上。
 *
 * 做法是在原文里找出这个值的字面量，只换那一处，然后整份再解析一遍，和「原来的解析结果只改了
 * 这一个键」逐项比对：完全一样才算数。值碰巧也出现在注释里、别的键里，换错了地方的那几种都
 * 过不了比对，于是不用自己去理解表头、点号键、内联表这些语法。找不到、找到不止一处能对上的，
 * 一律返回 null，交给调用方记成「定位不到」，一个字都不改。
 */

export interface StringValueEdit {
  /** 解析后的对象里这个值的位置，比如 ['model_providers', 'XingmangAI', 'base_url']。 */
  path: readonly string[]
  value: string
}

type Parser = (content: string) => unknown
/** 原值在文件里可能的写法，和换成新值时对应的写法。 */
type LiteralForms = (previous: string, next: string) => { find: string; replace: string }[]

function valueAt(parsed: unknown, path: readonly string[]): unknown {
  let current = parsed
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function withValueAt(parsed: unknown, path: readonly string[], value: string): boolean {
  let current = parsed
  for (const key of path.slice(0, -1)) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return false
    current = (current as Record<string, unknown>)[key]
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) return false
  const record = current as Record<string, unknown>
  record[path[path.length - 1]] = value
  return true
}

function parseOrNull(parse: Parser, content: string): unknown {
  try {
    return parse(content.replace(/^﻿/, ''))
  } catch {
    return null
  }
}

function occurrences(content: string, literal: string): number[] {
  const found: number[] = []
  if (!literal) return found
  for (let index = content.indexOf(literal); index !== -1; index = content.indexOf(literal, index + 1)) found.push(index)
  return found
}

function applyEdit(content: string, edit: StringValueEdit, parse: Parser, forms: LiteralForms): string | null {
  const parsed = parseOrNull(parse, content)
  if (parsed === null) return null
  const previous = valueAt(parsed, edit.path)
  if (typeof previous !== 'string') return null
  if (previous === edit.value) return content
  const expected = parseOrNull(parse, content)
  if (!withValueAt(expected, edit.path, edit.value)) return null
  const matches: string[] = []
  for (const { find, replace } of forms(previous, edit.value)) {
    for (const index of occurrences(content, find)) {
      const candidate = content.slice(0, index) + replace + content.slice(index + find.length)
      if (isDeepStrictEqual(parseOrNull(parse, candidate), expected)) matches.push(candidate)
    }
  }
  return matches.length === 1 ? matches[0] : null
}

function applyEdits(content: string, edits: readonly StringValueEdit[], parse: Parser, forms: LiteralForms): string | null {
  let current = content
  for (const edit of edits) {
    const next = applyEdit(current, edit, parse, forms)
    if (next === null) return null
    current = next
  }
  return current
}

function parseToml(content: string): unknown {
  return TOML.parse(content)
}

// 基本字符串的转义是 JSON 的子集外加几个 TOML 自己的写法；地址里不会有要转义的字符，
// 真遇上原文换了一种转义写法，比对过不了，落到「定位不到」，不会改错。
function tomlForms(previous: string, next: string): { find: string; replace: string }[] {
  const forms = [{ find: JSON.stringify(previous), replace: JSON.stringify(next) }]
  if (!/['\r\n]/.test(previous) && !/['\r\n]/.test(next)) forms.push({ find: `'${previous}'`, replace: `'${next}'` })
  return forms
}

function jsonForms(previous: string, next: string): { find: string; replace: string }[] {
  return [{ find: JSON.stringify(previous), replace: JSON.stringify(next) }]
}

/** TOML 里换几个字符串值；null = 定位不到，原文一个字都没动。 */
export function rewriteTomlStrings(content: string, edits: readonly StringValueEdit[]): string | null {
  return applyEdits(content, edits, parseToml, tomlForms)
}

/** 严格 JSON（Claude Code 自己就按 JSON.parse 读）里换几个字符串值；null = 定位不到。 */
export function rewriteJsonStrings(content: string, edits: readonly StringValueEdit[]): string | null {
  return applyEdits(content, edits, JSON.parse, jsonForms)
}

/**
 * .env 里第一行 `名字=` 的值，认法和 config-files.ts 的 readEnvValue 一样（Gemini 读到的也是这一行）。
 * 原来带引号的照旧带同一种引号，行首缩进、行尾空白、换行符都不动。null = 没有这一行或写法认不出。
 */
export function rewriteEnvValue(content: string, name: string, value: string): string | null {
  if (/[\r\n"']/.test(value)) return null
  const parts = content.split(/(\r?\n)/)
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index]
    const leading = line.slice(0, line.length - line.trimStart().length)
    const rest = line.slice(leading.length)
    if (!rest.startsWith(`${name}=`)) continue
    const raw = rest.slice(name.length + 1)
    const trailing = raw.slice(raw.trimEnd().length)
    const body = raw.trim()
    const quote = body.length >= 2 && (body[0] === '"' || body[0] === "'") && body.endsWith(body[0]) ? body[0] : ''
    const valueLeading = raw.slice(0, raw.length - raw.trimStart().length)
    parts[index] = `${leading}${name}=${valueLeading}${quote}${value}${quote}${trailing}`
    return parts.join('')
  }
  return null
}

/** 和 rewriteEnvValue 同一个认法，读出那一行的值；没有这一行 = null。 */
export function readEnvLineValue(content: string, name: string): string | null {
  const line = content.split(/\r?\n/).find((entry) => entry.trimStart().startsWith(`${name}=`))
  if (line === undefined) return null
  const value = line.slice(line.indexOf('=') + 1).trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

/** 读出 TOML / JSON 里某个位置的字符串；读不懂或不是字符串 = null。 */
export function readTomlString(content: string, path: readonly string[]): string | null {
  const value = valueAt(parseOrNull(parseToml, content), path)
  return typeof value === 'string' ? value : null
}

export function readJsonString(content: string, path: readonly string[]): string | null {
  const value = valueAt(parseOrNull(JSON.parse, content), path)
  return typeof value === 'string' ? value : null
}
