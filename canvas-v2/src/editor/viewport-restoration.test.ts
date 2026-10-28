import { describe, expect, it, vi } from 'vitest'
import type { CanvasViewport } from '../store/canvas-state'
import { createViewportRestoration } from './viewport-restoration'

function fixture() {
  let sequence = 0
  const frames = new Map<number, () => void>()
  const scope = { projectId: 'a' as string | null, projectEpoch: 1 }
  const state = { active: true }
  const apply = vi.fn(async (viewport: CanvasViewport): Promise<CanvasViewport | null> => ({ ...viewport }))
  const applied = vi.fn()
  const restore = createViewportRestoration({
    schedule: (callback) => { const id = ++sequence; frames.set(id, callback); return id },
    cancelFrame: (id) => { frames.delete(id) },
    scope: () => scope,
    active: () => state.active,
    apply, applied,
  })
  async function flush() { const batch = [...frames.values()]; frames.clear(); batch.forEach((run) => run()); await Promise.resolve(); await Promise.resolve() }
  return { frames, scope, state, apply, applied, restore, flush }
}
const saved = { x: 361.9, y: -329.2, zoom: 0.2 }

describe('viewport restoration readiness and lifetime', () => {
  it('waits through an unmounted project center and applies only when the pane initializes', async () => {
    const f = fixture()
    f.restore.request(saved)
    await f.flush()
    expect(f.apply).not.toHaveBeenCalled()
    f.restore.initialized()
    await f.flush()
    expect(f.apply).toHaveBeenCalledExactlyOnceWith(saved)
    expect(f.applied).toHaveBeenCalledExactlyOnceWith(saved)
  })

  it('retains a request when the API returns not-ready without an animation loop', async () => {
    const f = fixture()
    f.apply.mockResolvedValueOnce(null)
    f.restore.initialized(); f.restore.request(saved)
    await f.flush()
    expect(f.frames.size).toBe(0)
    expect(f.applied).not.toHaveBeenCalled()
    f.restore.initialized(); await f.flush()
    expect(f.apply).toHaveBeenCalledTimes(2)
    expect(f.applied).toHaveBeenCalledExactlyOnceWith(saved)
  })

  it('uses a new token for same-project draft or import restoration', async () => {
    const f = fixture(), next = { x: 70, y: 60, zoom: 0.7 }
    f.restore.initialized(); f.restore.request(saved)
    const stale = [...f.frames.values()][0]
    f.restore.request(next)
    stale()
    await f.flush()
    expect(f.apply).toHaveBeenCalledExactlyOnceWith(next)
  })

  it.each(['project', 'epoch', 'account'] as const)('rejects an old queued request after a %s change', async (change) => {
    const f = fixture()
    f.restore.initialized(); f.restore.request(saved)
    if (change === 'project') f.scope.projectId = 'b'
    else if (change === 'epoch') f.scope.projectEpoch += 1
    else f.state.active = false
    await f.flush()
    expect(f.apply).not.toHaveBeenCalled()
    expect(f.applied).not.toHaveBeenCalled()
  })

  it('does not restore after user navigation or unmount even if a cancelled callback fires', async () => {
    const f = fixture()
    f.restore.initialized(); f.restore.request(saved)
    const stale = [...f.frames.values()][0]
    f.restore.cancel(); stale(); await f.flush()
    expect(f.apply).not.toHaveBeenCalled()
    f.restore.request(saved); f.restore.reset(); await f.flush()
    expect(f.apply).not.toHaveBeenCalled()
    f.restore.request(saved); await f.flush()
    expect(f.apply).not.toHaveBeenCalled()
    f.restore.initialized(); await f.flush()
    expect(f.apply).toHaveBeenCalledExactlyOnceWith(saved)
  })

  it('deduplicates init and live-ready signals while applying and ignores late acknowledgement', async () => {
    const f = fixture()
    let resolve: (viewport: CanvasViewport | null) => void = () => undefined
    f.apply.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    f.restore.request(saved); f.restore.initialized(); await f.flush()
    f.restore.initialized(); await f.flush()
    expect(f.apply).toHaveBeenCalledTimes(1)
    f.scope.projectEpoch += 1
    resolve(saved); await f.flush()
    expect(f.applied).not.toHaveBeenCalled()
  })

  it('acknowledges the actual clamped viewport so the document and status display match it', async () => {
    const f = fixture(), actual = { ...saved, zoom: 0.15 }
    f.apply.mockResolvedValueOnce(actual)
    f.restore.request({ ...saved, zoom: 0.1 }); f.restore.initialized(); await f.flush()
    expect(f.applied).toHaveBeenCalledExactlyOnceWith(actual)
  })
})
