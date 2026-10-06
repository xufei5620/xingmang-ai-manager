import { isUtf8 } from 'node:buffer'
import { parseTree, stripComments, type Node } from 'jsonc-parser'

/**
 * 工具自己读不读得了它的 JSON 配置（Codex 的 config.toml 见 codex-config-syntax.ts）。读不了时
 * 这几个工具都不会照着星芒写进去的 Key 和地址走，首页据此说「配置文件坏了」并给「修好它」。
 *
 * 三个工具的读法各不一样，星芒自己的读法（去掉开头的 BOM、坏字节换成占位符）又比它们都宽，
 * 所以星芒读得出 Key 不代表工具读得了。每一条都在沙箱里拿真工具逐条试过；没试过的写法一律
 * 不下结论，免得把一份能用的配置说成坏了。
 */

const byteOrderMark = Buffer.from([0xef, 0xbb, 0xbf])

function startsWithByteOrderMark(content: Buffer): boolean {
  return content.subarray(0, byteOrderMark.length).equals(byteOrderMark)
}

function parseJson(text: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(text) as unknown }
  } catch {
    return null
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 键在、但既不是 null 也过不了 check。键不在算没问题。 */
function presentAndNot(record: Record<string, unknown>, key: string, check: (value: unknown) => boolean): boolean {
  return Object.hasOwn(record, key) && record[key] !== null && !check(record[key])
}

/**
 * Claude Code 2.1.277 实测：JSON 写错（注释、多逗号、写到一半、空字节、字符串里的控制字符）、
 * 最外层不是一组设置、`env` 不是一组键值、`permissions` 不是一组设置或其中 `deny` 不是列表、
 * `model` 不是文字（这几项写 null 也算），一打开就弹英文的「Settings Error」，整份不用。
 * 开头的 BOM、重复的键、GBK 字节、空文件或只有空白、`env` 里值的类型、不认识的键都照用。
 * 别的设置项类型不对它也整份不用，没有逐项试过，不在这里认。
 */
export function isClaudeSettingsBroken(content: Buffer): boolean {
  const text = content.toString('utf8').replace(/^﻿/, '')
  if (!text.trim()) return false
  const parsed = parseJson(text)
  if (!parsed || !isPlainObject(parsed.value)) return true
  const settings = parsed.value
  if (Object.hasOwn(settings, 'env') && !isPlainObject(settings.env)) return true
  if (Object.hasOwn(settings, 'model') && typeof settings.model !== 'string') return true
  if (!Object.hasOwn(settings, 'permissions')) return false
  const permissions = settings.permissions
  return !isPlainObject(permissions) || (Object.hasOwn(permissions, 'deny') && !Array.isArray(permissions.deny))
}

/**
 * Gemini CLI 0.60.0 实测：先去掉注释再按严格 JSON 读。开头带 BOM、多逗号、写到一半、空文件或
 * 只有空白、空字节、最外层是列表或 null，一打开就报「Error in …settings.json」退出（退出码 52）。
 * 注释、重复的键、GBK 字节照用；设置项类型不对只出警告，照样能用。
 */
export function isGeminiSettingsBroken(content: Buffer): boolean {
  if (startsWithByteOrderMark(content)) return true
  // 和它用的 strip-json-comments 一样把注释换成空格，不改变别处的写法。
  const parsed = parseJson(stripComments(content.toString('utf8'), ' '))
  return !parsed || !isPlainObject(parsed.value)
}

const knownCodexAuthKeys: ReadonlySet<string> = new Set(['auth_mode', 'OPENAI_API_KEY', 'tokens', 'last_refresh'])

function repeatsKnownKey(node: Node | undefined): boolean {
  if (node?.type !== 'object') return false
  const seen = new Set<string>()
  for (const property of node.children ?? []) {
    const name: unknown = property.children?.[0]?.value
    if (typeof name !== 'string' || !knownCodexAuthKeys.has(name)) continue
    if (seen.has(name)) return true
    seen.add(name)
  }
  return false
}

/**
 * Codex 0.159.0-alpha.12.1（桌面端 26.930 自带）实测：auth.json 读不了时不报错，当成没登录，
 * 打开就要重新登录，用的是当前账号的 Key 还是 ChatGPT 账号都一样。读不了的：不是 UTF-8、
 * 开头带 BOM、JSON 写错（写到一半、多逗号、注释、空文件、只有空白、空字节）、最外层不是一个
 * 对象、`auth_mode` `OPENAI_API_KEY` `tokens` `last_refresh` 重复或类型不对（`last_refresh`
 * 要是时间）。不认识的键（重复也行）、值写 null、CRLF、Key 前后有空格都照读。`tokens` 里缺字段、
 * `auth_mode` 写成不认识的词它也读不了，但哪些词认没有逐个试过，不在这里认。
 */
export function isCodexAuthBroken(content: Buffer): boolean {
  if (!isUtf8(content) || startsWithByteOrderMark(content)) return true
  const text = content.toString('utf8')
  const parsed = parseJson(text)
  if (!parsed || !isPlainObject(parsed.value)) return true
  const auth = parsed.value
  return repeatsKnownKey(parseTree(text))
    || presentAndNot(auth, 'OPENAI_API_KEY', (value) => typeof value === 'string')
    || presentAndNot(auth, 'auth_mode', (value) => typeof value === 'string')
    || presentAndNot(auth, 'last_refresh', (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)))
    || presentAndNot(auth, 'tokens', isPlainObject)
}
