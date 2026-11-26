// 「给 AI 的长期嘱咐」（总单 Q4 C5）：客户在设置里写一段话，星芒把它放进三家工具各自的全局说明文件里
// 一段带标记的区域（Claude Code 的 CLAUDE.md、Codex 和 Grok 的 AGENTS.md），三家在每个文件夹里开工都会先读。
//
// 只动标记中间那几行：标记外面客户自己写的字一个不碰，换行符、文件开头的字节顺序标记照原样；标记被改坏了
// （只剩一头、出现两次、先结束后开始）就这一家不写、说清原因，不去猜哪段是星芒的。清空嘱咐时把这一段拿掉，
// 文件里除了这一段什么都没有的，整份拿掉（不留空文件挡住「用中文回复」那份说明，见 config-files.ts 的
// globalResponseLanguagePlans）。这是客户自己的偏好，跟用哪个账号无关：换回官方账号也不收回。
//
// 写入走 executeFilePlans：先写临时文件，留 .bak，再原子替换，失败放回（I8、I9）。
import { isUtf8 } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { readBoundedFileSync } from './bounded-file'
import type { ActiveProviderId } from './catalog'
import { providerConfigRoot, type ProviderConfigRoots } from './codex-home'
import { MAX_NATIVE_CONFIG_BYTES, executeFilePlans, normalizeProviderConfigRoots } from './config-files-context'
import type { FilePlan } from './config-files'
import { assertNoReparseComponents, ensureSafeDataDirectory } from './safe-local-data'

export const STANDING_INSTRUCTIONS_MAX_LENGTH = 2000
export const STANDING_INSTRUCTIONS_MARKER = '星芒AI管理工具：给 AI 的长期嘱咐'
const START_TAG = `${STANDING_INSTRUCTIONS_MARKER}（开始）`
const END_TAG = `${STANDING_INSTRUCTIONS_MARKER}（结束）`
const START_LINE = `<!-- ${START_TAG}。此段内容请在星芒「设置 › 工具管理」中修改，在此直接修改将在下次保存时被覆盖；此段以外的内容星芒不会改动。 -->`
const END_LINE = `<!-- ${END_TAG} -->`
const BYTE_ORDER_MARK = '﻿'

export const STANDING_INSTRUCTIONS_MARKER_BROKEN = '文件中由星芒维护的段落标记已被修改，为避免改动您自行编写的内容，本次未写入。'
export const STANDING_INSTRUCTIONS_NOT_UTF8 = '文件编码无法识别，为避免内容出现乱码，本次未写入。'

export type StandingInstructionsOutcome = 'written' | 'removed' | 'unchanged' | 'skipped' | 'failed'

export interface StandingInstructionsToolResult {
  provider: ActiveProviderId
  outcome: StandingInstructionsOutcome
  /** skipped、failed 时给客户看的一句原因。 */
  reason?: string
}

/** 存一次嘱咐的结果：这次存下的那段话，和三家各自怎么样了（次序同 activeProviderIds）。 */
export interface StandingInstructionsSaveResult {
  text: string
  tools: StandingInstructionsToolResult[]
}

class StandingInstructionsSkip extends Error {}

/**
 * IPC 收到的嘱咐（I5）：只收字符串，换行统一成 \n、去掉首尾空白，最多 2000 个字；不许带控制字符，
 * 也不许带星芒自己的标记那句话（带了下次就认不出哪段是星芒的）。空字符串 = 清空。
 */
export function validateStandingInstructions(value: unknown): string {
  if (typeof value !== 'string') throw new Error('长期嘱咐格式错误')
  const text = value.replace(/\r\n?/g, '\n').trim()
  if ([...text].length > STANDING_INSTRUCTIONS_MAX_LENGTH) throw new Error(`长期嘱咐最多 ${STANDING_INSTRUCTIONS_MAX_LENGTH} 个字`)
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) throw new Error('长期嘱咐中包含不支持的字符')
  if (text.includes(STANDING_INSTRUCTIONS_MARKER)) throw new Error('长期嘱咐中不能包含星芒的内部标记')
  return text
}

/**
 * 三家各读哪一份：Claude Code 是配置目录里的 CLAUDE.md；Codex 有 AGENTS.override.md 时只读它、不读 AGENTS.md
 * （config-files.ts 的 globalInstructionFileNames 那段源码出处），所以有就写它；Grok 认 AGENTS.md。
 */
export function standingInstructionsFile(provider: ActiveProviderId, roots: ProviderConfigRoots): string {
  const root = providerConfigRoot(provider, roots)
  switch (provider) {
    case 'claude':
      return path.join(root, 'CLAUDE.md')
    case 'codex': {
      const override = path.join(root, 'AGENTS.override.md')
      try {
        fs.lstatSync(override)
        return override
      } catch {
        return path.join(root, 'AGENTS.md')
      }
    }
    case 'grok':
      return path.join(root, 'AGENTS.md')
  }
}

interface MarkedRange {
  start: number
  end: number
}

