import { describe, expect, it } from 'vitest'
import { cliCatalog, providerBaseUrls, providerIds } from './catalog'

describe('CLI catalog', () => {
  it('uses a distinct official package for every provider', () => {
    const packages = providerIds.map((id) => cliCatalog[id].packageName)
    expect(new Set(packages).size).toBe(providerIds.length)
    expect(packages).toEqual([
      '@anthropic-ai/claude-code',
      '@openai/codex',
      '@xai-official/grok',
      '@google/gemini-cli',
    ])
  })

  it('uses the fixed relay URL assigned to each CLI', () => {
    expect(providerBaseUrls).toEqual({
      claude: 'https://api.solov.cc',
      codex: 'https://api.solov.cc',
      grok: 'https://api.solov.cc/v1',
      gemini: 'https://api.solov.cc',
    })
  })
})
