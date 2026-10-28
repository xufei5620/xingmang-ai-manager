import { describe, expect, it } from 'vitest'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { EditorNodeRecord } from '../domain/node-definition'
import { officialPromptSnapshot, promptDocument, replacePromptSelection } from '../library/prompt-references'
import { maximumPromptPresetLength } from '../library/prompt-preset-contract'
import { maximumPromptLength } from '../persistence/workflow-schema'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, redoCanvasHistory, undoCanvasHistory } from '../store/history'
import { buildOutputTextNode, inspectNodeTextOutput, textOutputDownload, textOutputPresetInput } from './output-text-nodes'

function source(data: Record<string, unknown> = {}, kind = 'text-generate'): EditorNodeRecord {
  return { ...builtinNodeRegistry.create(kind, 'source', { x: 10, y: 20 }), data: { prompt: '原始输入', outputText: '  # 完整结果\n\n正文 🌟\n', status: 'succeeded', ...data } }
}

describe('text output snapshot workflow', () => {
  it('reuses output-node text while rejecting a synthetic editable input and retaining stale-result feedback', () => {
    const node = source({ dirty: true }, 'output')
    const snapshot = inspectNodeTextOutput('output', node.data, 'result')
    expect(snapshot).toMatchObject({ text: node.data.outputText, label: '上次文字结果', stale: true, canCopy: true, canPlace: true })
    expect(inspectNodeTextOutput('output', node.data, 'input').available).toBe(false)
    expect(textOutputDownload(snapshot).text).toBe(node.data.outputText)
    expect(textOutputPresetInput(snapshot).prompt).toBe(node.data.outputText)
    expect(buildOutputTextNode([node], 'source', 'result', 'copy').nodes[0].data.prompt).toBe(node.data.outputText)
  })
  it('keeps expanded official prompt prose as the sole truth for input, copying and presets', () => {
    const official = officialPromptSnapshot('xingmang-product-studio')!
    const document = replacePromptSelection(promptDocument('前言\n'), 3, 3, '', official).document
    for (const kind of ['prompt', 'text', 'text-generate']) {
      const snapshot = inspectNodeTextOutput(kind, { prompt: document.prompt, promptReferences: document.references }, 'input')
      expect(snapshot.text).toBe('前言\n' + official.prompt)
      expect(snapshot.canSavePreset).toBe(true)
      expect(textOutputPresetInput(snapshot).prompt).toBe(document.prompt)
      expect(textOutputDownload(snapshot).text).toBe(document.prompt)
    }
    expect(inspectNodeTextOutput('prompt', { prompt: '用户实际正文', promptReferences: [{ prompt: '不可信替代正文' }] }, 'input').text).toBe('用户实际正文')
  })

  it('separates input and generated output without leaking prior result into an empty input', () => {
    expect(inspectNodeTextOutput('text-generate', source().data, 'input')).toMatchObject({ text: '原始输入', label: '输入指令', stale: false })
    expect(inspectNodeTextOutput('text-generate', source().data, 'result')).toMatchObject({ text: '  # 完整结果\n\n正文 🌟\n', label: '生成结果', stale: false })
    expect(inspectNodeTextOutput('text-generate', source({ prompt: '' }).data, 'input').available).toBe(false)
    expect(inspectNodeTextOutput('prompt', { prompt: '正文', outputText: '遗留结果' }, 'result').available).toBe(false)
    expect(inspectNodeTextOutput('image-generate', { prompt: '图像指令' }, 'input').available).toBe(false)
  })

  it('keeps dirty and failed results readable while marking only dirty nonempty results stale', () => {
    const dirty = inspectNodeTextOutput('text-generate', source({ dirty: true }).data, 'result')
    expect(dirty).toMatchObject({ label: '上次生成结果', stale: true, available: true, canPlace: true, canSavePreset: true })
    const failed = inspectNodeTextOutput('text-generate', source({ status: 'failed', errorMessage: '本次失败' }).data, 'result')
    expect(failed).toMatchObject({ label: '上次生成结果', stale: false, available: true, canCopy: true, canPlace: true })
    expect(inspectNodeTextOutput('text-generate', source({ dirty: true, outputText: '  ' }).data, 'result').stale).toBe(false)
    expect(inspectNodeTextOutput('text-generate', source({ dirty: true }).data, 'input').stale).toBe(false)
  })

  it.each(['running', 'queued'])('permits reading and downloading previous output during %s but rejects mutations', (status) => {
    const snapshot = inspectNodeTextOutput('text-generate', source({ status }).data, 'result')
    expect(snapshot).toMatchObject({ label: '上次生成结果', running: true, canCopy: true, canPlace: false, canSavePreset: false })
    expect(textOutputDownload(snapshot).text).toBe(snapshot.text)
    expect(() => textOutputPresetInput(snapshot)).toThrow('正在生成')
    expect(() => buildOutputTextNode([source({ status })], 'source', 'result', 'copy')).toThrow('正在生成')
  })

  it.each(['', ' \r\n\t ', 'a\0b', 'a'.repeat(maximumPromptLength + 1)])('refuses blank, invalid or oversized content without silently truncating', (prompt) => {
    const snapshot = inspectNodeTextOutput('prompt', { prompt }, 'input')
    expect(snapshot).toMatchObject({ available: false, canCopy: false, canPlace: false, canSavePreset: false })
    expect(() => textOutputDownload(snapshot)).toThrow()
    expect(() => buildOutputTextNode([source({ prompt }, 'prompt')], 'source', 'input', 'copy')).toThrow()
  })

  it('places full 32k generated output and 100k prompt input in independently editable snapshots', () => {
    for (const [kind, selection, data, text] of [
      ['text-generate', 'result', { outputText: '生'.repeat(32_000) }, '生'.repeat(32_000)],
      ['prompt', 'input', { prompt: '入'.repeat(maximumPromptLength) }, '入'.repeat(maximumPromptLength)],
    ] as const) {
      const nodes = [source(data, kind)], before = structuredClone(nodes)
      const command = buildOutputTextNode(nodes, 'source', selection, 'copy')
      expect(command.edges).toBeUndefined()
      expect(command.nodes).toHaveLength(1)
      expect(command.nodes[0]).toMatchObject({ type: 'prompt', data: { prompt: text, model: '', status: 'idle', dirty: false } })
      for (const key of ['promptReferences', 'outputText', 'runId', 'attemptId', 'result', 'candidateAssetIds']) expect(command.nodes[0].data).not.toHaveProperty(key)
      expect(nodes).toEqual(before)
      const snapshot = inspectNodeTextOutput(kind, data, selection)
      expect(snapshot.canPlace).toBe(true)
      expect(snapshot.canSavePreset).toBe(false)
      expect(() => textOutputPresetInput(snapshot)).toThrow('不会被截断')
    }
  })

  it('points an oversized preset at copying instead of downloading where the host blocks page downloads', () => {
    const data = { outputText: '生'.repeat(maximumPromptPresetLength + 1) }
    expect(inspectNodeTextOutput('text-generate', data, 'result').presetReason).toBe('提示词最多 24,000 字符，当前内容不会被截断；可下载或放到画布后编辑')
    const snapshot = inspectNodeTextOutput('text-generate', data, 'result', false)
    expect(snapshot.presetReason).toBe('提示词最多 24,000 字符，当前内容不会被截断；可复制或放到画布后编辑')
    expect(() => textOutputPresetInput(snapshot, undefined, false)).toThrow('提示词最多 24,000 字符，当前内容不会被截断；可复制或放到画布后编辑')
  })

  it('enforces the exact preset limit from current text even when a dialog modifies a prior snapshot', () => {
    const snapshot = inspectNodeTextOutput('prompt', { prompt: ' 文'.repeat(maximumPromptPresetLength / 2) }, 'input')
    expect(textOutputPresetInput(snapshot, '完整提示词')).toEqual({ name: '完整提示词', prompt: snapshot.text, tags: [] })
    expect(() => textOutputPresetInput({ ...snapshot, text: snapshot.text + '超限', length: 1, canSavePreset: true })).toThrow('不会被截断')
    expect(() => textOutputPresetInput({ ...snapshot, text: ' \n ' })).toThrow('没有可用')
    expect(() => textOutputPresetInput(snapshot, '名'.repeat(161))).toThrow('名称')
  })

  it('adds one top-level snapshot outside locked nested groups and restores it in one undo/redo', () => {
    const nodes = [
      { ...builtinNodeRegistry.create('group', 'outer', { x: 1000, y: 700 }), width: 900, height: 900, locked: true },
      { ...builtinNodeRegistry.create('group', 'inner', { x: 100, y: 100 }), width: 600, height: 600, parentId: 'outer', locked: true },
      { ...source(), parentId: 'inner', locked: true },
    ]
    const before = structuredClone(nodes)
    const command = buildOutputTextNode(nodes, 'source', 'result', 'copy')
    const node = command.nodes[0]
    expect(node.parentId).toBeUndefined(); expect(node.locked).toBeUndefined()
    expect(node.position.x + node.width! + 28 <= 1000 || node.position.x >= 1928 || node.position.y + node.height! + 28 <= 700 || node.position.y >= 1628).toBe(true)
    expect(nodes).toEqual(before)
    let history = createCanvasHistory({ ...createCanvasDocument(), nodes })
    history = applyCanvasCommand(history, command); expect(history.present.nodes).toHaveLength(4)
    history = undoCanvasHistory(history); expect(history.present.nodes).toEqual(before)
    history = redoCanvasHistory(history); expect(history.present.nodes[3]).toEqual(node)
  })

  it('refuses disappeared sources, duplicate ids and malformed parent graphs before creating any node', () => {
    expect(() => buildOutputTextNode([], 'source', 'result', 'copy')).toThrow('原文字')
    expect(() => buildOutputTextNode([source()], 'source', 'result', 'source')).toThrow('标识')
    expect(() => buildOutputTextNode([{ ...source(), parentId: 'missing' }], 'source', 'result', 'copy')).toThrow('层级')
    expect(() => buildOutputTextNode([source(), source()], 'source', 'result', 'copy')).toThrow('层级')
  })

  it('preserves all whitespace and unicode in the downloadable body while removing filename separators', () => {
    const snapshot = inspectNodeTextOutput('text-generate', source().data, 'result')
    const download = textOutputDownload(snapshot, '../文稿\\内容:*?\0')
    expect(download).toMatchObject({ text: snapshot.text, mimeType: 'text/plain;charset=utf-8' })
    expect(download.fileName.endsWith('-生成结果.txt')).toBe(true)
    expect(download.fileName).not.toMatch(/[\x00-\x1f/\\:*?"<>|]/)
  })
})
