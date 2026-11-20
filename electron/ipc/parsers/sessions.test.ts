import path from 'node:path'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseProviderSessionListQuery, parseSessionId } from './sessions'

describe('parseSessionId', () => {
  it('accepts a uuid-shaped id', () => {
    expect(parseSessionId('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe('0f8fad5b-d9cb-469f-a165-70867728950e')
  })

  it('rejects anything that could walk out of the sessions folder', () => {
    for (const id of ['../../../../../../../../etc/passwd', '0f8fad5b-d9cb-469f-a165-70867728950e/..', '..\\..\\..\\..\\..\\..\\..\\..\\..\\a', '', 42]) {
      expect(() => parseSessionId(id)).toThrow('会话 ID 格式错误')
    }
  })
})

// Random inputs (fast-check): ids built from uuids, near-misses in the id's own
// alphabet with path characters mixed in, and values of any type. A failing run
// prints its seed and the smallest id that got through.
describe('parseSessionId with random inputs', () => {
  const nearMiss = fc.string({ unit: fc.constantFrom(...'0123456789abcdefABCDEF-./\\:\u0000 '.split('')), minLength: 34, maxLength: 38 })
  const spliced = fc.tuple(fc.uuid(), fc.nat(36), fc.constantFrom('/', '\\', '..', '../', '..\\', ':', '\u0000', '%2e%2e', '\u2215', '\uff0f'))
    .map(([id, at, piece]) => `${id.slice(0, at)}${piece}${id.slice(at)}`)

  it('returns only an id that stays a single file name inside the sessions folder', () => {
    fc.assert(fc.property(fc.oneof(fc.uuid(), nearMiss, spliced, fc.string({ unit: 'binary' }), fc.anything()), (value) => {
      let id: string
      try {
        id = parseSessionId(value)
      } catch (error) {
        expect(error instanceof Error && error.message).toBe('会话 ID 格式错误')
        return
      }
      expect(id).toBe(value)
      expect(id).toHaveLength(36)
      expect(id).not.toMatch(/[\\/:\u0000]|\.\./)
      for (const [flavour, base] of [[path.win32, 'C:\\Users\\fake\\.codex\\sessions'], [path.posix, '/home/fake/.codex/sessions']] as const) {
        const resolved = flavour.resolve(base, `${id}.jsonl`)
        expect(flavour.dirname(resolved)).toBe(base)
        expect(flavour.basename(resolved)).toBe(`${id}.jsonl`)
      }
    }), { numRuns: 500 })
  })
})

describe('parseProviderSessionListQuery', () => {
  it('rejects an unlisted tool and an oversized search', () => {
    expect(() => parseProviderSessionListQuery({ provider: 'cursor' })).toThrow('会话工具类型错误')
    expect(() => parseProviderSessionListQuery({ search: 's'.repeat(257) })).toThrow('会话搜索内容过长')
    expect(() => parseProviderSessionListQuery({ page: 0 })).toThrow('页码格式错误')
  })
})

describe('parseProviderSessionListQuery searchContent', () => {
  it('passes the content search switch through only when it is exactly true', () => {
    expect(parseProviderSessionListQuery({ search: '发票', searchContent: true })).toMatchObject({ search: '发票', searchContent: true })
    expect(parseProviderSessionListQuery({ search: '发票', searchContent: false })).not.toHaveProperty('searchContent')
    expect(parseProviderSessionListQuery({ search: '发票' })).not.toHaveProperty('searchContent')
  })

  it('rejects a content search switch that is not a boolean', () => {
    expect(() => parseProviderSessionListQuery({ searchContent: 'yes' })).toThrow('会话搜索方式格式错误')
    expect(() => parseProviderSessionListQuery({ searchContent: 1 })).toThrow('会话搜索方式格式错误')
  })
})
