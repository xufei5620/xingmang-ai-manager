import { describe, expect, it, vi } from 'vitest'
import {
  applyManualSourceMarker,
  getSourceMarkerStorage,
  manualSourceMarkerKey,
  readManualSourceMarker,
  sourceMarkerWriteWarning,
  writeManualSourceMarker,
  type SourceMarkerStorage,
} from './source-marker'

function memoryStorage() {
  const values = new Map<string, string>()
  const storage: SourceMarkerStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
  return { storage, values }
}

describe('renderer provider source marker', () => {
  it('uses an origin-only scope, so paths share a marker while providers do not', () => {
    const { storage } = memoryStorage()
    expect(
      manualSourceMarkerKey('https://XM.solov.cc/anthropic', 'claude'),
    ).toBe(manualSourceMarkerKey('https://xm.solov.cc/v1', 'claude'))

    expect(
      writeManualSourceMarker(
        storage,
        'https://xm.solov.cc/anthropic',
        'claude',
        true,
      ),
    ).toBe(true)
    expect(
      readManualSourceMarker(storage, 'https://xm.solov.cc/v1', 'claude'),
    ).toBe(true)
    expect(
      readManualSourceMarker(storage, 'https://xm.solov.cc/v1', 'codex'),
    ).toBe(false)
    expect(
      readManualSourceMarker(storage, 'https://other.example/v1', 'claude'),
    ).toBe(false)
  })

  it('clears only the selected relay/provider marker', () => {
    const { storage } = memoryStorage()
    writeManualSourceMarker(storage, 'https://xm.solov.cc/v1', 'codex', true)
    writeManualSourceMarker(storage, 'https://other.example/v1', 'codex', true)

    expect(
      writeManualSourceMarker(
        storage,
        'https://xm.solov.cc/v1',
        'codex',
        false,
      ),
    ).toBe(true)
    expect(
      readManualSourceMarker(storage, 'https://xm.solov.cc/v1', 'codex'),
    ).toBe(false)
    expect(
      readManualSourceMarker(storage, 'https://other.example/v1', 'codex'),
    ).toBe(true)
  })

  // 「自动」的线路跟着网络换，客户认过的「就用现在这份」不能因为线路换了就没了。
  it('shares one marker between the lines of a site, and keeps each site separate', () => {
    const { storage, values } = memoryStorage()
    expect(manualSourceMarkerKey('https://xm-direct.solov.cc/v1', 'codex')).toBe(manualSourceMarkerKey('https://xm.solov.cc/v1', 'codex'))
    expect(manualSourceMarkerKey('https://api-direct.solov.cc/v1', 'codex')).toBe(manualSourceMarkerKey('https://api.solov.cc/v1', 'codex'))
    expect(manualSourceMarkerKey('https://api.solov.cc/v1', 'codex')).not.toBe(manualSourceMarkerKey('https://xm.solov.cc/v1', 'codex'))

    writeManualSourceMarker(storage, 'https://xm-direct.solov.cc/v1', 'codex', true)
    expect(readManualSourceMarker(storage, 'https://xm.solov.cc/v1', 'codex')).toBe(true)
    expect(readManualSourceMarker(storage, 'https://api.solov.cc/v1', 'codex')).toBe(false)
    expect([...values.keys()]).toEqual([manualSourceMarkerKey('https://xm.solov.cc/v1', 'codex')])
  })

  it.each([
    ['the direct domain', 'https://xm-direct.solov.cc'],
    ['the retired IP entry', 'https://38.147.105.28:8443'],
  ])('still honors a marker stored under %s and moves it into the shared one on the next write', (_name, formerOrigin) => {
    const { storage, values } = memoryStorage()
    const formerKey = `xingmang-v2:provider-source:v1:${encodeURIComponent(formerOrigin)}:claude`
    values.set(formerKey, 'manual')
    for (const baseUrl of ['https://xm.solov.cc', 'https://xm-direct.solov.cc']) {
      expect(readManualSourceMarker(storage, baseUrl, 'claude')).toBe(true)
    }
    expect(readManualSourceMarker(storage, 'https://xm.solov.cc', 'codex')).toBe(false)

    expect(writeManualSourceMarker(storage, 'https://xm-direct.solov.cc', 'claude', true)).toBe(true)
    expect([...values.keys()]).toEqual([manualSourceMarkerKey('https://xm.solov.cc', 'claude')])
    expect(writeManualSourceMarker(storage, 'https://xm.solov.cc', 'claude', false)).toBe(true)
    expect(values.size).toBe(0)
  })

  it('keeps an address that is not a line of a known site on its own marker', () => {
    const { storage, values } = memoryStorage()
    // 别名只用来认旧记录，不会被当成哪条线路去合并。
    writeManualSourceMarker(storage, 'https://38.147.105.28:8443/v1', 'codex', true)
    expect([...values.keys()]).toEqual([`xingmang-v2:provider-source:v1:${encodeURIComponent('https://38.147.105.28:8443')}:codex`])
    values.clear()
    writeManualSourceMarker(storage, 'https://relay.example.test/v1', 'codex', true)
    expect([...values.keys()]).toEqual([`xingmang-v2:provider-source:v1:${encodeURIComponent('https://relay.example.test')}:codex`])
    expect(readManualSourceMarker(storage, 'https://xm.solov.cc/v1', 'codex')).toBe(false)
  })

  it('ignores invalid data and degrades safely when storage is unavailable', () => {
    const invalid = memoryStorage()
    invalid.values.set(
      manualSourceMarkerKey('https://xm.solov.cc/v1', 'gemini')!,
      'account',
    )
    expect(
      readManualSourceMarker(
        invalid.storage,
        'https://xm.solov.cc/v1',
        'gemini',
      ),
    ).toBe(false)
    expect(manualSourceMarkerKey('not a relay URL', 'gemini')).toBeNull()

    const unavailable: SourceMarkerStorage = {
      getItem: vi.fn(() => { throw new Error('storage unavailable') }),
      setItem: vi.fn(() => { throw new Error('storage unavailable') }),
      removeItem: vi.fn(() => { throw new Error('storage unavailable') }),
    }
    expect(
      readManualSourceMarker(
        unavailable,
        'https://xm.solov.cc/v1',
        'gemini',
      ),
    ).toBe(false)
    expect(
      writeManualSourceMarker(
        unavailable,
        'https://xm.solov.cc/v1',
        'gemini',
        true,
      ),
    ).toBe(false)
    expect(
      writeManualSourceMarker(
        unavailable,
        'https://xm.solov.cc/v1',
        'gemini',
        false,
      ),
    ).toBe(false)
  })

  it('turns a dropped marker write into a warning the save flow can surface', () => {
    const { storage } = memoryStorage()
    expect(
      applyManualSourceMarker(storage, 'https://xm.solov.cc/v1', 'claude', true),
    ).toBe('')
    expect(
      readManualSourceMarker(storage, 'https://xm.solov.cc/v1', 'claude'),
    ).toBe(true)
    expect(
      applyManualSourceMarker(storage, 'https://xm.solov.cc/v1', 'claude', false),
    ).toBe('')

    const stuck: SourceMarkerStorage = {
      getItem: vi.fn(() => 'manual'),
      setItem: vi.fn(() => { throw new Error('storage unavailable') }),
      removeItem: vi.fn(() => { throw new Error('storage unavailable') }),
    }
    expect(
      applyManualSourceMarker(stuck, 'https://xm.solov.cc/v1', 'claude', true),
    ).toBe(sourceMarkerWriteWarning)
    expect(
      applyManualSourceMarker(stuck, 'https://xm.solov.cc/v1', 'claude', false),
    ).toBe(sourceMarkerWriteWarning)
    // 解析不出 origin 时标记根本无处可写，写入侧同样必须让用户看到。
    expect(
      applyManualSourceMarker(storage, 'not a relay URL', 'claude', true),
    ).toBe(sourceMarkerWriteWarning)
  })

  it('stays silent when there is no marker to clear, so a disabled storage does not warn on every save', () => {
    // 读不到标记 = 来源推断也读不到它，展示不受影响。这时再弹一句用户无从处理的
    // 警告，只会让「本机禁用 localStorage」变成每次保存都报错。
    const unavailable: SourceMarkerStorage = {
      getItem: vi.fn(() => { throw new Error('storage unavailable') }),
      setItem: vi.fn(() => { throw new Error('storage unavailable') }),
      removeItem: vi.fn(() => { throw new Error('storage unavailable') }),
    }
    expect(
      applyManualSourceMarker(unavailable, 'https://xm.solov.cc/v1', 'claude', false),
    ).toBe('')
    expect(unavailable.removeItem).not.toHaveBeenCalled()
    expect(
      applyManualSourceMarker(null, 'https://xm.solov.cc/v1', 'claude', false),
    ).toBe('')

    const { storage } = memoryStorage()
    expect(
      applyManualSourceMarker(storage, 'https://xm.solov.cc/v1', 'claude', false),
    ).toBe('')
  })

  it('degrades safely when the browser localStorage getter throws', () => {
    const brokenWindow = Object.defineProperty({}, 'localStorage', {
      get() { throw new Error('storage getter unavailable') },
    })
    vi.stubGlobal('window', brokenWindow)
    try {
      expect(getSourceMarkerStorage()).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
