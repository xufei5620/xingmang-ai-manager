import { describe, expect, it } from 'vitest'
import { assertWholeFilterClientVersion, graphHasWholeFilter, projectHasWholeFilter } from './whole-filter-contract'

function graph(operation: unknown, stored = false): unknown {
  const imageTransform = { kind: 'layer', layers: [{ edits: { version: 1, operations: [operation] } }] }
  return { nodes: [{ kind: 'image-layer', data: stored ? { settings: { imageTransform } } : { imageTransform } }] }
}

describe('whole-layer filter capability', () => {
  it.each([undefined, null, false, 2, '1', {}, []])('detects explicit unsupported operation version %j before sanitization', (version) => {
    for (const stored of [false, true]) {
      const value = graph({ mode: 'whole-filter', version }, stored)
      expect(graphHasWholeFilter(value)).toBe(true)
      expect(projectHasWholeFilter(JSON.stringify(value))).toBe(true)
    }
  })
  it('does not mistake prompt text, unrelated properties or older brush modes for a new filter', () => {
    expect(graphHasWholeFilter({ nodes: [{ data: { prompt: 'whole-filter', wholeFilter: true, settings: { wholeFilter: true } } }] })).toBe(false)
    for (const mode of ['paint', 'blur', 'sharpen', 'liquify']) expect(graphHasWholeFilter(graph({ mode }))).toBe(false)
  })
  it.each([undefined, true, '1', 2, null])('blocks unsupported client %j while allowing unchanged legacy workflows', (version) => {
    expect(() => assertWholeFilterClientVersion(version, true)).toThrow('整层滤镜')
    expect(() => assertWholeFilterClientVersion(version, false)).not.toThrow()
  })
  it('accepts the exact current capability without changing the graph', () => {
    expect(() => assertWholeFilterClientVersion(1, true)).not.toThrow()
  })
})
