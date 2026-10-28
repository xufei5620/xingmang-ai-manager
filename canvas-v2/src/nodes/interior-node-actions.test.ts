import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const source = ts.createSourceFile('WorkflowNodes.tsx', readFileSync(new URL('./WorkflowNodes.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const mounts: ts.JsxSelfClosingElement[] = []
function visit(node: ts.Node) { if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'InteriorTaskControls') mounts.push(node); ts.forEachChild(node, visit) }
visit(source)
function evaluate<T>(index: number, property: string, context: Record<string, unknown>): T {
  const attribute = mounts[index].attributes.properties.find((entry) => ts.isJsxAttribute(entry) && entry.name.getText(source) === property)
  if (!attribute || !ts.isJsxAttribute(attribute) || !attribute.initializer || !ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression) throw new Error(`Missing InteriorTaskControls.${property}`)
  return new Function(...Object.keys(context), ts.transpileModule(`return (${attribute.initializer.expression.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(context)) as T
}

describe('interior node actual mounted callbacks', () => {
  it('passes the exact node and editor epoch from both mounted editing surfaces', () => {
    expect(mounts).toHaveLength(2)
    for (const index of [0, 1]) {
      const handlers = { onEditInteriorTask: vi.fn(), onCompareInteriorCandidates: vi.fn() }
      const context = { handlers, id: 'interior-node', editorScope: 'owner:project:epoch', view: { editorScope: 'owner:project:epoch' } }
      evaluate<() => void>(index, 'onEdit', context)(); evaluate<() => void>(index, 'onCompare', context)()
      expect(handlers.onEditInteriorTask).toHaveBeenCalledExactlyOnceWith('interior-node', 'owner:project:epoch')
      expect(handlers.onCompareInteriorCandidates).toHaveBeenCalledExactlyOnceWith('interior-node', 'owner:project:epoch')
      expect(evaluate(index, 'onEdit', { ...context, handlers: {} })).toBeUndefined()
      expect(evaluate(index, 'onCompare', { ...context, handlers: {} })).toBeUndefined()
    }
  })
  it('disables task mutation for running, locked, disabled or unauthorized nodes on the actual mounts', () => {
    const composer = { running: false, locked: false, canRun: true, view: { readOnly: false } }
    expect(evaluate(0, 'disabled', composer)).toBe(false)
    for (const change of [{ running: true }, { locked: true }, { canRun: false }, { view: { readOnly: true } }]) expect(evaluate(0, 'disabled', { ...composer, ...change })).toBe(true)
    const node = { nodeRunning: false, locked: false, disabled: false, canRun: true }
    expect(evaluate(1, 'disabled', node)).toBe(false)
    for (const change of [{ nodeRunning: true }, { locked: true }, { disabled: true }, { canRun: false }]) expect(evaluate(1, 'disabled', { ...node, ...change })).toBe(true)
  })
  it('counts only real image candidates for comparison instead of text or other media', () => {
    expect(evaluate(0, 'candidateCount', { commerceCandidates: [{}, {}] })).toBe(2)
    expect(evaluate(1, 'candidateCount', { candidates: [{ asset: { kind: 'image' } }, { asset: { kind: 'video' } }, { asset: { kind: 'image' } }] })).toBe(2)
  })
})
