import { describe, expect, it } from 'vitest'
import { liquifyOperationFixture, liquifyRecipeFixture } from '../lib/liquify.test-fixture'
import { parseImageLayerLiquifyOperation } from './layer-liquify'
import { imageLayerEditUsage, parseImageTransformRecipe } from './recipe'

describe('ordered versioned liquify operations', () => {
  it('strictly clones all five tools without introducing state into legacy recipes', () => {
    const input = liquifyOperationFixture()
    input.strokes.push({ tool: 'pinch', radius: 10, strength: 1, points: [[0, 10000]] }, { tool: 'twirl-ccw', radius: 512, strength: 0, points: [[10000, 0]] })
    const parsed = parseImageLayerLiquifyOperation(input)
    expect(parsed).toEqual(input)
    parsed.strokes[0].points[0][0] = 1
    expect(input.strokes[0].points[0][0]).toBe(3000)
    const recipe = liquifyRecipeFixture(), old = structuredClone(recipe)
    old.layers[0].edits!.operations.splice(1, 1)
    expect(parseImageTransformRecipe(old)).toEqual(old)
    expect(parseImageTransformRecipe(recipe)).toEqual(recipe)
    expect(recipe.layers[0].edits!.operations.map((entry) => entry.mode)).toEqual(['paint', 'liquify', 'paint'])
  })
  it.each([
    { version: 2 }, { mode: 'warp' }, { assetId: 'private' }, { strokes: [] }, { strokes: Array(65).fill(liquifyOperationFixture().strokes[0]) },
    { space: { width: 0, height: 10 } }, { space: { width: Infinity, height: 10 } }, { space: { width: 16385, height: 10 } },
    ...[{ tool: 'unknown' }, { radius: 0 }, { radius: 513 }, { strength: 1.01 }, { strength: NaN }, { points: [[.5, 1], [2, 3]] }, { points: [[-1, 1], [2, 3]] }, { points: [[0, 10001], [2, 3]] }, { points: [[5000, 5000]] }, { points: Array(257).fill([0, 0]) }, { url: 'file:///private' }].map((patch) => ({ strokes: [{ ...liquifyOperationFixture().strokes[0], ...patch }] })),
  ])('rejects unknown semantics, hostile fields and out-of-budget values %j', (patch) => {
    expect(() => parseImageLayerLiquifyOperation({ ...liquifyOperationFixture(), ...patch })).toThrow()
  })
  it('counts nested strokes and points against the existing aggregate edit limits', () => {
    const recipe = liquifyRecipeFixture(), usage = imageLayerEditUsage(recipe.layers)
    expect(usage.points).toBe(8)
    expect(usage.operations).toBe(6)
    const operation = liquifyOperationFixture()
    operation.strokes = Array.from({ length: 17 }, () => ({ ...operation.strokes[0], points: Array.from({ length: 256 }, (_, i): [number, number] => [i, i]) }))
    recipe.layers[0].edits = { version: 1, operations: [operation] }
    expect(() => parseImageTransformRecipe(recipe)).toThrow('4096')
    recipe.layers[0].edits = { version: 1, operations: Array.from({ length: 5 }, () => ({ ...operation, strokes: Array(64).fill({ ...operation.strokes[0], points: [[0, 0], [1, 1]] }) })) }
    expect(() => parseImageTransformRecipe(recipe)).toThrow('256')
  })
})
