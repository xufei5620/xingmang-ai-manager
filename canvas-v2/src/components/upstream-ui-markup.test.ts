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

  it('uses the same explicit reference list for node cards and prompt mentions', () => {
    const workflowNodes = source('../nodes/WorkflowNodes.tsx')
    expect(workflowNodes).toContain('<PromptEditor')
    expect(workflowNodes).toContain('references={upstreamReferences}')
    expect(workflowNodes).toContain('<UpstreamReferencesPanel references={upstreamReferences} />')
    expect(workflowNodes).toContain("kind === 'image-edit' || kind === 'video-generate'")
  })
})
