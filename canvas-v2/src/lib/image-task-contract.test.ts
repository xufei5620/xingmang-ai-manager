import { describe, expect, it } from 'vitest'
import { assertImageTaskClientVersion, graphHasImageTask, projectHasImageTask } from './image-task-contract'
describe('image task client capability presence boundary', () => {
  it.each(['commerceTask', 'imageReferenceOrder'])('detects %s in workflow settings and immutable run data even when malformed', (key) => {
    for (const value of [null, false, [], {}, { version: 99 }]) for (const data of [{ [key]: value }, { settings: { [key]: value } }]) {
      expect(graphHasImageTask({ nodes: [{ data }] })).toBe(true)
      expect(projectHasImageTask(JSON.stringify({ nodes: [{ data }] }))).toBe(true)
    }
  })
  it('does not confuse prose with executable task fields', () => {
    expect(graphHasImageTask({ nodes: [{ data: { prompt: 'commerceTask imageReferenceOrder', settings: { title: 'commerceTask' } } }] })).toBe(false)
    for (const value of [undefined, null, true, '1', 2]) expect(() => assertImageTaskClientVersion(value, true)).toThrow('刷新')
    expect(() => assertImageTaskClientVersion(1, true)).not.toThrow()
    expect(() => assertImageTaskClientVersion(undefined, false)).not.toThrow()
  })
})
