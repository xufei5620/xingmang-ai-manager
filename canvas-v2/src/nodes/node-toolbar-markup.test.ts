import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync(path.join(__dirname, 'WorkflowNodes.tsx'), 'utf8')

describe('single-node toolbar markup', () => {
  it('uses the React Flow toolbar and keeps both run directions explicit', () => {
    expect(source).toContain('<NodeToolbar')
    expect(source).toContain('handlers.onRunToNode(id)')
    expect(source).toContain('handlers.onRunFromNode(id)')
    expect(source).toContain('运行到此')
    expect(source).toContain('从此向后')
  })

  it('shows an elapsed timer from runtime-only node state', () => {
    expect(source).toContain('<RunningElapsed startedAt={data.runStartedAt} />')
  })
})
