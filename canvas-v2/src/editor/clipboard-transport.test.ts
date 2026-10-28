import { describe, expect, it, vi } from 'vitest'
import { buildCanvasClipboardTransfer, parseCanvasClipboardTransfer, runCanvasClipboardPaste, writeCanvasClipboardEvent, canvasClipboardEventAllowed, canvasClipboardCopiedHere, canvasClipboardOwnerId } from './clipboard-transport'
import type { CanvasClipboardPayload } from './clipboard'

const owner = '62026000-0000-4000-8000-000000000001', other = '62026000-0000-4000-8000-000000000002'
function selection(privateSource = false): CanvasClipboardPayload { return { version: 1, nodes: [{ id: 'a', type: privateSource ? 'image-input' : 'prompt', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '原正文', model: '', ...(privateSource ? { result: { kind: 'image', assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}` } } : {}) } }], edges: [] } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }

describe('native cross-document selection clipboard', () => {
  it('round trips through a brand new reader after whole-document refresh without any memory or storage', () => {
    const text = buildCanvasClipboardTransfer(selection(true), { ownerId: owner, projectId: '11111111-1111-4111-8111-111111111111' })
    expect(parseCanvasClipboardTransfer(String(text), owner).nodes[0].data.result).toMatchObject({ assetId: 'a'.repeat(43) })
    expect(() => parseCanvasClipboardTransfer(text, other)).toThrow('账号')
  })
  it('supports source-free v1 and blocks unscoped private legacy selections explicitly', () => {
    expect(parseCanvasClipboardTransfer(JSON.stringify(selection()), owner).nodes).toHaveLength(1)
    expect(() => parseCanvasClipboardTransfer(JSON.stringify(selection(true)), owner)).toThrow('重新复制')
    const pinned = selection(); pinned.nodes[0].data.group = 'provider-a'
    expect(() => parseCanvasClipboardTransfer(JSON.stringify(pinned), owner)).toThrow('重新复制')
  })
  it('rejects wrong envelope versions, identity and unrecognized fields', () => {
    const original = JSON.parse(buildCanvasClipboardTransfer(selection(true), { ownerId: owner, projectId: null }))
    for (const patch of [{ version: 3 }, { ownerId: 'cookie-value' }, { secret: 'not-allowed' }, { sourceProjectId: '../../private' }]) expect(() => parseCanvasClipboardTransfer(JSON.stringify({ ...original, ...patch }), owner)).toThrow()
  })
  it('uses synchronous clipboard data under the native gesture and never claims unavailable writes', () => {
    const setData = vi.fn(); expect(writeCanvasClipboardEvent({ setData }, 'exact-text')).toBe(true)
    expect(setData).toHaveBeenCalledWith('text/plain', 'exact-text')
    expect(writeCanvasClipboardEvent({ setData() { throw new Error('denied') } }, 'exact-text')).toBe(false)
  })
  it.each(['INPUT', 'TEXTAREA', 'SELECT'])('preserves ordinary text clipboard in %s', (tagName) => { expect(canvasClipboardEventAllowed({ target: { tagName } }, false)).toBe(false) })
  it('preserves editable descendants, selected page text, and modal clipboard', () => {
    expect(canvasClipboardEventAllowed({ target: { isContentEditable: true } }, false)).toBe(false)
    expect(canvasClipboardEventAllowed({ target: { closest: () => ({}) } }, false)).toBe(false)
    expect(canvasClipboardEventAllowed({ target: null }, true)).toBe(false)
    expect(canvasClipboardEventAllowed({ target: { tagName: 'DIV' } }, false)).toBe(true)
  })
  it.each(['read', 'inspect'])('drops a late %s reply after scope change and back (ABA)', async (stage) => {
    let revision = 1; const captured = revision, gate = deferred<string>(), checked = deferred<void>(), apply = vi.fn(), inspect = vi.fn(() => checked.promise)
    const text = buildCanvasClipboardTransfer(selection(true), { ownerId: owner, projectId: null })
    const job = runCanvasClipboardPaste({ ownerId: owner, current: () => revision === captured, read: () => stage === 'read' ? gate.promise : Promise.resolve(text), inspect, apply })
    if (stage === 'inspect') { await Promise.resolve(); await Promise.resolve() }
    revision++; revision++
    gate.resolve(text); checked.resolve()
    expect(await job).toBe(false); expect(apply).not.toHaveBeenCalled()
  })
  it('validates private resources before one atomic apply and leaves the source unchanged', async () => {
    const original = selection(true), text = buildCanvasClipboardTransfer(original, { ownerId: owner, projectId: null }), apply = vi.fn(), inspect = vi.fn(async () => undefined)
    expect(await runCanvasClipboardPaste({ ownerId: owner, current: () => true, read: async () => text, inspect, apply })).toBe(true)
    expect(inspect).toHaveBeenCalledTimes(1); expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ version: 1 }), text); expect(apply).toHaveBeenCalledTimes(1)
    expect(original.nodes[0].id).toBe('a')
  })
  it('blocks unavailable resources without any partial insertion or reference dropping', async () => {
    const apply = vi.fn(), text = buildCanvasClipboardTransfer(selection(true), { ownerId: owner, projectId: null })
    await expect(runCanvasClipboardPaste({ ownerId: owner, current: () => true, read: async () => text, inspect: async () => { throw new Error('素材缺失') }, apply })).rejects.toThrow('素材缺失')
    expect(apply).not.toHaveBeenCalled()
  })
})

describe('desktop clipboard ownership', () => {
  const workspace = '62026000-0000-4000-8000-0000000000aa'
  it('prefers the account UUID and falls back to the workspace only on the desktop', () => {
    expect(canvasClipboardOwnerId(owner, 'desktop', workspace)).toBe(owner)
    expect(canvasClipboardOwnerId(null, 'desktop', workspace)).toBe(workspace)
    expect(canvasClipboardOwnerId(null, 'web', workspace)).toBeNull()
    expect(canvasClipboardOwnerId(null, 'embed', workspace)).toBeNull()
  })
  it('recognizes only the exact text this workspace copied', () => {
    const text = buildCanvasClipboardTransfer(selection(true), { ownerId: workspace, projectId: null })
    expect(canvasClipboardCopiedHere(text, text)).toBe(true)
    expect(canvasClipboardCopiedHere(text, null)).toBe(false)
    expect(canvasClipboardCopiedHere(text.replace('原正文', '改过的'), text)).toBe(false)
    expect(canvasClipboardCopiedHere(`${text} `, text)).toBe(false)
  })
})
