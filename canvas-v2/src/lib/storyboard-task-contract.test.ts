import { describe, expect, it } from 'vitest'
import { assertStoryboardTaskClientVersion, graphHasStoryboardTask, projectHasStoryboardTask } from './storyboard-task-contract'

describe('storyboard task capability presence guard', () => {
  it.each([null, false, [], {}, { version: 2 }, { version: 1 }])('detects a current, malformed or future value before parsing: %j', (value) => {
    for (const data of [{ storyboardTask: value }, { settings: { storyboardTask: value } }]) {
      const graph = { nodes: [{ data }] }
      expect(graphHasStoryboardTask(graph)).toBe(true)
      expect(projectHasStoryboardTask(JSON.stringify(graph))).toBe(true)
      for (const version of [undefined, null, false, true, '1', 2]) expect(() => assertStoryboardTaskClientVersion(version, true)).toThrow('刷新')
      expect(() => assertStoryboardTaskClientVersion(1, true)).not.toThrow()
    }
  })
  it('leaves historical graphs and ordinary prompt text unchanged', () => {
    for (const graph of [null, {}, { nodes: [{ data: { prompt: 'storyboardTask', settings: { title: 'storyboardTask' } } }] }]) expect(graphHasStoryboardTask(graph)).toBe(false)
    expect(() => assertStoryboardTaskClientVersion(undefined, false)).not.toThrow()
  })
})
