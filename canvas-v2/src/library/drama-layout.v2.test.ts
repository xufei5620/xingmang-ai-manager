import { describe, expect, it } from 'vitest'
import { danyinTwoShotFixture } from './drama-parse'
import { buildDramaNodesFromTables } from './drama-layout'

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
})
