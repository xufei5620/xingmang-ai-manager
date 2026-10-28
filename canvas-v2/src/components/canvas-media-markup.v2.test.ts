// 桌面 v2 编辑器的用例（桌面 000f9131 的 canvas-v2/src/components/canvas-media-markup.test.ts），#4 搬进内核。
// 内核有意和 v2 不一样的地方，期望改成内核的行为或退役，改动处写了为什么，汇总见 docs/canvas-kernel-v2-tests.md。
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function source(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, relativePath), 'utf8')
}

describe('canvas media input and candidate wiring', () => {
  it('turns a selected generate node into an editable composer, not a read-only card', () => {
    const workflowNodes = source('../nodes/WorkflowNodes.tsx')
    // 内核的生成输入区是 ComposerPanel（能收起），节点里传 composer 内容给它。
    expect(workflowNodes).toContain('<ComposerPanel')
    expect(workflowNodes).toContain('function MediaDurationChip')
    expect(workflowNodes).toContain('latestAttemptDurationMs')
    expect(workflowNodes).toContain('wf-media-readouts')
    expect(workflowNodes).toContain('generationElapsedChipLabel')
    expect(workflowNodes).toContain('mediaClipDurationChipLabel')
    expect(workflowNodes).toContain('clipDurationForMediaChip')
    expect(workflowNodes).not.toContain("generationDurationLabel(durationMs, cached)")
    // 内核区分没出过结果的「开始生成」。
    expect(workflowNodes).toContain('aria-label={running ? \'正在生成\' : data.result ? \'重新生成\' : \'开始生成\'}')
    // 内核把提示词里的引用和编辑范围一起交上去。
    expect(workflowNodes).toContain('handlers.onPromptChange(id, prompt, promptReferences, view.editorScope)')
    expect(workflowNodes).toContain('handlers.onPromptCommit(id, prompt, promptReferences, view.editorScope)')
    expect(workflowNodes).toContain('handlers.onDisconnectIncoming')
    expect(workflowNodes).toContain('event.dataTransfer.setData(promptMentionMime, reference.mention)')
    expect(workflowNodes).toContain('draggable')
    expect(workflowNodes).not.toContain('wf-generation-card')
    const styles = source('../styles.css')
    expect(styles).toContain('.wf-composer-send')
    expect(styles).toContain('.wf-composer-field')
    expect(styles).toContain('.wf-composer-footer')
    expect(styles).toContain('.wf-composer-toolbar')
    expect(styles).toContain('.wf-prompt-mention')
    expect(styles).toContain('.wf-prompt-mention-glyph')
    expect(styles).toContain('.wf-prompt-mention-thumb')
    expect(styles).toContain('.wf-prompt-editor.has-mentions')
    expect(styles).toContain('width: 2em;')
    expect(styles).toContain('.wf-prompt-count')
    const promptEditor = source('PromptEditor.tsx')
    expect(promptEditor).toContain('maxLength={promptEditorMaxLength}')
    expect(promptEditor).toContain('{promptState.prompt.length}/{promptEditorMaxLength}')
    expect(styles).toContain('font-size: var(--text-lg);')
    expect(styles).toContain('width: var(--space-48);')
    expect(styles).toContain('width: 8px;')
    expect(styles).not.toContain('.wf-generation-card')
    expect(workflowNodes).toContain('wf-composer-footer')
    expect(workflowNodes).toContain('composerFieldLabel')
  })

  it('keeps all media inputs on the shared replace and preview path', () => {
    const workflowNodes = source('../nodes/WorkflowNodes.tsx')
    expect(workflowNodes).toContain('function MediaBoundPreview')
    expect(workflowNodes).toContain("kind === 'image-input' || kind === 'video-input' || kind === 'audio-input'")
    expect(workflowNodes).toContain('handlers.onImportAssetFile(id, event.dataTransfer.files[0])')
    expect(workflowNodes).toContain('handlers.onPreviewAsset(asset)')
    // 内核的图片工具节点自己画结果，这里多排除了它们。
    expect(workflowNodes).toContain("!mediaInput && !isImageTransformNodeKind(kind) && kind !== 'image-compare' && kind !== 'image-panorama' && displayedResult?.localUrl")
  })

  it('keeps media type chips on the picture at every zoom', () => {
    const workflowNodes = source('../nodes/WorkflowNodes.tsx')
    expect(workflowNodes).toContain('className="wf-media-chips"')
    expect(workflowNodes).toContain('className={`wf-media-kind is-${expectedAssetKind}`}')
    expect(workflowNodes).toContain('className="wf-media-size"')
    expect(workflowNodes).not.toContain("lod === 'detail' && (\n        <div className=\"wf-media-chips\">")
    const styles = source('../styles.css')
    expect(styles).toContain('.wf-media-chips svg { margin: 0; }')
    expect(styles).toContain('.wf-drop-target.has-asset:hover .wf-media-size')
    expect(styles).toContain('.wf-node.wf-media-bound:has(.is-pending)')
    expect(styles).toContain('.wf-node .wf-prompt-editor textarea')
    expect(styles).toContain('background: transparent;')
    expect(source('NodeLibrary.tsx')).toContain('promptPresetMime')
    expect(source('../App.tsx')).toContain('promptPresetMime')
  })

  it('keeps canvas video surfaces draggable and plays from an overlay button', () => {
    const workflowNodes = source('../nodes/WorkflowNodes.tsx')
    expect(workflowNodes).toContain('canvasPlayback')
    expect(workflowNodes).not.toContain('wf-input-preview-video nodrag')
    const preview = source('MediaPreview.tsx')
    expect(preview).toContain('wf-canvas-video-toggle nodrag')
    const styles = source('../styles.css')
    expect(styles).toContain('.wf-canvas-video-el')
    expect(styles).toContain('pointer-events: none')
  })

  it('documents the multi-input contract and avoids fixed video preview heights', () => {
    const workflowNodes = source('../nodes/WorkflowNodes.tsx')
    expect(workflowNodes).toContain('文本、图片前置节点均可多连')
    expect(workflowNodes).toContain('文本、图片、音频均可多连')
    expect(workflowNodes).toContain('MiniMax 最多使用 9 图、3 音频，合计 12 个素材')
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
