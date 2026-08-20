import type { UpstreamMediaReference } from './upstream-references'

export interface PromptTextSegment {
  type: 'text'
  text: string
}

export interface PromptMentionSegment {
  type: 'mention'
  text: string
  kind?: UpstreamMediaReference['kind']
  reference?: UpstreamMediaReference
}

export type PromptSegment = PromptTextSegment | PromptMentionSegment

/** Two ideographic spaces: same advance as a `2em` inline thumb at any font size. */
export const mentionThumbSlot = '\u3000\u3000'

const structuredMention = /^@[^\s@]+-(?:图片|视频|音频)-[a-z0-9]{6}/
const completedMention = /^@[^\s@]+-(?:图片|视频|音频)-[a-z0-9]{6}$/
const looseMention = /^@[^\s@]+/

export function isCompletedMentionToken(value: string): boolean {
  return completedMention.test(value)
}

interface LocatedMention {
  start: number
  end: number
  text: string
  reference?: UpstreamMediaReference
  atomic: boolean
}

function isMentionBoundary(value: string, index: number): boolean {
  return index === 0 || !/[A-Za-z0-9]/.test(value.charAt(index - 1))
}

function locateMentions(
  value: string,
  references: readonly UpstreamMediaReference[] = [],
): LocatedMention[] {
  const byMention = new Map(references.map((reference) => [reference.mention, reference]))
  const known = [...byMention.keys()].sort((left, right) => right.length - left.length)
  const located: LocatedMention[] = []
  let cursor = 0
  while (cursor < value.length) {
    const at = value.indexOf('@', cursor)
    if (at < 0) break
    if (!isMentionBoundary(value, at)) {
      cursor = at + 1
      continue
    }
    const knownMatch = known.find((mention) => value.startsWith(mention, at))
    if (knownMatch) {
      located.push({ start: at, end: at + knownMatch.length, text: knownMatch, reference: byMention.get(knownMatch), atomic: true })
      cursor = at + knownMatch.length
      continue
    }
    const slice = value.slice(at)
    const structured = structuredMention.exec(slice)?.[0]
    if (structured) {
      located.push({ start: at, end: at + structured.length, text: structured, atomic: true })
      cursor = at + structured.length
      continue
    }
    const loose = looseMention.exec(slice)?.[0]
    const end = loose ? at + loose.length : -1
    if (loose && (end === value.length || /\s/.test(value.charAt(end)))) {
      located.push({ start: at, end, text: loose, atomic: false })
      cursor = end
      continue
    }
    cursor = at + 1
  }
  return located
}

function thumbSlotLengthAfter(value: string, index: number): number {
  let length = 0
  while (length < mentionThumbSlot.length && value.charAt(index + length) === '\u3000') length += 1
  return length
}

export function ensureMentionThumbSlots(
  value: string,
  caret: number | null = null,
  references: readonly UpstreamMediaReference[] = [],
): { value: string; caret: number | null } {
  let next = value
  let nextCaret = caret
  const mentions = locateMentions(next, references).filter((mention) => mention.atomic)
  for (let index = mentions.length - 1; index >= 0; index -= 1) {
    const mention = mentions[index]
    const missing = mentionThumbSlot.length - thumbSlotLengthAfter(next, mention.end)
    if (missing <= 0) continue
    next = `${next.slice(0, mention.end)}${mentionThumbSlot.slice(0, missing)}${next.slice(mention.end)}`
    if (nextCaret !== null && nextCaret > mention.end) nextCaret += missing
  }
  return { value: next, caret: nextCaret }
}

export function splitPromptSegments(
  value: string,
  references: readonly UpstreamMediaReference[] = [],
): PromptSegment[] {
  if (!value) return []
  const segments: PromptSegment[] = []
  let cursor = 0
  for (const mention of locateMentions(value, references)) {
    if (mention.start > cursor) segments.push({ type: 'text', text: value.slice(cursor, mention.start) })
    segments.push({
      type: 'mention',
      text: mention.text,
      ...(mention.reference ? { kind: mention.reference.kind, reference: mention.reference } : {}),
    })
    cursor = mention.end + (mention.atomic ? thumbSlotLengthAfter(value, mention.end) : 0)
  }
  if (cursor < value.length) segments.push({ type: 'text', text: value.slice(cursor) })
  return segments
}

export function mentionDisplayName(segment: PromptMentionSegment): string {
  return segment.reference?.label ?? segment.text.replace(/^@/, '')
}

export function mentionRenderParts(text: string): { marker: string; rest: string } {
  return text.startsWith('@')
    ? { marker: '@', rest: text.slice(1) }
    : { marker: '', rest: text }
}

export const promptEditorMaxLength = 2500

export function clipPromptEditorValue(value: string, caret: number | null = null): { value: string; caret: number | null } {
  if (value.length <= promptEditorMaxLength) return { value, caret }
  const clipped = value.slice(0, promptEditorMaxLength)
  return { value: clipped, caret: caret === null ? null : Math.min(Math.max(0, caret), clipped.length) }
}

export const promptMentionMime = 'application/x-xingmang-prompt-mention'

export function dataTransferHasPromptMention(types: readonly string[]): boolean {
  return types.includes(promptMentionMime)
}

export interface MentionRange {
  start: number
  end: number
  text: string
}

export function mentionRanges(
  value: string,
  references: readonly UpstreamMediaReference[] = [],
): MentionRange[] {
  return locateMentions(value, references)
    .filter((mention) => mention.atomic)
    .map((mention) => ({
      start: mention.start,
      end: mention.end + thumbSlotLengthAfter(value, mention.end),
      text: mention.text,
    }))
}

export function deleteAtomicMention(
  value: string,
  caretStart: number,
  caretEnd: number,
  direction: 'backward' | 'forward',
  references: readonly UpstreamMediaReference[] = [],
): { value: string; caret: number } | null {
  const ranges = mentionRanges(value, references)
  if (ranges.length === 0) return null
  const start = Math.min(caretStart, caretEnd)
  const end = Math.max(caretStart, caretEnd)
  if (start !== end) {
    const overlapping = ranges.filter((range) => range.start < end && range.end > start)
    if (overlapping.length === 0) return null
    const from = Math.min(start, overlapping[0].start)
    const to = Math.max(end, overlapping[overlapping.length - 1].end)
    return { value: `${value.slice(0, from)}${value.slice(to)}`, caret: from }
  }
  const range = direction === 'backward'
    ? ranges.find((entry) => entry.start < start && start <= entry.end)
    : ranges.find((entry) => entry.start <= start && start < entry.end)
  if (!range) return null
  return { value: `${value.slice(0, range.start)}${value.slice(range.end)}`, caret: range.start }
}

export function insertMentionAt(value: string, mention: string, index: number): { value: string; caret: number } {
  const clamped = Math.max(0, Math.min(value.length, Number.isInteger(index) ? index : value.length))
  const before = value.slice(0, clamped)
  const after = value.slice(clamped)
  const lead = before.length === 0 || /\s$/.test(before) ? '' : ' '
  const trail = after.length === 0 ? ' ' : /^\s/.test(after) ? '' : ' '
  return {
    value: `${before}${lead}${mention}${mentionThumbSlot}${trail}${after}`,
    caret: before.length + lead.length + mention.length + mentionThumbSlot.length + (trail ? 1 : 0),
  }
}
