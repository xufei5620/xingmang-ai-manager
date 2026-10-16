import { describe, expect, it } from 'vitest'
import { cliCatalog, currentAccountGroupName, managedCliKeyProfiles, providerBaseUrls, providerIds } from './catalog'

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
      claude: 'https://xm.solov.cc',
      codex: 'https://xm.solov.cc/v1',
      grok: 'https://xm.solov.cc/v1',
      gemini: 'https://xm.solov.cc',
    })
  })

  it('maps the group names the xm site retired onto the names it signs keys under now', () => {
    expect(['Claude-MAX订阅', 'GPT-中转/订阅', 'Grok-中转/订阅', 'Gemini-中转/订阅'].map(currentAccountGroupName))
      .toEqual(providerIds.map((provider) => managedCliKeyProfiles[provider].group))
    expect(currentAccountGroupName('图片模型-中转/订阅')).toBe('图片模型')
    expect(currentAccountGroupName('视频模型-中转/订阅')).toBe('视频模型')
    for (const name of ['GPT', 'GPT-官方API直连', 'Codex_pro', '', '__proto__', 'constructor']) {
      expect(currentAccountGroupName(name)).toBe(name)
    }
  })
})
