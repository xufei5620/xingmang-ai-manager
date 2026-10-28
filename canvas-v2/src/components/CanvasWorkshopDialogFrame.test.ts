import { afterEach, describe, expect, it, vi } from 'vitest'
const runtime = vi.hoisted(() => ({ cursor: 0, refs: [] as { current: unknown }[], effects: [] as (() => void | (() => void))[] }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useRef(value: unknown) { const index = runtime.cursor++; runtime.refs[index] ??= { current: value }; return runtime.refs[index] },
  useEffect(effect: () => void | (() => void)) { runtime.effects.push(effect) },
}))
import { CanvasWorkshopDialogFrame } from './CanvasWorkshopDialogFrame'

function harness() {
  class Target {
    isConnected = true
    hidden = false
    disabled = false
    focus = vi.fn(() => { doc.activeElement = this })
    closest() { return this.hidden ? this : null }
    matches() { return this.disabled }
  }
  const trigger = new Target(), input = new Target(), body = new Target(), panel = Object.assign(new Target(), { querySelector: () => input })
  const doc = { activeElement: trigger, body }
  const frames: (() => void)[] = []
  vi.stubGlobal('document', doc); vi.stubGlobal('HTMLElement', Target); vi.stubGlobal('requestAnimationFrame', (callback: () => void) => frames.push(callback))
  runtime.cursor = 0; runtime.refs = []; runtime.effects = []
  CanvasWorkshopDialogFrame({ title: '重命名节点', onClose: vi.fn(), children: null })
  runtime.refs[0].current = panel
  // React has now committed autoFocus before the effect starts.
  doc.activeElement = input
  const cleanup = runtime.effects[0]() as () => void
  function unmount() { runtime.refs[0].current = null; input.isConnected = false; doc.activeElement = body; cleanup() }
  function flush() { frames.splice(0).forEach((callback) => callback()) }
  return { trigger, input, body, panel, doc, cleanup, unmount, flush, Target }
}
afterEach(() => vi.unstubAllGlobals())
describe('workshop dialog opener restoration', () => {
  it('remembers the opener before native autofocus and restores it after cleanup', () => {
    const ui = harness(); ui.unmount()
    expect(ui.trigger.focus).not.toHaveBeenCalled()
    ui.flush(); expect(ui.trigger.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
    expect(ui.doc.activeElement).toBe(ui.trigger)
  })
  it('waits until an outer suspended dialog has been made interactive again', () => {
    const ui = harness(); ui.unmount(); ui.trigger.hidden = true
    ui.trigger.hidden = false; ui.flush()
    expect(ui.trigger.focus).toHaveBeenCalledOnce()
  })
  it('does not steal focus from a newer dialog or an explicit outside control', () => {
    const ui = harness(); ui.unmount(); ui.doc.activeElement = new ui.Target(); ui.flush()
    expect(ui.trigger.focus).not.toHaveBeenCalled()
  })
  it.each(['disconnected', 'hidden', 'disabled'])('does not restore an unavailable %s opener', (reason) => {
    const ui = harness(); ui.unmount()
    if (reason === 'disconnected') ui.trigger.isConnected = false
    if (reason === 'hidden') ui.trigger.hidden = true
    if (reason === 'disabled') ui.trigger.disabled = true
    ui.flush(); expect(ui.trigger.focus).not.toHaveBeenCalled()
  })
  it('does not refocus the opener during a strict effect replay while the dialog remains mounted', () => {
    const ui = harness(); ui.cleanup(); ui.flush()
    expect(ui.trigger.focus).not.toHaveBeenCalled(); expect(ui.doc.activeElement).toBe(ui.input)
  })
})
