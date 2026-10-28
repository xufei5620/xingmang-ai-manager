import { describe, expect, it } from 'vitest'
import { danyinTwoShotFixture } from './drama-parse'
import { buildDramaNodesFromTables, dramaAssetKey } from './drama-layout'
import type { DramaParseTables } from './drama-model'

describe('drama layout from parse tables', () => {
  it('places bible, assets and shots without image-generate nodes', () => {
    let sequence = 0
    const result = buildDramaNodesFromTables(danyinTwoShotFixture, {
      createId: () => `n${sequence += 1}`,
    })
    const types = result.nodes.map((node) => node.type)
    expect(types).toContain('drama-bible')
    expect(types).toContain('drama-character')
    expect(types).toContain('drama-scene')
    expect(types).toContain('drama-prop')
    expect(types.filter((type) => type === 'drama-shot')).toHaveLength(2)
    expect(types).not.toContain('image-generate')
    expect(JSON.stringify(result.nodes)).toContain('虞晚')
    expect(result.edges.some((edge) => edge.sourceHandle === 'out:image' && edge.targetHandle === 'in:images')).toBe(true)
  })

  it('connects each shot to the right table when characters, scenes and props reuse the same IDs', () => {
    // Each table numbers its rows from 1; prop 1 used to overwrite character 1 and scene 1, and every shot
    // then took the prop as its only reference.
    const tables: DramaParseTables = {
      characters: [{ elementId: '1', name: '虞晚', appearance: '红衣' }],
      scenes: [{ elementId: '1', name: '暖阁', environment: '烛火' }],
      props: [{ elementId: '1', name: '血丹', morphology: '血色丹珠' }],
      shots: [{ shotId: '1', sceneId: '1', characterIds: ['1'], propIds: ['1'], action: '递出血丹', framing: '近景' }],
    }
    let sequence = 0
    const result = buildDramaNodesFromTables(tables, { createId: () => `n${sequence += 1}`, includeBible: false })
    const nodeOf = (type: string) => result.nodes.find((node) => node.type === type)!
    const shot = nodeOf('drama-shot')
    const sources = result.edges.filter((edge) => edge.target === shot.id).map((edge) => edge.source).sort()
    expect(sources).toEqual([nodeOf('drama-character').id, nodeOf('drama-scene').id, nodeOf('drama-prop').id].sort())
  })

  it('applies a new name only to the row of the table it was given for', () => {
    const tables: DramaParseTables = {
      characters: [{ elementId: '1', name: '虞晚', appearance: '红衣' }],
      scenes: [{ elementId: '1', name: '暖阁', environment: '烛火' }],
      props: [],
      shots: [],
    }
    const result = buildDramaNodesFromTables(tables, {
      createId: () => 'n',
      includeBible: false,
      selection: { characterIds: ['1'], sceneIds: ['1'], propIds: [], shotIds: [], renamed: { [dramaAssetKey('character', '1')]: '虞晚晚' } },
    })
    const text = (type: string) => JSON.stringify(result.nodes.find((node) => node.type === type))
    expect(text('drama-character')).toContain('虞晚晚')
    expect(text('drama-scene')).toContain('暖阁')
    expect(text('drama-scene')).not.toContain('虞晚晚')
  })
})
