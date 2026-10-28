// 桌面 v2 编辑器的用例（桌面 000f9131 的 canvas-v2/src/store/use-canvas-document.test.ts），#4 搬进内核。
// 内核有意和 v2 不一样的地方，期望改成内核的行为或退役，改动处写了为什么，汇总见 docs/canvas-kernel-v2-tests.md。
import { describe, expect, it } from 'vitest'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { canvasNodeDocumentRecord } from './use-canvas-document'

describe('canvas document runtime boundary', () => {
  it('keeps accepted results but strips staged candidates and run progress', () => {
    const node: CanvasNode = {
      id: 'output',
      type: 'output',
      definitionVersion: 1,
      position: { x: 10, y: 20 },
      data: {
        prompt: '',
        model: '',
        status: 'succeeded',
        result: { kind: 'image', assetId: 'accepted-asset' },
        candidateAssetIds: ['staged-asset'],
        candidates: [{
          candidateId: 'candidate-1',
          attemptId: 'attempt-1',
          createdAt: '2026-08-17T12:00:00Z',
          asset: { kind: 'image', assetId: 'staged-asset' },
        }],
        selectedCandidateId: 'candidate-1',
        adoptedCandidateId: 'candidate-old',
        runStage: 'saving',
        runProgress: 88,
        runProgressMode: 'determinate',
        runHealth: 'delayed',
        dirty: false,
      },
    }

    const persisted = canvasNodeDocumentRecord(node)
    expect(persisted.data.result).toEqual({ kind: 'image', assetId: 'accepted-asset' })
    expect(persisted.data).not.toHaveProperty('candidateAssetIds')
    expect(persisted.data).not.toHaveProperty('candidates')
    expect(persisted.data).not.toHaveProperty('selectedCandidateId')
    expect(persisted.data).not.toHaveProperty('adoptedCandidateId')
    expect(persisted.data).not.toHaveProperty('runStage')
    expect(persisted.data).not.toHaveProperty('runProgress')
    expect(persisted.data).not.toHaveProperty('runProgressMode')
    expect(persisted.data).not.toHaveProperty('runHealth')
    // 内核把「待更新」留在编辑器的文档里（撤销能带回它），存进工程时由宿主的存档规则去掉，
    // 老桌面那条见 contract/desktop-v2-autosave.test.ts。
    expect(persisted.data).toHaveProperty('dirty', false)
  })
})
