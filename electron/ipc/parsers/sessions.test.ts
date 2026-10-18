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

describe('parseProviderSessionListQuery', () => {
  it('rejects an unlisted tool and an oversized search', () => {
    expect(() => parseProviderSessionListQuery({ provider: 'cursor' })).toThrow('会话工具类型错误')
    expect(() => parseProviderSessionListQuery({ search: 's'.repeat(257) })).toThrow('会话搜索内容过长')
    expect(() => parseProviderSessionListQuery({ page: 0 })).toThrow('页码格式错误')
  })
})
