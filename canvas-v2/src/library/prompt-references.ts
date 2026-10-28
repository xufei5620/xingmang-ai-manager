import { builtinPromptPresetsV1 } from './prompt-presets'

/** prompt is always the expanded executable text; references only control editing. */
export interface PromptReference {
  start: number
  end: number
  presetId: string
  version: number
  name: string
  prompt: string
}

export interface PromptDocument { prompt: string; references: PromptReference[] }
export interface PromptDisplayRange { start: number; end: number; reference: PromptReference }
export interface PromptProjection { text: string; ranges: PromptDisplayRange[] }
export interface PromptEdit { document: PromptDocument; caret: number }
export const maximumPromptReferences = 64

// v1 is an immutable publication. When official wording changes, add a new
// publication instead of changing the v1 registry: saved snapshots must remain
// recognizable independently of which publication the picker currently uses.
const officialV1 = builtinPromptPresetsV1.map((preset) => ({ presetId: preset.id, version: 1, name: preset.title, prompt: preset.prompt }))

export function officialPromptSnapshot(presetId: string, version = 1): Omit<PromptReference, 'start' | 'end'> | null {
  const found = officialV1.find((preset) => preset.presetId === presetId && preset.version === version)
  return found ? { ...found } : null
}

export function parsePromptReferences(prompt: string, input: unknown): PromptReference[] {
  if (!Array.isArray(input) || input.length > maximumPromptReferences) return []
  const result: PromptReference[] = []
  for (const value of input) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const item = value as Record<string, unknown>
    if (!Number.isInteger(item.start) || !Number.isInteger(item.end) || typeof item.presetId !== 'string' || typeof item.version !== 'number') continue
    const start = item.start as number
    const end = item.end as number
    const snapshot = officialPromptSnapshot(item.presetId, item.version)
    if (!snapshot || item.name !== snapshot.name || item.prompt !== snapshot.prompt || start < 0 || end <= start || end > prompt.length || prompt.slice(start, end) !== snapshot.prompt) continue
    result.push({ start, end, ...snapshot })
  }
  result.sort((left, right) => left.start - right.start)
  // Ambiguous overlapping metadata never changes or hides the actual prose.
  return result.filter((entry, index) => (index === 0 || result[index - 1].end <= entry.start) && (index === result.length - 1 || entry.end <= result[index + 1].start))
}

export function promptDocument(prompt: string, references?: unknown): PromptDocument {
  return { prompt, references: parsePromptReferences(prompt, references) }
}

export function promptReferenceLabel(reference: PromptReference): string { return `#${reference.name} 官方` }

export function projectPrompt(document: PromptDocument): PromptProjection {
  let text = ''
  let cursor = 0
  const ranges: PromptDisplayRange[] = []
  for (const reference of parsePromptReferences(document.prompt, document.references)) {
    text += document.prompt.slice(cursor, reference.start)
    const start = text.length
    text += promptReferenceLabel(reference)
    ranges.push({ start, end: text.length, reference })
    cursor = reference.end
  }
  return { text: text + document.prompt.slice(cursor), ranges }
}

export function promptSelection(projection: PromptProjection, start: number, end = start, direction: 'nearest' | 'backward' | 'forward' = 'nearest'): { start: number; end: number } {
  let from = Math.max(0, Math.min(projection.text.length, Math.min(start, end)))
  let to = Math.max(from, Math.min(projection.text.length, Math.max(start, end)))
  if (from === to) {
    const hit = projection.ranges.find((range) => from > range.start && from < range.end)
    if (hit) from = to = direction === 'backward' ? hit.start : direction === 'forward' ? hit.end : from - hit.start < hit.end - from ? hit.start : hit.end
  } else {
    const hits = projection.ranges.filter((range) => range.start < to && range.end > from)
    if (hits.length) { from = Math.min(from, hits[0].start); to = Math.max(to, hits[hits.length - 1].end) }
  }
  return { start: from, end: to }
}

function expandedOffset(projection: PromptProjection, offset: number): number {
  let shift = 0
  for (const range of projection.ranges) {
    if (range.end > offset) break
    shift += range.reference.prompt.length - (range.end - range.start)
  }
  return offset + shift
}

export function replacePromptSelection(document: PromptDocument, start: number, end: number, text: string, official?: Omit<PromptReference, 'start' | 'end'>): PromptEdit {
  const projection = projectPrompt(document)
  const selection = promptSelection(projection, start, end)
  const from = expandedOffset(projection, selection.start)
  const to = expandedOffset(projection, selection.end)
  const replacement = official?.prompt ?? text
  const prompt = document.prompt.slice(0, from) + replacement + document.prompt.slice(to)
  const shift = replacement.length - (to - from)
  const references = parsePromptReferences(document.prompt, document.references).flatMap((reference) => reference.end <= from ? [{ ...reference }] : reference.start >= to ? [{ ...reference, start: reference.start + shift, end: reference.end + shift }] : [])
  if (official) references.push({ start: from, end: from + replacement.length, ...official })
  return { document: promptDocument(prompt, references), caret: selection.start + (official ? promptReferenceLabel({ start: from, end: from + replacement.length, ...official }).length : text.length) }
}

