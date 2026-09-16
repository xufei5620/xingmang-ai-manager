import { isDeepStrictEqual } from 'node:util'
import * as TOML from '@iarna/toml'

/** Remove only root settings; text inside prompts and profile tables is unrelated. */
export function removeCodexContextLimits(content: string): { content: string; changed: boolean } {
  const source = content.replace(/^\uFEFF/, '')
  let expected: Record<string, unknown>
  try {
    expected = TOML.parse(source)
  } catch {
    // Parser errors include source excerpts, which may contain credentials.
    throw new Error('Codex 配置无法解析，未执行上下文限制迁移')
  }
  const keys = ['model_context_window', 'model_auto_compact_token_limit']
  if (!keys.some((key) => Object.hasOwn(expected, key))) return { content, changed: false }
  for (const key of keys) delete expected[key]

  // Preserve ordinary user comments/formatting. A semantic comparison guards
  // against table headers or matching lines embedded in multiline strings.
  let inRoot = true
  const candidate = source.split(/(?<=\n)/).filter((line) => {
    if (/^\s*\[/.test(line)) inRoot = false
    return !inRoot || !/^\s*(?:model_context_window|model_auto_compact_token_limit|"(?:model_context_window|model_auto_compact_token_limit)"|'(?:model_context_window|model_auto_compact_token_limit)')\s*=/.test(line)
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
