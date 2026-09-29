import katex from 'katex'

export type ChatMathKind = 'dollar' | 'paren' | 'display' | 'bracket'
export interface ChatMath { kind: ChatMathKind; tex: string; display: boolean; source: string }

// Math travels through markdown as an inline code span tagged with a private
// use character. Code span text is literal, so markdown never eats the
// backslashes, underscores and asterisks TeX is made of, and the marker cannot
// be typed by accident. A reply that already contains the marker is left alone.
const marker = ''
const codes: Record<ChatMathKind, string> = { dollar: 'i', paren: 'p', display: 'd', bracket: 'b' }
const delimiters: Record<ChatMathKind, [string, string]> = { dollar: ['$', '$'], paren: ['\\(', '\\)'], display: ['$$', '$$'], bracket: ['\\[', '\\]'] }
const longest = 4000
const blankLine = /\n[ \t]*\n/y

export function prepareChatMath(content: string): string {
  if (content.includes(marker) || !/[$\\]/.test(content)) return content
  const lines = content.split('\n')
  const output: string[] = []
  let prose: string[] = []
  let fence: { char: string; size: number } | null = null
  for (const line of lines) {
    const opening = /^[\s>]*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      output.push(line)
      if (opening && opening[1][0] === fence.char && opening[1].length >= fence.size && !line.slice(opening.index + opening[0].length).trim()) fence = null
      continue
    }
    if (opening && !(opening[1][0] === '`' && line.slice(opening.index + opening[0].length).includes('`'))) {
      if (prose.length) output.push(convertProse(prose.join('\n')))
      prose = []
      output.push(line)
      fence = { char: opening[1][0], size: opening[1].length }
      continue
    }
    prose.push(line)
  }
  if (prose.length) output.push(convertProse(prose.join('\n')))
  return output.join('\n')
}

export function readChatMath(code: unknown): ChatMath | null {
  if (typeof code !== 'string' || code[0] !== marker) return null
  const kind = (Object.keys(codes) as ChatMathKind[]).find((key) => codes[key] === code[1])
  if (!kind) return null
  const tex = code.slice(2)
  const [open, close] = delimiters[kind]
  return { kind, tex, display: kind === 'display' || kind === 'bracket', source: `${open}${tex}${close}` }
}

// MathML needs no font files, so the page CSP stays as it is. trust stays off:
// it is what keeps \href, \url and the \html* commands from reaching the page.
export function renderChatMath(math: ChatMath): string | null {
  try {
    return katex.renderToString(math.tex, { displayMode: math.display, output: 'mathml', throwOnError: true, trust: false, strict: 'ignore', maxExpand: 500, maxSize: 20 })
  } catch {
    return null
  }
}

function convertProse(text: string): string {
  let result = ''
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '`') {
      let size = 1
      while (text[index + size] === '`') size += 1
      const end = findBacktickRun(text, index + size, size)
      const stop = end === -1 ? index + size : end + size
      result += text.slice(index, stop)
      index = stop
      continue
    }
    const found = char === '\\' ? matchBackslash(text, index) : char === '$' ? matchDollar(text, index) : null
    if (found) {
      result += encode(found.kind, found.tex)
      index = found.end
      continue
    }
    if (char === '\\' && index + 1 < text.length) {
      result += text.slice(index, index + 2)
      index += 2
      continue
    }
    result += char
    index += 1
  }
  return result
}

function findBacktickRun(text: string, from: number, size: number): number {
  const pattern = /`+/g
  pattern.lastIndex = from
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) if (match[0].length === size) return match.index
  return -1
}

interface Found { kind: ChatMathKind; tex: string; end: number }

function matchBackslash(text: string, index: number): Found | null {
  const next = text[index + 1]
  if (next !== '(' && next !== '[') return null
  const kind: ChatMathKind = next === '(' ? 'paren' : 'bracket'
  const close = kind === 'paren' ? '\\)' : '\\]'
  const end = text.indexOf(close, index + 2)
  if (end === -1) return null
  return accept(kind, text.slice(index + 2, end), end + 2)
}

// A single $ follows Pandoc: the opening one is followed by a non-space, the
// closing one follows a non-space and is not followed by a digit. Replies here
// talk about balances all the time, so "$5 到 $10" must stay text; any $ that
// cannot close the span gives the opener up instead of swallowing it.
function matchDollar(text: string, index: number): Found | null {
  if (text[index - 1] === '$') return null
  if (text[index + 1] === '$') {
    if (text[index + 2] === '$') return null
    const end = text.indexOf('$$', index + 2)
    if (end === -1) return null
    return accept('display', text.slice(index + 2, end), end + 2)
  }
  const first = text[index + 1]
  if (first === undefined || /\s/.test(first)) return null
  for (let cursor = index + 1; cursor < text.length; cursor += 1) {
    const char = text[cursor]
    if (char === '\\') { cursor += 1; continue }
    if (char === '`') return null
    if (char === '\n') { blankLine.lastIndex = cursor; if (blankLine.test(text)) return null }
    if (char !== '$') continue
    if (/\s/.test(text[cursor - 1]) || /\d/.test(text[cursor + 1] ?? '')) return null
    return accept('dollar', text.slice(index + 1, cursor), cursor + 1)
  }
  return null
}

function accept(kind: ChatMathKind, raw: string, end: number): Found | null {
  const tex = raw.trim()
  if (!tex || tex.length > longest || /\n[ \t]*\n/.test(raw) || /(^|[^\\])\$/.test(tex)) return null
  return { kind, tex, end }
}

// Newlines become spaces, which TeX reads the same way, so a formula spread
// over lines stays one code span and no line of it starts a list or heading.
function encode(kind: ChatMathKind, tex: string): string {
  const body = `${marker}${codes[kind]}${tex.replace(/\s*\n\s*/g, ' ')}`
  const longestRun = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longestRun + 1)
  return `${fence} ${body} ${fence}`
}
