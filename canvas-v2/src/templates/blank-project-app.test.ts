import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { createBlankProjectCreation, listSavedBlankProjectSubmissions, readSavedBlankProjectDraft, writeSavedBlankProjectDraft, type SavedBlankProjectSubmission } from '../lib/blank-project-creation-model'

const ownerId = '11111111-1111-4111-8111-111111111111'
const operationId = '22222222-2222-4222-8222-222222222222'
const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const callbacks = new Map<string, string>()
function collect(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)
    && node.initializer.expression.getText(source) === 'useCallback' && node.initializer.arguments[0]) callbacks.set(node.name.text, node.initializer.arguments[0].getText(source))
  ts.forEachChild(node, collect)
}
collect(source)

function actual(name: string, environment: Record<string, unknown>): (...args: unknown[]) => Promise<unknown> {
  const callback = callbacks.get(name)
  if (!callback) throw new Error(`Missing actual App callback: ${name}`)
  const compiled = ts.transpileModule(`return (${callback});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(environment), compiled)(...Object.values(environment))
}

function fixture(fault: 'after-commit' | 'before-commit' | 'open') {
  const data = new Map<string, string>()
  const storage = { get length() { return data.size }, key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
  const posts: SavedBlankProjectSubmission[] = []
  const reads: SavedBlankProjectSubmission[] = []
  const opens = vi.fn(async () => { if (fault === 'open') throw new Error('opening failed') })
  const stamp = '2026-10-11T08:00:00.000Z'
  const project = { id: operationId, name: '原空白画布', version: 1, createdAt: stamp, updatedAt: stamp, lastOpenedAt: stamp, nodeCount: 0, assetCount: 0, workspaceConfigured: true, workspaceStatus: 'ready' }
  const enabled = { current: true }
  let committed = false
  const controller = createBlankProjectCreation({ ownerId, storage, createOperationId: () => operationId, isActive: () => enabled.current,
    async submit(record) { posts.push(structuredClone(record)); if (fault !== 'before-commit' || posts.length > 1) committed = true; if (posts.length === 1 && fault !== 'open') throw new Error('ACK lost'); return { project, content: record.content } },
    async inspect(record) { reads.push(structuredClone(record)); return committed ? { state: 'confirmed', project } : { state: 'missing' } }, open: opens,
  })
  const env = { storageMode: 'cloud', blankCreationReady: true, blankDraftError: null, blankCreationRef: { current: controller }, draftActionsEnabledRef: enabled,
    creationOwnerId: ownerId, window: { localStorage: storage }, writeSavedBlankProjectDraft, setBlankProjectName: vi.fn(), setBlankDraftError: vi.fn() }
  return { controller, posts, reads, opens, storage, enabled, create: actual('createStoredProject', env), continue: actual('continueBlankProjectCreation', env), changeName: actual('changeBlankProjectName', env) }
}

describe('actual editor blank creation callbacks', () => {
  it('uses GET after lost ACK, ignores a newer name, and opens only the original project before clearing its record', async () => {
    const test = fixture('after-commit')
    expect(await test.create('原空白画布')).toBe(false)
    expect(test.controller.state().phase).toBe('unknown')
    await test.changeName('下一次新名称')
    expect(await test.create('下一次新名称')).toBe(false)
    expect(test.reads).toHaveLength(1)
    expect(test.posts).toHaveLength(1)
    expect(await test.create('下一次新名称')).toBe(true)
    expect(test.opens).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: operationId, name: '原空白画布' }))
    expect(await listSavedBlankProjectSubmissions(test.storage, ownerId)).toEqual([])
    expect(readSavedBlankProjectDraft(test.storage, ownerId)).toEqual({ name: '下一次新名称' })
  })

  it('continues a confirmed missing operation with identical bytes and never replaces it with the edited name', async () => {
    const test = fixture('before-commit')
    await test.create('原空白画布')
    await test.create('后来输入的名称')
    expect(test.controller.state().phase).toBe('missing')
    expect(test.posts).toHaveLength(1)
    await test.continue()
    expect(test.posts).toHaveLength(2)
    expect(test.posts[1]).toEqual(test.posts[0])
    expect(test.opens).not.toHaveBeenCalled()
  })

  it('retains the original record when opening fails and retries opening without another creation', async () => {
    const test = fixture('open')
    await test.create('原空白画布')
    expect(await test.create('新名称')).toBe(false)
    expect(await test.create('另一名称')).toBe(false)
    expect(test.posts).toHaveLength(1)
    expect(test.opens).toHaveBeenCalledTimes(2)
    expect(await listSavedBlankProjectSubmissions(test.storage, ownerId)).toHaveLength(1)
  })

  it('refuses new creation once the owning editor is locked', async () => {
    const test = fixture('after-commit')
    test.enabled.current = false
    expect(await test.create('原空白画布')).toBe(false)
    expect(test.posts).toEqual([])
  })
})
