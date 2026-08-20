import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function source(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, relativePath), 'utf8')
}

describe('canvas media input and candidate wiring', () => {
  it('keeps all media inputs on the shared replace and preview path', () => {
    const workflowNodes = source('../nodes/WorkflowNodes.tsx')
    expect(workflowNodes).toContain('function MediaInputDropZone')
    expect(workflowNodes).toContain("kind === 'image-input' || kind === 'video-input' || kind === 'audio-input'")
    expect(workflowNodes).toContain('handlers.onImportAssetFile(id, event.dataTransfer.files[0])')
    expect(workflowNodes).toContain('handlers.onPreviewAsset(asset)')
    expect(workflowNodes).toContain("!mediaInput && displayedResult?.localUrl")
  })

  it('documents the multi-input contract and avoids fixed video preview heights', () => {
    const workflowNodes = source('../nodes/WorkflowNodes.tsx')
    expect(workflowNodes).toContain('文本、图片前置节点均可多连')
    expect(workflowNodes).toContain('文本、图片、视频、音频均可多连')
    expect(workflowNodes).toContain('MiniMax 最多使用 9 图、3 视频、3 音频')
    const styles = source('../styles.css')
    expect(styles).toContain('.wf-input-preview-video {')
    expect(styles).toContain('height: auto;')
    expect(styles).not.toContain('.wf-input-preview-video { height: 116px;')
    expect(styles).not.toContain('.wf-node-video-input .wf-preview')
  })

  it('renders run candidates by their actual media kind and wires the lightbox', () => {
    const inspector = source('RunInspector.tsx')
    expect(inspector).toContain("candidate.asset.kind === 'image'")
    expect(inspector).toContain("candidate.asset.kind === 'video'")
    expect(inspector).toContain("candidate.asset.kind === 'audio'")
    expect(inspector).toContain('props.onPreviewAsset(candidate.asset)')
    expect(inspector).toContain('<AudioPreview src={candidate.asset.localUrl} />')
    expect(inspector).toContain('mediaAssetAspectRatio(candidate.asset)')
    expect(inspector).toContain('props.onUseCandidate(node.nodeId, candidate)')
    const styles = source('../styles.css')
    expect(styles).toContain('.candidate-video { display: block; width: 100%; height: auto;')
  })

  // 2026-08-20 产品决策（老板拍板）：最新候选自动成为产物。原先这条用例钉的是
  // 「节点上必须有采纳/丢弃、Output 显示待确认结果」，那正是被推翻的那一档。
  it('keeps every candidate reachable as the product without an adoption step', () => {
    const workflowNodes = source('../nodes/WorkflowNodes.tsx')
    expect(workflowNodes).toContain("stagingState === 'accepted' ? '最终产物已就绪'")
    expect(workflowNodes).not.toContain('采纳此候选')
    expect(workflowNodes).not.toContain('onDiscardCandidate')
    // Switching candidates is the only remaining product control on the node.
    expect(workflowNodes).toContain('handlers.onSelectCandidate(id, candidate.candidateId)')
    const inspector = source('RunInspector.tsx')
    expect(inspector).toContain("'当前产物' : '设为产物'")
    expect(inspector).not.toContain('丢弃')
  })
})
