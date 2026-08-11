import { describe, expect, it } from 'vitest'
import { resolveConfigModelDetectionSource } from './config-model-detection'

describe('config model detection source', () => {
  it('uses a newly typed key after trimming it', () => {
    expect(resolveConfigModelDetectionSource('  sk-new-key  ', true)).toEqual({
      kind: 'typed',
      apiKey: 'sk-new-key',
    })
  })

  it('uses the configured-key main-process path when no replacement key was entered', () => {
    expect(resolveConfigModelDetectionSource('', true)).toEqual({ kind: 'configured' })
    expect(resolveConfigModelDetectionSource('   ', true)).toEqual({ kind: 'configured' })
  })

  it('returns null when neither a typed nor saved key is available', () => {
    expect(resolveConfigModelDetectionSource('', false)).toBeNull()
  })
})
