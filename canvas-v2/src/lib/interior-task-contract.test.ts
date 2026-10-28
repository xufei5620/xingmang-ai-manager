import { describe, expect, it } from 'vitest'
import { assertInteriorTaskClientVersion, graphHasInteriorTask, projectHasInteriorTask } from './interior-task-contract'

describe('interior task capability presence guard', () => {
  it.each([null, false, [], {}, { version: 2 }, { version: 1 }])('detects a current, malformed or future value before parsing: %j', (value) => {
    for (const data of [{ interiorTask: value }, { settings: { interiorTask: value } }]) {
      const graph = { nodes: [{ data }] }
      expect(graphHasInteriorTask(graph)).toBe(true)
      expect(projectHasInteriorTask(JSON.stringify(graph))).toBe(true)
      for (const version of [undefined, null, false, true, '1', 2]) expect(() => assertInteriorTaskClientVersion(version, true)).toThrow('刷新')
      expect(() => assertInteriorTaskClientVersion(1, true)).not.toThrow()
    }
  })
  it('leaves historical graphs and ordinary prompt text unchanged', () => {
    for (const graph of [null, {}, { nodes: [{ data: { prompt: 'interiorTask', settings: { title: 'interiorTask' } } }] }]) expect(graphHasInteriorTask(graph)).toBe(false)
    expect(() => assertInteriorTaskClientVersion(undefined, false)).not.toThrow()
  })
})
