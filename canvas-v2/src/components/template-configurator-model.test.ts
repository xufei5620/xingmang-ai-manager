import { describe, expect, it } from 'vitest'
import { builtinCanvasTemplates } from '../templates/builtin-templates'
import { createTemplateConfiguratorState, validateTemplateConfiguratorState } from './template-configurator-model'

describe('template configurator model', () => {
  it('hydrates defaults and validates required local inputs', () => {
    const template = builtinCanvasTemplates.find((entry) => entry.id === 'xingmang-ec-white-bg')!
    const initial = createTemplateConfiguratorState(template)
    expect(initial['prompt-1']).toContain('商品')
    expect(validateTemplateConfiguratorState(template, initial).errors.asset).toBe('此项为必填')
    const assetId = 'a'.repeat(43)
    const valid = validateTemplateConfiguratorState(template, { ...initial, asset: assetId }, new Set([assetId]))
    expect(valid.valid).toBe(true)
    expect(valid.values?.asset).toBe(assetId)
  })

  it('rejects paths, urls, data uris and arbitrary asset strings', () => {
    const template = builtinCanvasTemplates.find((entry) => entry.id === 'xingmang-reference-edit')!
    for (const value of ['/tmp/private.png', 'https://example.com/a.png', 'data:image/png;base64,abc', 'not-an-asset']) {
      const result = validateTemplateConfiguratorState(template, { reference: value, prompt: '保持主体' }, new Set([value]))
      expect(result.valid).toBe(false)
    }
  })
})
