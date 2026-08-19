import { describe, expect, it } from 'vitest'
import {
  assetDensityOrder,
  assetDensityTileSize,
  assetDensityVersion,
  defaultAssetDensity,
  readAssetDensity,
  writeAssetDensity,
  type AssetDensityStorage,
} from './asset-density'

function memoryStorage(seed: Record<string, string> = {}): AssetDensityStorage & { store: Map<string, string> } {
  const store = new Map(Object.entries(seed))
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, value) },
  }
}

describe('asset density preference', () => {
  it('round-trips every density', () => {
    for (const density of assetDensityOrder) {
      const storage = memoryStorage()
      writeAssetDensity(density, storage)
      expect(readAssetDensity(storage)).toBe(density)
    }
  })

  it('falls back to the default for anything it did not write', () => {
    expect(readAssetDensity(memoryStorage())).toBe(defaultAssetDensity)
    expect(readAssetDensity(memoryStorage({ 'xingmang.canvas.assets.density': 'not json' }))).toBe(defaultAssetDensity)
    expect(readAssetDensity(memoryStorage({ 'xingmang.canvas.assets.density': '[]' }))).toBe(defaultAssetDensity)
    expect(readAssetDensity(memoryStorage({
      'xingmang.canvas.assets.density': JSON.stringify({ version: assetDensityVersion, density: 'enormous' }),
    }))).toBe(defaultAssetDensity)
  })

  it('refuses a payload written by another version', () => {
    // The version field only earns its place if reads enforce it.
    const storage = memoryStorage({
      'xingmang.canvas.assets.density': JSON.stringify({ version: assetDensityVersion + 1, density: 'roomy' }),
    })
    expect(readAssetDensity(storage)).toBe(defaultAssetDensity)
  })

  it('survives a storage that throws', () => {
    const throwing: AssetDensityStorage = {
      getItem: () => { throw new Error('private window') },
      setItem: () => { throw new Error('quota exceeded') },
    }
    expect(readAssetDensity(throwing)).toBe(defaultAssetDensity)
    expect(() => writeAssetDensity('roomy', throwing)).not.toThrow()
  })

  it('keeps the three steps distinct and ascending', () => {
    const sizes = assetDensityOrder.map((density) => assetDensityTileSize[density])
    expect(sizes).toEqual([...sizes].sort((left, right) => left - right))
    expect(new Set(sizes).size).toBe(sizes.length)
  })
})
