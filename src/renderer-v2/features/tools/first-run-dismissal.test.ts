import { describe, expect, it } from 'vitest'
import { dismissFirstRun, firstRunDismissalKey, readFirstRunDismissals, type FirstRunStorage } from './first-run-dismissal'

function memoryStorage(initial?: string): FirstRunStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set(firstRunDismissalKey, initial)
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } }
}

describe('renderer-v2 first-run suggestion dismissal', () => {
  it('reads back the tools whose card the user already closed', () => {
    expect(readFirstRunDismissals(memoryStorage('["claude","grok"]'))).toEqual(['claude', 'grok'])
  })

  it('remembers a dismissal so the same tool does not come back', () => {
    const storage = memoryStorage()
    const next = dismissFirstRun(storage, [], 'claude')
    expect(next).toEqual(['claude'])
    expect(readFirstRunDismissals(storage)).toEqual(['claude'])
    expect(dismissFirstRun(storage, next, 'claude')).toEqual(['claude'])
  })

  it('keeps earlier dismissals when another tool is dismissed', () => {
    const storage = memoryStorage('["claude"]')
    expect(dismissFirstRun(storage, readFirstRunDismissals(storage), 'codex')).toEqual(['claude', 'codex'])
  })

  it('ignores anything that is not a tool this build knows', () => {
    expect(readFirstRunDismissals(memoryStorage('["claude","../etc",7,null]'))).toEqual(['claude'])
    expect(readFirstRunDismissals(memoryStorage('not json'))).toEqual([])
    expect(readFirstRunDismissals(memoryStorage('{"claude":true}'))).toEqual([])
    expect(readFirstRunDismissals(memoryStorage(`["${'x'.repeat(600)}"]`))).toEqual([])
  })

  it('never lets local storage failures break the page', () => {
    const broken: FirstRunStorage = {
      getItem: () => { throw new Error('拒绝访问') },
      setItem: () => { throw new Error('拒绝访问') },
    }
    expect(readFirstRunDismissals(broken)).toEqual([])
    expect(readFirstRunDismissals(null)).toEqual([])
    // 写不进去也要当场消失，否则用户按了关闭却什么也没发生。
    expect(dismissFirstRun(broken, [], 'codex')).toEqual(['codex'])
    expect(dismissFirstRun(null, ['claude'], 'codex')).toEqual(['claude', 'codex'])
  })
})
