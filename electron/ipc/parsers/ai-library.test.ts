import { describe, expect, it } from 'vitest'
import { parseAiLibraryListInput } from './ai-library'

const id = (letter: string) => letter.repeat(43)

describe('parseAiLibraryListInput', () => {
  it('accepts an empty request and a full one', () => {
    expect(parseAiLibraryListInput({})).toEqual({})
    for (const kind of ['all', 'image', 'video', 'clip', 'film'] as const) expect(parseAiLibraryListInput({ kind })).toEqual({ kind })
    expect(parseAiLibraryListInput({ offset: 24, limit: 24, kind: 'film', search: '橘猫', filmAssetIds: [id('a'), id('a'), id('b')], matchedAssetIds: [id('c')] }))
      .toEqual({ offset: 24, limit: 24, kind: 'film', search: '橘猫', filmAssetIds: [id('a'), id('b')], matchedAssetIds: [id('c')] })
  })

  it('rejects anything that is not a plain object of known fields', () => {
    for (const value of [undefined, null, 'all', 3, [], { kind: 'all', view: 'trash' }, { assetIds: [id('a')] }, { __proto__: { kind: 'all' }, source: 'all' }]) {
      expect(() => parseAiLibraryListInput(value)).toThrow('作品库请求格式错误')
    }
  })

  it('rejects out-of-range paging, unknown kinds and unsafe search text', () => {
    for (const value of [
      { offset: -1 }, { offset: 1.5 }, { offset: 20_001 }, { offset: '0' },
      { limit: 0 }, { limit: 61 }, { limit: Number.NaN },
      { kind: 'audio' }, { kind: 'trash' }, { kind: 1 },
      { search: 'a'.repeat(129) }, { search: 'a\u0000b' }, { search: 'a\nb' }, { search: 7 },
    ]) expect(() => parseAiLibraryListInput(value)).toThrow('作品库请求格式错误')
  })

  it('takes a canvas project only as an id in the shape the project store hands out', () => {
    const projectId = '11111111-1111-4111-8111-111111111111'
    expect(parseAiLibraryListInput({ canvasProjectId: projectId, kind: 'image' })).toEqual({ canvasProjectId: projectId, kind: 'image' })
    for (const canvasProjectId of [7, '', null, '../../etc/passwd', projectId.slice(1), `${projectId}/`, projectId.toUpperCase().replace('1', 'G'), [projectId], { id: projectId }]) {
      expect(() => parseAiLibraryListInput({ canvasProjectId })).toThrow('作品库请求格式错误')
    }
    // A folder, a path or a project name is not a field of the request.
    for (const value of [{ workspace: 'C:\\Users' }, { projectName: '双十一主图' }, { canvasProjectIds: [projectId] }]) {
      expect(() => parseAiLibraryListInput(value)).toThrow('作品库请求格式错误')
    }
  })

  it('rejects malformed or oversized id lists', () => {
    for (const value of [
      { filmAssetIds: id('a') }, { filmAssetIds: [id('a').slice(1)] }, { filmAssetIds: ['../../etc/passwd'] }, { filmAssetIds: [7] },
      { filmAssetIds: Array.from({ length: 201 }, () => id('a')) },
      { matchedAssetIds: [`${id('a')}/`] }, { matchedAssetIds: Array.from({ length: 2001 }, () => id('a')) },
    ]) expect(() => parseAiLibraryListInput(value)).toThrow('作品库请求格式错误')
    expect(parseAiLibraryListInput({ matchedAssetIds: Array.from({ length: 2000 }, () => id('a')) }).matchedAssetIds).toEqual([id('a')])
  })
})
