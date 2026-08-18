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
    expect(inspector).toContain('props.onDiscard(node.nodeId, candidate.candidateId)')
    const styles = source('../styles.css')
    expect(styles).toContain('.candidate-video { display: block; width: 100%; height: auto;')
  })

  it('keeps output confirmation explicit in both the node and run candidate controls', () => {
    const workflowNodes = source('../nodes/WorkflowNodes.tsx')
    expect(workflowNodes).toContain("stagingState === 'pending' ? '待确认结果'")
    expect(workflowNodes).toContain("stagingState === 'accepted' ? '最终产物已确认'")
    expect(workflowNodes).toContain('handlers.onDiscardCandidate(id, selectedCandidate.candidateId)')
  })
})