/** Apply the browser's plain textarea delta; never interpret pasted labels as references. */
export function applyPromptDisplayInput(document: PromptDocument, text: string, caret: number): PromptEdit {
  const projection = projectPrompt(document)
  const previous = projection.text
  if (previous === text) return { document, caret }
  let start = 0
  while (start < previous.length && start < text.length && previous[start] === text[start]) start += 1
  let beforeEnd = previous.length
  let afterEnd = text.length
  while (beforeEnd > start && afterEnd > start && previous[beforeEnd - 1] === text[afterEnd - 1]) { beforeEnd -= 1; afterEnd -= 1 }
  const selection = promptSelection(projection, start, beforeEnd)
  // A typed replacement can share a prefix/suffix with the short label ("#"
  // or "方"). Expanding only the old range would discard that newly typed
  // text. Carry the matching parts into the replacement's new-text range too.
  const replacementStart = start === beforeEnd ? start : selection.start
  const replacementEnd = start === beforeEnd ? afterEnd : afterEnd + selection.end - beforeEnd
  const edited = replacePromptSelection(document, selection.start, selection.end, text.slice(replacementStart, replacementEnd))
  const displayed = projectPrompt(edited.document).text
  return { ...edited, caret: Math.max(0, Math.min(displayed.length, displayed === text ? caret : caret + edited.caret - replacementEnd)) }
}

export function promptReferenceContainsCaret(document: PromptDocument, caret: number): boolean {
  // Both boundaries are valid insertion positions outside the atomic label.
  return projectPrompt(document).ranges.some((range) => caret > range.start && caret < range.end)
}

export interface PromptExternalSync { observed: string; awaiting: string[] }
export function createPromptExternalSync(document: PromptDocument): PromptExternalSync { return { observed: JSON.stringify(document), awaiting: [] } }
export function publishPromptDocument(sync: PromptExternalSync, document: PromptDocument): void {
  const signature = JSON.stringify(document)
  if (sync.awaiting[sync.awaiting.length - 1] !== signature) sync.awaiting.push(signature)
  if (sync.awaiting.length > 80) sync.awaiting.shift()
}
export function receivePromptDocument(sync: PromptExternalSync, document: PromptDocument): 'repeat' | 'acknowledged' | 'external' {
  const signature = JSON.stringify(document)
  if (signature === sync.observed) return 'repeat'
  sync.observed = signature
  const acknowledged = sync.awaiting.lastIndexOf(signature)
  if (acknowledged >= 0) { sync.awaiting.splice(0, acknowledged + 1); return 'acknowledged' }
  sync.awaiting = []
  return 'external'
}

export function deletePromptReference(document: PromptDocument, start: number, end: number, direction: 'backward' | 'forward'): PromptEdit | null {
  const projection = projectPrompt(document)
  const from = Math.min(start, end)
  const to = Math.max(start, end)
  const hit = projection.ranges.find((range) => from !== to ? range.start < to && range.end > from : direction === 'backward' ? range.start < from && from <= range.end : range.start <= from && from < range.end)
  if (!hit) return null
  return replacePromptSelection(document, Math.min(from, hit.start), Math.max(to, hit.end), '')
}

export function copyPromptSelection(document: PromptDocument, start: number, end: number): string {
  const projection = projectPrompt(document)
  const selection = promptSelection(projection, start, end)
  return document.prompt.slice(expandedOffset(projection, selection.start), expandedOffset(projection, selection.end))
}

/** Normalize editable text only. Official bodies are immutable even if they contain @. */
export function transformPromptText(document: PromptDocument, caret: number | null, transform: (text: string, caret: number | null) => { value: string; caret: number | null }): { document: PromptDocument; caret: number | null } {
  const projection = projectPrompt(document)
  let prompt = ''
  let displayLength = 0
  let cursor = 0
  let displayCursor = 0
  let nextCaret = caret
  const references: PromptReference[] = []
  for (const range of [...projection.ranges, null]) {
    const end = range?.reference.start ?? document.prompt.length
    const displayEnd = range?.start ?? projection.text.length
    const ownsCaret = caret !== null && caret >= displayCursor && caret <= displayEnd
    const transformed = transform(document.prompt.slice(cursor, end), ownsCaret ? caret - displayCursor : null)
    if (ownsCaret && transformed.caret !== null) nextCaret = displayLength + transformed.caret
    prompt += transformed.value
    displayLength += transformed.value.length
    if (range) {
      const reference = { ...range.reference, start: prompt.length, end: prompt.length + range.reference.prompt.length }
      references.push(reference)
      prompt += reference.prompt
      displayLength += range.end - range.start
      cursor = range.reference.end
      displayCursor = range.end
    }
  }
  return { document: { prompt, references }, caret: nextCaret }
}

export interface PromptHistoryEntry { document: PromptDocument; caret: number }
export interface PromptEditHistory { undo: PromptHistoryEntry[]; redo: PromptHistoryEntry[] }
export function rememberPromptEdit(history: PromptEditHistory, entry: PromptHistoryEntry): void {
  history.undo.push({ document: promptDocument(entry.document.prompt, entry.document.references), caret: entry.caret })
  if (history.undo.length > 80) history.undo.shift()
  history.redo = []
}
export function restorePromptEdit(history: PromptEditHistory, current: PromptHistoryEntry, direction: 'undo' | 'redo'): PromptHistoryEntry | null {
  const entry = history[direction].pop()
  if (!entry) return null
  history[direction === 'undo' ? 'redo' : 'undo'].push(current)
  return entry
}
