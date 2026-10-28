import { describe, expect, it } from 'vitest'
import { createCanvasAgentEditorApproval } from './agent-editor-approval'

describe('editor changes and ephemeral Agent dispatch', () => {
  it('aborts every active dispatch synchronously on a manual edit', () => {
    const guard = createCanvasAgentEditorApproval(), a = new AbortController(), b = new AbortController()
    const first = guard.signal(a.signal), second = guard.signal(b.signal)
    expect(guard.signal(a.signal)).toBe(first)
    expect(guard.changed()).toBe(1)
    expect(first.aborted).toBe(true); expect(second.aborted).toBe(true)
    expect(a.signal.aborted).toBe(false)
    expect(guard.signal(a.signal).aborted).toBe(true)
  })
  it('allows an explicitly resumed new dispatch without restoring an old signal', () => {
    const guard = createCanvasAgentEditorApproval(), previous = guard.signal(new AbortController().signal)
    guard.changed()
    const next = guard.signal(new AbortController().signal)
    expect(previous.aborted).toBe(true); expect(next.aborted).toBe(false)
    expect(guard.revision()).toBe(1)
  })
  it('does not mistake an automatic synchronous commit for a manual edit', () => {
    const guard = createCanvasAgentEditorApproval(), active = guard.signal(new AbortController().signal)
    guard.commit(() => guard.commit(() => guard.changed()))
    expect(guard.revision()).toBe(0); expect(active.aborted).toBe(false)
    expect(() => guard.commit(() => { throw new Error('Synthetic commit failure') })).toThrow('Synthetic')
    guard.changed(); expect(active.aborted).toBe(true)
  })
  it('stops a dispatch when its panel controller ends without changing the document revision', () => {
    const guard = createCanvasAgentEditorApproval(), parent = new AbortController(), active = guard.signal(parent.signal)
    parent.abort(new Error('Panel closed'))
    expect(active.aborted).toBe(true); expect(guard.revision()).toBe(0)
    expect(guard.signal(parent.signal).aborted).toBe(true)
  })
})
