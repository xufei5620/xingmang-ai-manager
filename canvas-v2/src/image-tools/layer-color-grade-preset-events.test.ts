import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { defaultImageLayerColorGrade, parseImageLayerColorGrade } from './layer-color-grade'
import { serializeColorGradePreset } from './layer-color-grade-editor-state'
import { importColorGradePresetTransfer, maximumColorGradePresetTransferBytes } from '../lib/color-grade-preset-transfer'
import { getPreparedColorLutTable } from './layer-color-lut-runtime'

const source = ts.createSourceFile('LayerColorGradeEditor.tsx', readFileSync(new URL('./LayerColorGradeEditor.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let declaration = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(source); ts.forEachChild(node, visit) }
  visit(source); if (!declaration) throw new Error(`Missing workbench function ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${declaration})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function deferred() { let resolve: (value: string) => void = () => {}; const promise = new Promise<string>((done) => { resolve = done }); return { resolve, promise } }
function fixture() {
  const presetTransfer = { current: null as { controller: AbortController; request: number; revision: number; scope: string } | null }, readingRef = { current: false }
  const environment = { completed: { current: false }, histogramController: { current: null as AbortController | null }, importRequest: { current: 0 }, revision: { current: 0 }, scope: 'source-a', activeScope: { current: 'source-a' }, initialScope: { current: 'source-a' }, alive: { current: true }, draftRef: { current: defaultImageLayerColorGrade() }, maximumColorGradePresetTransferBytes, importColorGradePresetTransfer, parseImageLayerColorGrade, getPreparedColorLutTable, presetTransfer, readingRef, lutReadingRef: { current: false }, xmpReviewRef: { current: null as unknown }, lutStateRef: { current: { busy: false, error: '', tables: new Map(), retry: vi.fn() } }, hostBridge: vi.fn(), abortPresetTransfer: () => { const pending = presetTransfer.current; presetTransfer.current = null; pending?.controller.abort() }, setReading: vi.fn((next: boolean) => { readingRef.current = next }), setError: vi.fn(), setPresetName: vi.fn(), setHidden: vi.fn(), setBefore: vi.fn(), setNotice: vi.fn(), onApply: vi.fn(), onClose: vi.fn(), change: vi.fn() }
  environment.change.mockImplementation((grade) => { environment.draftRef.current = grade; environment.revision.current++ })
  function load(file: { size: number; text(): Promise<string> }) { return actual<(file: unknown) => Promise<void>>('importPreset', environment)(file) }
  const valid = serializeColorGradePreset('产品色彩', { ...defaultImageLayerColorGrade(), exposure: .4 })
  return { environment, valid, load }
}

describe('actual image adjustment preset and completion callbacks', () => {
  it('bounds local files before reading and validates the configuration before changing a draft', async () => {
    const f = fixture(), text = vi.fn().mockResolvedValue(f.valid)
    await f.load({ size: maximumColorGradePresetTransferBytes + 1, text }); expect(text).not.toHaveBeenCalled(); expect(f.environment.change).not.toHaveBeenCalled()
    await f.load({ size: 8, text: async () => '{"token":"secret"}' }); expect(f.environment.change).not.toHaveBeenCalled()
    await f.load({ size: f.valid.length, text }); expect(f.environment.change).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ exposure: .4 })); expect(f.environment.onApply).not.toHaveBeenCalled()
    expect(f.environment.setNotice).toHaveBeenLastCalledWith('已载入「产品色彩」，完成后才应用到图层')
  })
  it.each(['closed', 'unmounted', 'source', 'newer-request', 'edited'] as const)('does not replace current edits after a delayed file read becomes %s', async (condition) => {
    const f = fixture(), pending = deferred(), read = f.load({ size: 100, text: () => pending.promise })
    if (condition === 'closed') actual<() => void>('close', f.environment)()
    if (condition === 'unmounted') f.environment.alive.current = false
    if (condition === 'source') f.environment.activeScope.current = 'source-b'
    if (condition === 'newer-request') f.environment.importRequest.current++
    if (condition === 'edited') f.environment.revision.current++
    pending.resolve(f.valid); await read; expect(f.environment.change).not.toHaveBeenCalled(); expect(f.environment.onApply).not.toHaveBeenCalled()
    if (condition === 'edited') expect(f.environment.setError).toHaveBeenLastCalledWith('读取预设期间调整已改变，请重新选择预设；当前草稿保留')
  })
  it('keeps failed application open and commits only once after the owning editor accepts the draft', () => {
    const f = fixture(); f.environment.draftRef.current = { ...defaultImageLayerColorGrade(), grain: 15 }; f.environment.onApply.mockImplementationOnce(() => { throw new Error('图层已锁定') })
    const apply = actual<() => void>('apply', f.environment)
    apply(); expect(f.environment.completed.current).toBe(false); expect(f.environment.onClose).not.toHaveBeenCalled(); expect(f.environment.setError).toHaveBeenLastCalledWith('图层已锁定')
    apply(); apply(); expect(f.environment.onApply).toHaveBeenCalledTimes(2); expect(f.environment.onClose).toHaveBeenCalledOnce(); expect(f.environment.onApply).toHaveBeenLastCalledWith(expect.objectContaining({ grain: 15 }))
  })
})