/** 标记那一段在第几行到第几行；没有返回 null，坏了抛 StandingInstructionsSkip。 */
function findMarkedRange(lines: readonly string[]): MarkedRange | null {
  const starts = lines.flatMap((line, index) => (line.includes(START_TAG) ? [index] : []))
  const ends = lines.flatMap((line, index) => (line.includes(END_TAG) ? [index] : []))
  if (starts.length === 0 && ends.length === 0) return null
  if (starts.length === 1 && ends.length === 1 && starts[0] < ends[0]) return { start: starts[0], end: ends[0] }
  throw new StandingInstructionsSkip(STANDING_INSTRUCTIONS_MARKER_BROKEN)
}

interface SourceLine {
  text: string
  /** 这一行在全文里从哪个字开始。 */
  start: number
  /** 这一行连同它的换行符到哪个字为止（下一行从这里开始）。 */
  next: number
}

// 按原文的位置切行，替换时只换标记那几行：客户文件里 \r\n 和 \n 混着用的，标记外面照原样。
function sourceLines(body: string): SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0
  for (;;) {
    const newline = body.indexOf('\n', start)
    if (newline === -1) {
      lines.push({ text: body.slice(start), start, next: body.length })
      return lines
    }
    lines.push({ text: body.slice(start, newline).replace(/\r$/, ''), start, next: newline + 1 })
    start = newline + 1
  }
}

/** 文件里星芒那一段以外的内容（「用中文回复」那份说明用它判断文件是不是只有这一段）。标记坏了原样返回。 */
export function withoutStandingInstructions(content: string): string {
  const lines = sourceLines(content)
  try {
    const range = findMarkedRange(lines.map((line) => line.text))
    if (!range) return content
    return content.slice(0, lines[range.start].start) + content.slice(lines[range.end].next)
  } catch {
    return content
  }
}

/**
 * 换上这次的嘱咐以后文件该是什么样。existing 是现在的全文（没有这个文件给 null），返回 null 表示不用动，
 * 返回 { remove: true } 表示整份拿掉（文件里只剩星芒这一段，现在又清空了）。标记坏了抛 StandingInstructionsSkip。
 */
export function buildStandingInstructionsContent(existing: string | null, text: string): string | { remove: true } | null {
  const bom = existing?.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK : ''
  const body = existing === null ? '' : existing.slice(bom.length)
  const eol = body.includes('\r\n') ? '\r\n' : '\n'
  const block = text ? [START_LINE, ...text.split('\n'), END_LINE].join(eol) : ''
  const lines = sourceLines(body)
  const range = existing === null ? null : findMarkedRange(lines.map((line) => line.text))
  if (!range) {
    if (!text) return null
    if (body.trim() === '') return `${bom}${block}${eol}`
    // 最后一行带换行的，这个换行后面垫出一个空行；不带的，这个换行只是把客户最后一行收尾。拿掉时两种各退各的
    // （见下面），文件末尾原来有没有换行也照原样。
    return `${bom}${body}${eol}${block}${eol}`
  }
  const first = lines[range.start]
  const last = lines[range.end]
  const terminator = body.slice(last.start + last.text.length, last.next)
  let from = first.start
  if (!text && range.start > 0) {
    const before = lines[range.start - 1]
    // 拿掉这一段时把加它时垫的那一个空行也拿掉，来回存几次文件末尾不会越来越长。
    if (before.text === '') from = before.start
    // 这一段紧跟在客户最后一行后面、后面再没有字的，是加它时替那一行补的换行，一起退掉。
    else if (body.slice(last.next) === '') from = before.start + before.text.length
  }
  const next = `${bom}${body.slice(0, from)}${text ? `${block}${terminator}` : ''}${body.slice(last.next)}`
  if (next === existing) return null
  if (!text && next.slice(bom.length).trim() === '') return { remove: true }
  return next
}

function readExisting(filePath: string): string | null {
  let raw: Buffer
  try {
    raw = readBoundedFileSync(filePath, MAX_NATIVE_CONFIG_BYTES, '工具全局说明')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  // 中文 Windows 上手写的说明可能是 GBK：按 UTF-8 解开再写回去，里面的中文就全成了「�」。
  if (!isUtf8(raw)) throw new StandingInstructionsSkip(STANDING_INSTRUCTIONS_NOT_UTF8)
  return raw.toString('utf8')
}

/**
 * 把嘱咐写进一家工具的全局说明。调用方负责串行（同一把配置写入锁）。不抛错：结果里说这一家怎么样了。
 */
export function applyStandingInstructions(
  provider: ActiveProviderId,
  text: string,
  rootsInput: ProviderConfigRoots,
): StandingInstructionsToolResult {
  try {
    const roots = normalizeProviderConfigRoots(rootsInput)
    const providerRoot = providerConfigRoot(provider, roots)
    const filePath = standingInstructionsFile(provider, roots)
    const next = buildStandingInstructionsContent(readExisting(filePath), text)
    if (next === null) return { provider, outcome: 'unchanged' }
    const plan: FilePlan = typeof next === 'string' ? { path: filePath, content: next } : { path: filePath, remove: true }
    assertNoReparseComponents(path.dirname(providerRoot), '工具配置目录')
    ensureSafeDataDirectory(providerRoot, '工具配置目录')
    executeFilePlans([plan], {}, providerRoot)
    return { provider, outcome: typeof next === 'string' ? (text ? 'written' : 'removed') : 'removed' }
  } catch (error) {
    if (error instanceof StandingInstructionsSkip) return { provider, outcome: 'skipped', reason: error.message }
    return { provider, outcome: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}
