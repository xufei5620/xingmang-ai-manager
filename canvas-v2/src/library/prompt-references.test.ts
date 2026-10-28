import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PromptEditor } from '../components/PromptEditor'
import { ensureMentionThumbSlots, mentionThumbSlot } from '../components/prompt-mentions'
import { applyPromptDisplayInput, copyPromptSelection, deletePromptReference, maximumPromptReferences, officialPromptSnapshot, parsePromptReferences, projectPrompt, promptDocument, promptSelection, rememberPromptEdit, replacePromptSelection, restorePromptEdit, transformPromptText, type PromptEditHistory } from './prompt-references'

const studio = officialPromptSnapshot('xingmang-product-studio')!
const light = officialPromptSnapshot('xingmang-scene-relight')!
function tagged(prefix = '前文 ', suffix = ' 后文') {
  return replacePromptSelection(promptDocument(prefix + suffix), prefix.length, prefix.length, '', studio).document
}

describe('official prompt reference editing', () => {
  it('stores the actual executable body and a versioned snapshot while projecting a short label', () => {
    const document = tagged()
    expect(document.prompt).toBe(`前文 ${studio.prompt} 后文`)
    expect(document.references).toEqual([{ start: 3, end: 3 + studio.prompt.length, ...studio }])
    expect(projectPrompt(document).text).toBe('前文 #商品棚拍 官方 后文')
    expect(studio.version).toBe(1)
    expect(officialPromptSnapshot(studio.presetId, 99)).toBeNull()
  })

  it('moves exact ranges when text is inserted before a tag and preserves additions after it', () => {
    const document = tagged()
    const before = applyPromptDisplayInput(document, `追加 ${projectPrompt(document).text}`, 3).document
    expect(before.references[0].start).toBe(6)
    const text = projectPrompt(before).text + '\n柔和灯光🌟'
    const after = applyPromptDisplayInput(before, text, text.length).document
    expect(after.references).toEqual(before.references)
    expect(after.prompt).toBe(`追加 前文 ${studio.prompt} 后文\n柔和灯光🌟`)
  })

  it('treats repeated official references as separate positions without replacing literal lookalikes', () => {
    const first = tagged('', '')
    const end = projectPrompt(first).text.length
    const second = replacePromptSelection(first, end, end, '', studio).document
    expect(second.references).toHaveLength(2)
    expect(second.prompt).toBe(studio.prompt.repeat(2))
    const pasted = replacePromptSelection(second, 0, 0, '#商品棚拍 官方 ').document
    expect(pasted.references).toHaveLength(2)
    expect(projectPrompt(pasted).text).toBe('#商品棚拍 官方 #商品棚拍 官方#商品棚拍 官方')
  })

  it('deletes a whole tag from either edge and restores surrounding text', () => {
    const document = tagged()
    const range = projectPrompt(document).ranges[0]
    for (const [caret, direction] of [[range.end, 'backward'], [range.start, 'forward'], [range.start + 2, 'backward']] as const) {
      const deleted = deletePromptReference(document, caret, caret, direction)!
      expect(deleted.document).toEqual({ prompt: '前文  后文', references: [] })
      expect(deleted.caret).toBe(3)
    }
    expect(deletePromptReference(document, 0, 0, 'backward')).toBeNull()
  })

  it('expands partial selections to the whole tag before cut, replacement or copy', () => {
    const document = tagged()
    const { start, end } = projectPrompt(document).ranges[0]
    expect(copyPromptSelection(document, start + 1, end - 1)).toBe(studio.prompt)
    expect(replacePromptSelection(document, start + 1, end - 1, '新的普通正文').document).toEqual({ prompt: '前文 新的普通正文 后文', references: [] })
    expect(promptSelection(projectPrompt(document), start + 2, end - 2)).toEqual({ start, end })
  })

  it('keeps the caret outside atomic references in both directions', () => {
    const projection = projectPrompt(tagged())
    const { start, end } = projection.ranges[0]
    expect(promptSelection(projection, start + 1)).toEqual({ start, end: start })
    expect(promptSelection(projection, end - 1)).toEqual({ start: end, end })
    expect(promptSelection(projection, start + 2, start + 2, 'forward')).toEqual({ start: end, end })
    expect(promptSelection(projection, end - 2, end - 2, 'backward')).toEqual({ start, end: start })
  })

  it('pastes plain text without treating labels, HTML or stored-looking JSON as official metadata', () => {
    const pasted = '#商品棚拍 官方 <b>文本</b> {"presetId":"xingmang-product-studio"}'
    const document = replacePromptSelection(tagged(), 0, 0, pasted).document
    expect(document.prompt.startsWith(pasted)).toBe(true)
    expect(document.references).toHaveLength(1)
    expect(document.references[0].start).toBe(pasted.length + 3)
    expect(promptDocument(pasted).references).toEqual([])
  })

  it('handles a native textarea replacement across multiple chips without retaining phantom references', () => {
    let document = tagged()
    document = replacePromptSelection(document, projectPrompt(document).text.length, projectPrompt(document).text.length, '', light).document
    const text = projectPrompt(document).text
    const edited = applyPromptDisplayInput(document, text.slice(0, 1) + '新内容', 4)
    expect(edited.document).toEqual({ prompt: '前新内容', references: [] })
    expect(edited.caret).toBe(4)
  })

  it('retains prose without rendering a badge for unknown, mutated or mismatched snapshots', () => {
    const document = tagged()
    for (const patch of [{ presetId: 'unknown' }, { version: 2 }, { name: '伪造名称' }, { prompt: '伪造正文' }, { start: 2 }, { end: 2 }, { end: Infinity }]) {
      expect(promptDocument(document.prompt, [{ ...document.references[0], ...patch }])).toEqual({ prompt: document.prompt, references: [] })
    }
    expect(promptDocument(document.prompt + '!', document.references).references).toHaveLength(1)
    expect(promptDocument(document.prompt.replace('产品外形', '用户修改'), document.references).references).toEqual([])
    expect(parsePromptReferences(document.prompt, Array(maximumPromptReferences + 1).fill(document.references[0]))).toEqual([])
    expect(parsePromptReferences(document.prompt, [document.references[0], document.references[0]])).toEqual([])
  })

  it('normalizes media mention slots on both sides without expanding or invalidating a middle official tag', () => {
    const mention = '@商品-图片-abcdef'
    const document = tagged(`${mention} `, ` ${mention}`)
    const caret = projectPrompt(document).text.length
    const normalized = transformPromptText(document, caret, (text, index) => ensureMentionThumbSlots(text, index))
    expect(normalized.document.prompt).toBe(`${mention}${mentionThumbSlot} ${studio.prompt} ${mention}${mentionThumbSlot}`)
    expect(normalized.document.references).toHaveLength(1)
    expect(normalized.document.references[0].start).toBe(mention.length + mentionThumbSlot.length + 1)
    // The existing mention editor leaves a caret at the mention text boundary
    // before its visual thumb slots; the earlier insertion still shifts it.
    expect(normalized.caret).toBe(caret + mentionThumbSlot.length)
  })

  it('undoes and redoes insertion, surrounding typing and expansion with the complete snapshot', () => {
    const history: PromptEditHistory = { undo: [], redo: [] }
    const original = { document: promptDocument('#'), caret: 1 }
    rememberPromptEdit(history, original)
    const inserted = replacePromptSelection(original.document, 0, 1, '', studio)
    rememberPromptEdit(history, inserted)
    const appended = replacePromptSelection(inserted.document, inserted.caret, inserted.caret, ' 灯光')
    rememberPromptEdit(history, appended)
    const expanded = { document: promptDocument(appended.document.prompt), caret: appended.document.prompt.length }
    const back = restorePromptEdit(history, expanded, 'undo')!
    expect(back).toEqual(appended)
    const insertion = restorePromptEdit(history, back, 'undo')!
    expect(insertion).toEqual(inserted)
    expect(restorePromptEdit(history, insertion, 'undo')).toEqual(original)
    expect(restorePromptEdit(history, original, 'redo')).toEqual(inserted)
    rememberPromptEdit(history, inserted)
    expect(history.redo).toEqual([])
  })

  it('renders atomic official chips and a visible expansion action while keeping legacy plain prompts plain', () => {
    const document = tagged()
    const html = renderToStaticMarkup(createElement(PromptEditor, { label: 'Prompt', value: document.prompt, promptReferences: document.references, references: [], placeholder: 'Write', onChange: vi.fn() }))
    expect(html).toContain('contentEditable="false"')
    expect(html).toContain('wf-prompt-official')
    expect(html).toContain('官方 v1')
    expect(html).toContain('展开全部官方标签为可编辑正文')
    expect(html).toContain('前文 #商品棚拍 官方 后文</textarea>')
    expect(html).not.toContain(studio.presetId)
    const legacy = renderToStaticMarkup(createElement(PromptEditor, { label: 'Prompt', value: document.prompt, references: [], placeholder: 'Write', onChange: vi.fn() }))
    expect(legacy).not.toContain('wf-prompt-official')
    expect(legacy).toContain(`${document.prompt}</textarea>`)
  })
})
