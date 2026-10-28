import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { canvasNodeDocumentRecord } from '../store/use-canvas-document'
import { organizeCanvasGroupContents } from './organize-groups'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function callbackSource(): string {
  let found = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'organizeGroupContents' && node.initializer && ts.isCallExpression(node.initializer)) found = node.initializer.arguments[0].getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!found) throw new Error('Missing actual organizeGroupContents callback')
  return found
}
function fixture(selected: boolean, locked = false) {
  const nodes: CanvasNode[] = [
    { id: 'g', type: 'group', definitionVersion: 1, position: { x: 0, y: 0 }, width: 400, height: 300, selected, draggable: !locked, data: { prompt: '', model: '', status: 'idle' } },
    ...['a', 'b'].map((id): CanvasNode => ({ id, type: 'prompt', definitionVersion: 1, parentId: 'g', position: { x: 32, y: 96 }, width: 280, data: { prompt: '', model: '', status: 'idle' } })),
  ]
  const execute = vi.fn(), setBanner = vi.fn(), fitCanvas = vi.fn()
  const environment = { nodes, edges: [], organizeCanvasGroupContents, builtinNodeRegistry, canvasNodeDocumentRecord, execute, setBanner, fitCanvas, setArrangeMenuOpen: vi.fn(), projectTransitionRef: { current: false }, draftActionsEnabledRef: { current: true }, toWorkflowEdge: (edge: unknown) => edge, reactFlow: { getNode: (id: string) => id === 'a' ? { measured: { width: 360, height: 1200 } } : id === 'b' ? { measured: { width: 300, height: 900 } } : undefined } }
  const code = ts.transpileModule(`return (${callbackSource()});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const run = new Function(...Object.keys(environment), code)(...Object.values(environment)) as () => void
  return { nodes, execute, setBanner, fitCanvas, run, environment }
}

describe('actual App group organization callback', () => {
  it('uses live measurements and submits one complete document transaction', () => {
    const f = fixture(true)
    f.run()
    expect(f.execute).toHaveBeenCalledTimes(1)
    const command = f.execute.mock.calls[0][0]
    expect(command.type).toBe('replace-nodes')
    expect(command.nodes.find((node: CanvasNode) => node.id === 'a')).toMatchObject({ width: 360, height: 1200 })
    expect(command.nodes.find((node: CanvasNode) => node.id === 'b').position.y).toBeGreaterThanOrEqual(1296)
    expect(f.fitCanvas).toHaveBeenCalledTimes(1)
    expect(f.setBanner).toHaveBeenCalledWith(expect.stringContaining('选中分组'))
  })

  it('does not submit any partial command or move the view when a group is locked', () => {
    const f = fixture(true, true)
    f.run()
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.fitCanvas).not.toHaveBeenCalled()
    expect(f.setBanner).toHaveBeenCalledWith(expect.stringContaining('锁定'))
  })

  it('organizes all groups only without a selection and ignores content-only selection', () => {
    const all = fixture(false)
    all.run()
    expect(all.execute).toHaveBeenCalledTimes(1)
    expect(all.setBanner).toHaveBeenCalledWith(expect.stringContaining('所有分组'))
    const content = fixture(false)
    content.nodes[1].selected = true
    content.run()
    expect(content.execute).not.toHaveBeenCalled()
  })

  it('does not edit during project transition or after the account action guard closes', () => {
    const f = fixture(true)
    f.environment.projectTransitionRef.current = true
    f.run()
    f.environment.projectTransitionRef.current = false
    f.environment.draftActionsEnabledRef.current = false
    f.run()
    expect(f.execute).not.toHaveBeenCalled()
  })
})
