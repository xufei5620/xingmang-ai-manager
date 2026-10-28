import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerPanel } from './ComposerPanel'

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as Array<() => void>, dependencies: [] as unknown[][], cleanups: [] as Array<undefined | (() => void)> }))

vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.values)) hooks.values[index] = initial
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value }]
  },
  useLayoutEffect: (effect: () => undefined | (() => void), dependencies: unknown[]) => {
    const index = hooks.cursor++
    if (hooks.dependencies[index] && dependencies.every((value, offset) => Object.is(value, hooks.dependencies[index][offset]))) return
    hooks.dependencies[index] = dependencies
    hooks.effects.push(() => { hooks.cleanups[index]?.(); hooks.cleanups[index] = effect() })
  },
}))

vi.mock('@xyflow/react', () => ({
  NodeToolbar: () => null,
  Position: { Bottom: 'bottom' },
  useStore: (select: (value: unknown) => unknown) => select({ width: 1280, height: 720, transform: [0, 0, 1], nodeLookup: new Map() }),
}))

function render(collapsed = false) {
  hooks.cursor = 0
  const tree = ComposerPanel({ id: 'image', title: 'Image', follow: false, collapsed, children: 'Composer body' }) as ReactElement<{ style: { top: number }; children: ReactElement<{ ref: (element: HTMLDivElement | null) => void; style: { maxHeight: number } }> }>
  while (hooks.effects.length) hooks.effects.shift()!()
  return tree
}

beforeEach(() => {
  hooks.values = []; hooks.dependencies = []; hooks.cleanups = []; hooks.effects = []
})

describe('composer portal measurement', () => {
  it('measures a portal attached after the first empty effect and responds to resize and unmount', () => {
    let resize: () => void = () => undefined
    let sequence = 0
    const frames = new Map<number, FrameRequestCallback>()
    const requestFrame = vi.fn((callback: FrameRequestCallback) => { const id = ++sequence; frames.set(id, callback); return id })
    const cancelFrame = vi.fn((id: number) => { frames.delete(id) })
    function flushFrame() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(16) }
    const observe = vi.fn(), disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback } observe = observe; disconnect = disconnect })
    vi.stubGlobal('requestAnimationFrame', requestFrame)
    vi.stubGlobal('cancelAnimationFrame', cancelFrame)
    try {
      const initial = render()
      expect(initial.props.style.top).toBe(296)
      expect(observe).not.toHaveBeenCalled()
      const element = { offsetHeight: 470 } as HTMLDivElement
      initial.props.children.props.ref(element)
      render()
      const measured = render()
      expect(observe).toHaveBeenCalledWith(element)
      expect(measured.props.style.top).toBe(186)
      expect(measured.props.style.top + element.offsetHeight).toBe(656)
      Object.defineProperty(element, 'offsetHeight', { value: 600, configurable: true })
      resize()
      resize()
      expect(render().props.style.top).toBe(186)
      expect(requestFrame).toHaveBeenCalledOnce()
      flushFrame()
      const resized = render()
      expect(resized.props.style.top).toBe(64)
      expect(resized.props.children.props.style.maxHeight).toBe(592)
      expect(resized.props.style.top + Math.min(element.offsetHeight, resized.props.children.props.style.maxHeight)).toBe(656)
      Object.defineProperty(element, 'offsetHeight', { value: 900, configurable: true })
      resize()
      flushFrame()
      const limited = render()
      expect(limited.props.style.top + limited.props.children.props.style.maxHeight).toBe(656)
      const measuredValues = [...hooks.values]
      resize()
      flushFrame()
      expect(hooks.values).toEqual(measuredValues)
      resize()
      expect(frames.size).toBe(1)
      limited.props.children.props.ref(null)
      render()
      expect(disconnect).toHaveBeenCalledOnce()
      expect(cancelFrame).toHaveBeenCalledOnce()
      expect(frames.size).toBe(0)
      resize()
      expect(frames.size).toBe(0)
    } finally { vi.unstubAllGlobals() }
  })
})
