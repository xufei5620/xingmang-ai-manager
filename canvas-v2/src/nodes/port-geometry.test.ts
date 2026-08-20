import { describe, expect, it } from 'vitest'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import {
  isMediaSourceKind,
  portOffsetY,
  portSlotFirstOffsetPx,
  portSlotOffsetY,
  portSlotSpacingPx,
} from './port-geometry'

const multiPort = {
  height: 300,
  centredOutput: false,
  ports: [
    { id: 'in:image', direction: 'input' as const },
    { id: 'in:mask', direction: 'input' as const },
    { id: 'in:prompt', direction: 'input' as const },
    { id: 'out:image', direction: 'output' as const },
    { id: 'out:report', direction: 'output' as const },
  ],
}

describe('port geometry', () => {
  it('stacks ports down one side from the first slot', () => {
    expect(portSlotOffsetY(0)).toBe(portSlotFirstOffsetPx)
    expect(portSlotOffsetY(2)).toBe(portSlotFirstOffsetPx + 2 * portSlotSpacingPx)
  })

  it('counts each side separately, so the first output is level with the first input', () => {
    expect(portOffsetY(multiPort, 'input', 'in:image')).toBe(portSlotFirstOffsetPx)
    expect(portOffsetY(multiPort, 'input', 'in:prompt')).toBe(portSlotOffsetY(2))
    expect(portOffsetY(multiPort, 'output', 'out:image')).toBe(portSlotFirstOffsetPx)
    expect(portOffsetY(multiPort, 'output', 'out:report')).toBe(portSlotOffsetY(1))
  })

  it('centres the output of a media source node on its preview', () => {
    const bound = { height: 420, centredOutput: true, ports: [{ id: 'out:image', direction: 'output' as const }] }
    expect(portOffsetY(bound, 'output', 'out:image')).toBe(210)
  })

  it('falls back to the first slot for a handle the definition no longer declares', () => {
    expect(portOffsetY(multiPort, 'input', 'in:gone')).toBe(52)
    expect(portOffsetY(multiPort, 'output', null)).toBe(52)
  })

  it('knows which node kinds collapse to a centred output', () => {
    expect(['image-input', 'video-input', 'audio-input'].every(isMediaSourceKind)).toBe(true)
    expect(isMediaSourceKind('image-generate')).toBe(false)
  })

  it('centres the output of a generate node once it is showing its result', () => {
    const bound = { height: 373, centredOutput: true, ports: builtinNodeRegistry.require('image-generate').ports }
    expect(portOffsetY(bound, 'output', 'out:image')).toBe(186.5)
    expect(portOffsetY(bound, 'input', 'in:text')).toBe(portSlotFirstOffsetPx)
  })

  it('agrees with the ports every builtin node actually declares', () => {
    // Guards the geometry against a node gaining ports without the hit testing
    // noticing: every declared port must land on its own slot.
    for (const definition of builtinNodeRegistry.list()) {
      for (const direction of ['input', 'output'] as const) {
        const side = definition.ports.filter((port) => port.direction === direction)
        const offsets = side.map((port) => portOffsetY(
          { height: 200, centredOutput: false, ports: definition.ports },
          direction,
          port.id,
        ))
        expect(new Set(offsets).size).toBe(side.length)
      }
    }
  })
})
