import { describe, expect, it } from 'vitest'
import { danyinTwoShotFixture, parseDramaTablesJson, validateDramaParseTables } from './drama-parse'
import { maximumDramaCharacters } from './drama-model'

describe('drama parse tables', () => {
  it('accepts the Danyin two-shot fixture', () => {
    const result = validateDramaParseTables(danyinTwoShotFixture)
    expect(result.tables.characters.map((row) => row.name)).toEqual(['虞晚', '谢凛'])
    expect(result.tables.shots).toHaveLength(2)
    expect(result.warnings).toEqual([])
  })

  it('reads JSON even when the model wraps it in a fence', () => {
    const result = parseDramaTablesJson(`好的\n\`\`\`json\n${JSON.stringify(danyinTwoShotFixture)}\n\`\`\``)
    expect(result.tables.shots[0].shotId).toBe('s01')
  })

  it('rejects a missing scene reference and empty ids', () => {
    expect(() => validateDramaParseTables({
      ...danyinTwoShotFixture,
      shots: [{ ...danyinTwoShotFixture.shots[0], sceneId: 'gone' }],
    })).toThrow('不存在的场景')
    expect(() => validateDramaParseTables({
      ...danyinTwoShotFixture,
      characters: [{ ...danyinTwoShotFixture.characters[0], elementId: '' }],
    })).toThrow('缺少有效标识')
  })

  it('rejects oversized tables and truncates long appearance with a warning', () => {
    expect(() => validateDramaParseTables({
      ...danyinTwoShotFixture,
      characters: Array.from({ length: maximumDramaCharacters + 1 }, (_, index) => ({
        elementId: `c${index}`,
        name: `角色${index}`,
        appearance: '描述',
      })),
    })).toThrow('角色不能超过')
    const long = `红衣${'金饰'.repeat(2_000)}`
    const result = validateDramaParseTables({
      ...danyinTwoShotFixture,
      characters: [{ ...danyinTwoShotFixture.characters[0], appearance: long }],
    })
    expect(result.tables.characters[0].appearance.length).toBe(2_000)
    expect(result.warnings.some((warning) => warning.includes('截断'))).toBe(true)
  })
})
