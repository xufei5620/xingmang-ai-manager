import { describe, expect, it, vi } from 'vitest'
import {
  getSourceMarkerStorage,
  manualSourceMarkerKey,
  readManualSourceMarker,
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
