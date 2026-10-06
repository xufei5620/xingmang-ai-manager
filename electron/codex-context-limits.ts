import { isDeepStrictEqual } from 'node:util'
import * as TOML from '@iarna/toml'

// 0.2.5 之前的模板写过这两项（#104 加、#124 撤），一次性清理只认值和当年模板一样的那一份。
// 客户自己在 Codex 里设成别的数，是他的选择，留着（#834 F04）。
const legacyTemplateContextLimits: ReadonlyArray<readonly [string, number]> = [
  ['model_context_window', 1000000],
  ['model_auto_compact_token_limit', 900000],
]

/** Remove only root settings; text inside prompts and profile tables is unrelated. */
export function removeCodexContextLimits(content: string): { content: string; changed: boolean } {
  const source = content.replace(/^﻿/, '')
  let expected: Record<string, unknown>
  try {
    expected = TOML.parse(source)
  } catch {
    // Parser errors include source excerpts, which may contain credentials.
    throw new Error('Codex 配置无法解析，未执行上下文限制迁移')
  }
  const keys = legacyTemplateContextLimits.filter(([key, value]) => expected[key] === value).map(([key]) => key)
  if (keys.length === 0) return { content, changed: false }
  for (const key of keys) delete expected[key]

  // Preserve ordinary user comments/formatting. A semantic comparison guards
  // against table headers or matching lines embedded in multiline strings.
  const spellings = keys.flatMap((key) => [key, `"${key}"`, `'${key}'`]).join('|')
  const assignment = new RegExp(`^\\s*(?:${spellings})\\s*=`)
  let inRoot = true
  const candidate = source.split(/(?<=\n)/).filter((line) => {
    if (/^\s*\[/.test(line)) inRoot = false
    return !inRoot || !assignment.test(line)
  }).join('')
  try {
    if (isDeepStrictEqual(TOML.parse(candidate), expected)) return { content: candidate, changed: true }
  } catch {
    // Nonstandard key spellings and multiline values use the parsed object.
  }
  const serialized = TOML.stringify(expected as Parameters<typeof TOML.stringify>[0])
  return {
    content: source.includes('\r\n') ? serialized.replace(/\r?\n/g, '\r\n') : serialized,
    changed: true,
  }
}
