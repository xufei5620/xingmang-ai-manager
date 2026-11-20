import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { CanvasRunGraph } from '../host'
import { v2EquivalentCapabilities } from '../host-capabilities'
import { buildCanvasRunPreflight } from './run-preflight'
import { selectionToolbarActions } from '../components/selection-toolbar-model'

// 运行前检查写大白话（桌面 #1368 第 12 条）：不写「执行项」「服务端缓存」「链路」，阻塞的节点写种类不写内部编号。
// 「上游」也不写（桌面 0.2.25 总单第 54 项，Mac 验收 R12）：客户看不懂，改说「前面连着的节点」。

const jargon = /执行项|服务端缓存|未命中|链路|上游|停止等待不代表/

function graph(): CanvasRunGraph {
  return {
    nodes: [
      { id: 'image-generate-1730000000000', kind: 'image-generate', definitionVersion: 1, data: { prompt: '', model: 'gpt-image-2', group: 'provider' } },
      { id: 'cup', kind: 'image-generate', definitionVersion: 1, data: { prompt: 'A ceramic cup', model: 'gpt-image-2', group: 'provider' } },
    ],
    edges: [],
  }
}

function inspect(scope: Parameters<typeof buildCanvasRunPreflight>[0]['scope']) {
  return buildCanvasRunPreflight({ graph: graph(), scope, imageModels: ['gpt-image-2'], videoModels: [] })
}

function texts(result: ReturnType<typeof buildCanvasRunPreflight>): string[] {
  return [...result.warnings, ...result.items.map((item) => item.reason ?? '')]
}

describe('run preflight wording', () => {
  it('names a blocked node by its kind rather than its internal id', () => {
    const result = inspect({ kind: 'all' })
    const blocked = result.warnings.filter((warning) => warning.includes('：'))
    expect(blocked).toEqual(['图像节点：生成节点没有提示词，请填写提示词，或者连一个文字节点进来'])
  })

  it('describes each scope, reason and warning without the old jargon', () => {
    const scopes = [
      { kind: 'all' as const },
      { kind: 'dirty' as const, nodeIds: ['cup'] },
      { kind: 'selection' as const, nodeIds: ['cup'] },
      { kind: 'to-node' as const, nodeId: 'cup' },
      { kind: 'from-node' as const, nodeId: 'cup' },
    ]
    for (const scope of scopes) {
      for (const text of texts(inspect(scope))) expect(text).not.toMatch(jargon)
    }
    expect(inspect({ kind: 'selection', nodeIds: ['cup'] }).warnings[0]).toBe('选中的 1 个节点，连同前面要用到的节点')
    expect(inspect({ kind: 'dirty', nodeIds: ['cup'] }).warnings[0]).toBe('改过的 1 个节点，连同前面要用到的节点')
    expect(inspect({ kind: 'to-node', nodeId: 'cup' }).items.find((item) => item.nodeId === 'cup')?.reason).toBe('这个节点重新生成，会扣费')
    expect(inspect({ kind: 'selection', nodeIds: ['cup'] }).warnings).toContain('这次最多扣费生成 1 次；发出去没收到结果的不会自动重发')
  })

  it('says a skipped, unsupported or missing node in front without the word upstream', () => {
    const skipped: CanvasRunGraph = {
      nodes: [
        { id: 'words', kind: 'prompt', definitionVersion: 1, disabled: true, data: { prompt: 'A ceramic cup', model: '' } },
        { id: 'image', kind: 'image-generate', definitionVersion: 1, data: { prompt: '', model: 'gpt-image-2', group: 'provider' } },
      ],
      edges: [{ id: 'words-edge', source: 'words', sourceHandle: 'out:text', target: 'image', targetHandle: 'in:text' }],
    }
    const skip = buildCanvasRunPreflight({ graph: skipped, scope: { kind: 'all' }, imageModels: ['gpt-image-2'], videoModels: [] })
    expect(skip.items.find((item) => item.nodeId === 'image')).toMatchObject({ action: 'skip', reasonCode: 'upstream-skip', reason: '前面连着的节点跳过了，这个也跟着跳过' })

    const unsupported: CanvasRunGraph = {
      nodes: [
        { id: 'words', kind: 'text-generate', definitionVersion: 1, data: { prompt: '写一句旁白', model: 'gpt-4.1', group: '文字' } },
        { id: 'image', kind: 'image-generate', definitionVersion: 1, data: { prompt: 'A ceramic cup', model: 'gpt-image-2', group: 'provider' } },
      ],
      edges: [{ id: 'words-edge', source: 'words', sourceHandle: 'out:text', target: 'image', targetHandle: 'in:text' }],
    }
    const host = buildCanvasRunPreflight({ graph: unsupported, scope: { kind: 'all' }, imageModels: ['gpt-image-2'], videoModels: [], textModels: ['gpt-4.1'], capabilities: v2EquivalentCapabilities })
    expect(host.items.find((item) => item.nodeId === 'image')).toMatchObject({ action: 'blocked', reasonCode: 'unsupported-host', reason: '前面连着的「文字生成」节点当前客户端暂不支持' })

    const lonelyEdit: CanvasRunGraph = { nodes: [{ id: 'edit', kind: 'image-edit', definitionVersion: 1, data: { prompt: '换成蓝色', model: 'gpt-image-2', group: 'provider' } }], edges: [] }
    const edit = buildCanvasRunPreflight({ graph: lonelyEdit, scope: { kind: 'all' }, imageModels: ['gpt-image-2'], videoModels: [] })
    expect(edit.items[0]).toMatchObject({ action: 'blocked', reasonCode: 'invalid-parameters', reason: '图片编辑节点还没连原图，请先连一张图片或一个生图节点进来' })

    for (const result of [skip, host, edit]) for (const text of texts(result)) expect(text).not.toMatch(jargon)
  })

  it('explains the selection toolbar run entries in plain words', () => {
    const actions = selectionToolbarActions({ count: 1, canGroup: false, canUngroup: false, allLocked: false, canToggleDisabled: true, allDisabled: false, canSaveWorkshop: false, hasRunActions: true }, 'run')
    expect(actions.map((action) => action.section)).toEqual(['运行这个节点，连同前面要用到的节点', '运行这个节点和后面连着的节点，前面还没结果的一起运行'])
  })

  it('explains the run menu next to Run all in plain words', () => {
    // The menu lives inside App; read its option table instead of mounting the whole editor.
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    const table = source.slice(source.indexOf('const runScopeOptions'), source.indexOf('const activeRunOption'))
    const descriptions = [...table.matchAll(/description: '([^']*)'/g)].map((match) => match[1])
    expect(descriptions).toEqual([
      '运行画布上所有能运行的节点',
      '运行改过的节点，连同前面要用到的节点',
      '运行选中的节点，连同前面要用到的节点',
      '先选中一个能运行的节点',
      '运行选中节点和后面连着的节点，前面还没结果的一起运行',
    ])
    for (const text of descriptions) expect(text).not.toMatch(jargon)
  })
})
