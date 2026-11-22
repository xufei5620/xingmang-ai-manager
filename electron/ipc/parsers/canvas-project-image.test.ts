import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { maximumCanvasProjectImageNameLength, parseCanvasProjectImageInput } from './canvas-project-image'

const assetId = 'a'.repeat(43)
const projectId = '11111111-1111-4111-8111-111111111111'
const malformed = '添加到画布的请求格式错误'

describe('parseCanvasProjectImageInput', () => {
  it('accepts one picture with either an existing project or the name of a new one', () => {
    expect(parseCanvasProjectImageInput({ assetId, projectId })).toEqual({ assetId, projectId })
    expect(parseCanvasProjectImageInput({ assetId, newProjectName: '  一只橘猫坐在窗台上 ' })).toEqual({ assetId, newProjectName: '一只橘猫坐在窗台上' })
    expect(parseCanvasProjectImageInput({ assetId, newProjectName: '海'.repeat(maximumCanvasProjectImageNameLength) })).toEqual({ assetId, newProjectName: '海'.repeat(maximumCanvasProjectImageNameLength) })
  })

  it('rejects anything that is not a plain object of the three known fields', () => {
    for (const value of [
      undefined, null, assetId, 7, [], [assetId, projectId],
      // No path, no account, no second picture, no kind of media rides along.
      { assetId, projectId, userId: 8 }, { assetId, projectId, filePath: 'C:\\Users\\a.png' }, { assetId, projectId, workspace: '/tmp' },
      { assetId, projectId, assetIds: [assetId] }, { assetId, projectId, mediaType: 'video' }, { assetId, projectId, source: 'generated' },
    ]) expect(() => parseCanvasProjectImageInput(value)).toThrow(malformed)
  })

  it('takes the picture only as one asset id in the shape the stores hand out', () => {
    for (const value of [undefined, 7, '', '../../secret.png', assetId.slice(1), `${assetId}a`, `${assetId.slice(0, 42)}/`, [assetId], { id: assetId }]) {
      expect(() => parseCanvasProjectImageInput({ assetId: value, projectId })).toThrow(malformed)
      expect(() => parseCanvasProjectImageInput({ assetId: value, newProjectName: '海报' })).toThrow(malformed)
    }
  })

  it('needs exactly one target: a project id in the store shape, or a one-line name within the canvas limit', () => {
    // Neither, or both.
    expect(() => parseCanvasProjectImageInput({ assetId })).toThrow(malformed)
    expect(() => parseCanvasProjectImageInput({ assetId, projectId, newProjectName: '海报' })).toThrow(malformed)
    for (const value of [7, '', null, '../../etc/passwd', projectId.slice(1), `${projectId}/`, projectId.replace('1', 'G'), [projectId]]) {
      expect(() => parseCanvasProjectImageInput({ assetId, projectId: value })).toThrow(malformed)
    }
    for (const value of [7, null, '', '   ', '海'.repeat(maximumCanvasProjectImageNameLength + 1), '海报\n第二行', '海\u0000报', '海\u007f报', ['海报']]) {
      expect(() => parseCanvasProjectImageInput({ assetId, newProjectName: value })).toThrow(malformed)
    }
  })
})

describe('parseCanvasProjectImageInput with random inputs', () => {
  const idText = fc.string({ maxLength: 60 })
  const anything = fc.anything({ maxDepth: 2 })

  it('never lets through more than one well-formed asset id plus one well-formed target', () => {
    fc.assert(fc.property(fc.dictionary(fc.constantFrom('assetId', 'projectId', 'newProjectName', 'filePath', 'userId', 'assetIds'), fc.oneof(anything, idText, fc.constant(assetId), fc.constant(projectId))), (value) => {
      let parsed: ReturnType<typeof parseCanvasProjectImageInput>
      try {
        parsed = parseCanvasProjectImageInput(value)
      } catch (error) {
        expect((error as Error).message).toBe(malformed)
        return
      }
      expect(parsed.assetId).toMatch(/^[A-Za-z0-9_-]{43}$/)
      if ('projectId' in parsed) {
        expect(Object.keys(parsed).sort()).toEqual(['assetId', 'projectId'])
        expect(parsed.projectId).toMatch(/^[a-f0-9-]{36}$/)
      } else {
        expect(Object.keys(parsed).sort()).toEqual(['assetId', 'newProjectName'])
        expect(parsed.newProjectName.length).toBeGreaterThan(0)
        expect(parsed.newProjectName.length).toBeLessThanOrEqual(maximumCanvasProjectImageNameLength)
        expect(parsed.newProjectName).not.toMatch(/[\x00-\x1f\x7f]/)
        expect(parsed.newProjectName).toBe(parsed.newProjectName.trim())
      }
    }))
  })
})
