import { describe, expect, it } from 'vitest'
import { assertExteriorTaskClientVersion, graphHasExteriorTask, projectHasExteriorTask } from './exterior-task-contract'

describe('exterior task capability presence guard', () => {
  it.each([null, false, [], {}, { version: 2 }, { version: 1 }])('detects a current, malformed or future value before parsing: %j', (value) => {
    for (const data of [{ exteriorTask: value }, { settings: { exteriorTask: value } }]) {
      const graph = { nodes: [{ data }] }
      expect(graphHasExteriorTask(graph)).toBe(true)
      expect(projectHasExteriorTask(JSON.stringify(graph))).toBe(true)
      for (const version of [undefined, null, false, true, '1', 2]) expect(() => assertExteriorTaskClientVersion(version, true)).toThrow('刷新')
      expect(() => assertExteriorTaskClientVersion(1, true)).not.toThrow()
    }
  })
  it('leaves historical graphs and ordinary prompt text unchanged', () => {
    for (const graph of [null, {}, { nodes: [{ data: { prompt: 'exteriorTask', settings: { title: 'exteriorTask' } } }] }]) expect(graphHasExteriorTask(graph)).toBe(false)
    expect(() => assertExteriorTaskClientVersion(undefined, false)).not.toThrow()
  })
})
