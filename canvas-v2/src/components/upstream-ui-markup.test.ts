import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function source(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, relativePath), 'utf8')
}

describe('upstream reference UI wiring', () => {
  it('feeds the provider from persisted graph edges and the project asset catalog', () => {
    const app = source('../App.tsx')
    expect(app).toContain('<CanvasUpstreamReferencesProvider nodes={nodes} edges={edges} assets={assetCatalog}>')
  })

  it('does not pop the inspector just because a node was selected', () => {
    const app = source('../App.tsx')
    expect(app).not.toContain('selectedNodeSignatureRef')
    expect(app).toContain('setNodeInspectorOpen(true)')
  })

  it('opens a project with the node library collapsed', () => {
    const app = source('../App.tsx')
    expect(app).toContain('canvasStartupUiPreferences(readCanvasUiPreferences(opened.project.id))')
    const styles = source('../styles.css')
    expect(styles).toContain('.wf-edge-flow')
  })

  it('lets a second generate node start while another run is still in flight', () => {
    const app = source('../App.tsx')
    expect(app).toContain('rememberActiveRun')
    expect(app).toContain('该节点正在生成，请等待结束或先取消')
    expect(app).not.toContain('if (running) return false')
    expect(app).not.toContain('if (!pending || running) return')
  })

  it('keeps upstream text in the runtime graph and localizes autosave lock errors', () => {
    const app = source('../App.tsx')
    expect(app).not.toContain('commitGenerationPrompts')
    expect(app).toContain('applyPromptDraft')
    expect(app).toContain('onPromptCommit')
    expect(app).toContain('canvasAutosaveErrorMessage')
    expect(app).toContain('canvasAutosaveSignature')
    expect(app).not.toContain("自动保存失败：${error.message}")
  })

  it('keeps the empty canvas on templates and new nodes, not another open-project button', () => {
    const app = source('../App.tsx')
    expect(app).toContain('canvas-empty-state')
    expect(app).toContain('从模板开始')
    expect(app).toContain('新建生成节点')
    expect(app).not.toContain('>打开项目</button>')
    expect(app).toContain('打开工作流')
  })

  it('routes wires as thin beziers and dots the canvas instead of lining it', () => {
    const edge = source('../edges/WorkflowEdge.tsx')
    expect(edge).toContain('getBezierPath')
    expect(edge).toContain('curvature: canvasEdgeCurvature')
    expect(edge).toContain('stroke: canvasEdgeStroke')
    expect(edge).not.toContain('getSmoothStepPath')
    const app = source('../App.tsx')
    expect(app).toContain('connectionLineType={ConnectionLineType.Bezier}')
    expect(app).toContain('BackgroundVariant.Dots')
    expect(app).not.toContain('BackgroundVariant.Lines')
  })

  it('uses the same explicit reference list for node cards and prompt mentions', () => {
    const workflowNodes = source('../nodes/WorkflowNodes.tsx')
    expect(workflowNodes).toContain('<PromptEditor')
    expect(workflowNodes).toContain('references={upstreamReferences}')
    expect(workflowNodes).toContain('<UpstreamReferencesPanel references={upstreamReferences} />')
    expect(workflowNodes).toContain("kind === 'image-edit' || kind === 'image-generate' || kind === 'image' || kind === 'video-generate'")
  })
})
