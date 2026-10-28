export type CanvasTextFormat = 'bold' | 'italic' | 'strike' | 'inline-code' | 'h1' | 'h2' | 'h3' | 'unordered' | 'ordered' | 'quote' | 'link' | 'image' | 'code-block' | 'divider'
export interface CanvasTextSelection { text: string; start: number; end: number }
export interface CanvasTextHistory { past: CanvasTextSelection[]; present: CanvasTextSelection; future: CanvasTextSelection[]; lastEdit: number; typing: boolean }
export const maximumCanvasTextLength = 100_000
const historyCharacterBudget = 2_000_000

export function canvasTextSelection(text: string, start = text.length, end = start): CanvasTextSelection {
  function boundary(value: number) {
    let next = Math.max(0, Math.min(text.length, Number.isFinite(value) ? Math.trunc(value) : 0))
    if (next > 0 && next < text.length && /[\uD800-\uDBFF]/.test(text[next - 1]) && /[\uDC00-\uDFFF]/.test(text[next])) next -= 1
    return next
  }
  const left = boundary(Math.min(start, end)), right = boundary(Math.max(start, end))
  return { text, start: left, end: right }
}

function replaceSelection(value: CanvasTextSelection, replacement: string, start = replacement.length, end = start): CanvasTextSelection {
  return canvasTextSelection(value.text.slice(0, value.start) + replacement + value.text.slice(value.end), value.start + start, value.start + end)
}

function wrapSelection(value: CanvasTextSelection, marker: string, placeholder: string): CanvasTextSelection {
  const selected = value.text.slice(value.start, value.end)
  if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= marker.length * 2) return replaceSelection(value, selected.slice(marker.length, -marker.length), 0, selected.length - marker.length * 2)
  if (value.start >= marker.length && value.text.slice(value.start - marker.length, value.start) === marker && value.text.slice(value.end, value.end + marker.length) === marker) {
    return replaceSelection({ ...value, start: value.start - marker.length, end: value.end + marker.length }, selected, 0, selected.length)
  }
  const body = selected || placeholder
  return replaceSelection(value, marker + body + marker, marker.length, marker.length + body.length)
}

function formatLines(value: CanvasTextSelection, format: CanvasTextFormat): CanvasTextSelection {
  const start = value.start === 0 ? 0 : value.text.lastIndexOf('\n', value.start - 1) + 1
  const selectedEnd = value.end > value.start && value.text[value.end - 1] === '\n' ? value.end - 1 : value.end
  const nextLine = value.text.indexOf('\n', selectedEnd), end = nextLine < 0 ? value.text.length : nextLine
  const lines = value.text.slice(start, end).split('\n')
  const heading = format === 'h1' ? '# ' : format === 'h2' ? '## ' : format === 'h3' ? '### ' : ''
  const pattern = heading ? new RegExp(`^${heading.replace(/ /g, '\\s')}`) : format === 'quote' ? /^>\s?/ : format === 'ordered' ? /^\d+\.\s+/ : /^[-*+]\s+/
  const remove = lines.every((line) => !line.trim() || pattern.test(line)) && lines.some((line) => pattern.test(line))
  const updated = lines.map((line, index) => {
    if (remove) return line.replace(pattern, '')
    const body = heading ? line.replace(/^#{1,6}\s+/, '') : format === 'ordered' || format === 'unordered' ? line.replace(/^(?:[-*+]|\d+\.)\s+/, '') : line
    return (heading || (format === 'quote' ? '> ' : format === 'ordered' ? `${index + 1}. ` : '- ')) + body
  }).join('\n')
  return replaceSelection({ ...value, start, end }, updated, 0, updated.length)
}

export function formatCanvasText(input: CanvasTextSelection, format: CanvasTextFormat, maxLength = maximumCanvasTextLength): CanvasTextSelection {
  const value = canvasTextSelection(input.text, input.start, input.end)
  let next: CanvasTextSelection
  if (format === 'bold' || format === 'italic' || format === 'strike') next = wrapSelection(value, format === 'bold' ? '**' : format === 'italic' ? '*' : '~~', '文字')
  else if (format === 'inline-code') {
    const selected = value.text.slice(value.start, value.end)
    const longest = Math.max(0, ...(selected.match(/`+/g) ?? []).map((part) => part.length))
    next = wrapSelection(value, '`'.repeat(longest + 1), '代码')
  } else if (format === 'link' || format === 'image') {
    const body = value.text.slice(value.start, value.end) || (format === 'image' ? '图片说明' : '链接文字')
    const prefix = format === 'image' ? '![' : '['
    const replacement = `${prefix}${body}](https://)`
    next = replaceSelection(value, replacement, prefix.length + body.length + 2, replacement.length - 1)
  } else if (format === 'code-block' || format === 'divider') {
    const body = value.text.slice(value.start, value.end) || '代码'
    const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((part) => part.length)), fence = '`'.repeat(longest + 1)
    const before = value.start > 0 ? (value.text[value.start - 1] === '\n' ? '\n' : '\n\n') : ''
    const after = value.end < value.text.length ? (value.text[value.end] === '\n' ? '\n' : '\n\n') : ''
    const replacement = format === 'divider' ? `${before}---${after}` : `${before}${fence}\n${body}\n${fence}${after}`
    const selectionStart = format === 'divider' ? replacement.length : before.length + fence.length + 1
    next = replaceSelection(value, replacement, selectionStart, format === 'divider' ? selectionStart : selectionStart + body.length)
  } else next = formatLines(value, format)
  if (next.text.length > maxLength) throw new Error(`格式操作后超过 ${maxLength.toLocaleString('zh-CN')} 字符上限，请先缩短文字`)
  return next
}

function boundHistory(entries: CanvasTextSelection[]): CanvasTextSelection[] {
  let length = 0, start = entries.length
  while (start > 0 && entries.length - start < 80 && length + entries[start - 1].text.length <= historyCharacterBudget) length += entries[--start].text.length
  return entries.slice(start)
}

export function createCanvasTextHistory(text: string): CanvasTextHistory { return { past: [], present: canvasTextSelection(text), future: [], lastEdit: 0, typing: false } }

export function rememberCanvasText(history: CanvasTextHistory, next: CanvasTextSelection, typing = false, time = Date.now()): CanvasTextHistory {
  if (next.text === history.present.text) return { ...history, present: next }
  const contiguous = history.present.start === history.present.end && next.start === next.end && Math.abs(next.text.length - history.present.text.length) <= 2 && Math.abs(next.start - history.present.start) <= 2
  const merge = typing && history.typing && contiguous && time - history.lastEdit < 800 && time >= history.lastEdit && history.past.length > 0
  return { past: merge ? history.past : boundHistory([...history.past, history.present]), present: next, future: [], lastEdit: time, typing }
}

export function restoreCanvasText(history: CanvasTextHistory, redo = false): CanvasTextHistory {
  const source = redo ? history.future : history.past, present = source.at(-1)
  if (!present) return { ...history, typing: false }
  return redo
    ? { past: boundHistory([...history.past, history.present]), present, future: source.slice(0, -1), lastEdit: 0, typing: false }
    : { past: source.slice(0, -1), present, future: boundHistory([...history.future, history.present]), lastEdit: 0, typing: false }
}

export function canvasTextKeyIsComposing(event: { isComposing?: boolean; keyCode?: number }): boolean { return event.isComposing === true || event.keyCode === 229 }
