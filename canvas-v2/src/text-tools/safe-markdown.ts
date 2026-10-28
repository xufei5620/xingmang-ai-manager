export type MarkdownInline = { kind: 'text' | 'code'; text: string } | { kind: 'strong' | 'em' | 'strike'; children: MarkdownInline[] } | { kind: 'link' | 'image'; label: string; href: string | null; rawHref: string }
export type MarkdownBlock = { kind: 'paragraph' | 'quote'; children: MarkdownInline[] } | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: MarkdownInline[] } | { kind: 'code'; text: string; language: string } | { kind: 'list'; ordered: boolean; start: number; items: MarkdownInline[][] } | { kind: 'divider' }
export const markdownPreviewCharacterLimit = 40_000
const maximumInlineTokens = 4_000
const maximumBlocks = 1_000

export function safeMarkdownHref(input: string): string | null {
  if (input.length > 2048 || /[\u0000-\u0020\u007f]/.test(input) || !/^https?:\/\//i.test(input)) return null
  try { const url = new URL(input); return url.username || url.password ? null : url.href } catch { return null }
}

// This is a bounded Markdown subset. Raw HTML is always text, and image syntax
// never creates a resource-loading element. No HTML parser or innerHTML is used.
export function parseMarkdownInline(text: string, depth = 0, budget = { remaining: maximumInlineTokens }): MarkdownInline[] {
  if (depth > 5 || budget.remaining <= 0) return [{ kind: 'text', text }]
  const result: MarkdownInline[] = []
  let position = 0, plainStart = 0
  function plain(end: number) { if (end > plainStart) result.push({ kind: 'text', text: text.slice(plainStart, end) }) }
  while (position < text.length && budget.remaining > 0) {
    const char = text[position]
    if (char === '\\' && /[\\`*~!\[\]()#>+-]/.test(text[position + 1] ?? '')) {
      plain(position); result.push({ kind: 'text', text: text[position + 1] }); position += 2; plainStart = position; budget.remaining--; continue
    }
    if (char === '`') {
      let count = 1
      while (text[position + count] === '`') count++
      const marker = '`'.repeat(count), close = text.indexOf(marker, position + count)
      if (close >= 0) { plain(position); result.push({ kind: 'code', text: text.slice(position + count, close) }); position = close + count; plainStart = position; budget.remaining--; continue }
      position += count; continue
    }
    if (char === '[' || (char === '!' && text[position + 1] === '[')) {
      const image = char === '!', labelStart = position + (image ? 2 : 1), labelEnd = text.indexOf('](', labelStart)
      if (labelEnd >= 0 && labelEnd - labelStart <= 2048) {
        let end = labelEnd + 2, nesting = 0
        for (; end < text.length && end - labelEnd <= 2048; end++) {
          if (text[end] === '(') nesting++
          if (text[end] === ')' && nesting-- === 0) break
        }
        if (text[end] === ')') { const rawHref = text.slice(labelEnd + 2, end); plain(position); result.push({ kind: image ? 'image' : 'link', label: text.slice(labelStart, labelEnd), href: safeMarkdownHref(rawHref), rawHref }); position = end + 1; plainStart = position; budget.remaining--; continue }
      }
    }
    if (char === '*' || (char === '~' && text[position + 1] === '~')) {
      const marker = char === '~' ? '~~' : text[position + 1] === '*' ? '**' : '*'
      const close = text.indexOf(marker, position + marker.length)
      if (close > position + marker.length) { plain(position); budget.remaining--; result.push({ kind: marker === '**' ? 'strong' : marker === '~~' ? 'strike' : 'em', children: parseMarkdownInline(text.slice(position + marker.length, close), depth + 1, budget) }); position = close + marker.length; plainStart = position; continue }
    }
    position++
  }
  plain(text.length)
  return result
}

function blockStart(line: string): boolean { return /^(?:\s*$| {0,3}(?:#{1,6}\s|`{3,}|~{3,}|>\s?|[-*+]\s+|\d+\.\s+)| {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(line) }

export function parseSafeMarkdown(value: string): { blocks: MarkdownBlock[]; truncated: boolean; displayedCharacters: number } {
  let preview = value.slice(0, markdownPreviewCharacterLimit)
  if (preview.length < value.length && /[\uD800-\uDBFF]/.test(preview.at(-1) ?? '')) preview = preview.slice(0, -1)
  const lines = preview.replace(/\r\n?/g, '\n').split('\n'), blocks: MarkdownBlock[] = [], budget = { remaining: maximumInlineTokens }
  let index = 0
  while (index < lines.length && blocks.length < maximumBlocks) {
    const line = lines[index]
    if (!line.trim()) { index++; continue }
    const fence = /^ {0,3}(`{3,}|~{3,})([^\s]*)\s*$/.exec(line)
    if (fence) {
      const content: string[] = []; index++
      const end = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`)
      while (index < lines.length && !end.test(lines[index])) content.push(lines[index++])
      if (index < lines.length) index++
      blocks.push({ kind: 'code', text: content.join('\n'), language: fence[2].slice(0, 32) }); continue
    }
    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push({ kind: 'divider' }); index++; continue }
    const heading = /^ {0,3}(#{1,6})\s+(.*)$/.exec(line)
    if (heading) { blocks.push({ kind: 'heading', level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6, children: parseMarkdownInline(heading[2], 0, budget) }); index++; continue }
    if (/^ {0,3}>/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^ {0,3}>/.test(lines[index])) quote.push(lines[index++].replace(/^ {0,3}>\s?/, ''))
      blocks.push({ kind: 'quote', children: parseMarkdownInline(quote.join('\n'), 0, budget) }); continue
    }
    const list = /^ {0,3}([-*+]|\d+\.)\s+(.*)$/.exec(line)
    if (list) {
      const ordered = /^\d/.test(list[1]), items: MarkdownInline[][] = []
      while (index < lines.length) {
        const item = /^ {0,3}([-*+]|\d+\.)\s+(.*)$/.exec(lines[index])
        if (!item || /^\d/.test(item[1]) !== ordered) break
        items.push(parseMarkdownInline(item[2], 0, budget)); index++
      }
      blocks.push({ kind: 'list', ordered, start: ordered ? Math.min(1_000_000, Number.parseInt(list[1], 10)) : 1, items }); continue
    }
    const paragraph = [line]; index++
    while (index < lines.length && !blockStart(lines[index])) paragraph.push(lines[index++])
    blocks.push({ kind: 'paragraph', children: parseMarkdownInline(paragraph.join('\n'), 0, budget) })
  }
  // Excess structure remains visible as plain text instead of creating thousands
  // of React elements. This does not alter the editor, clipboard or download.
  if (index < lines.length) blocks.push({ kind: 'paragraph', children: [{ kind: 'text', text: lines.slice(index).join('\n') }] })
  return { blocks, truncated: value.length > preview.length, displayedCharacters: preview.length }
}
