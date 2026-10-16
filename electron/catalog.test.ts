import { describe, expect, it } from 'vitest'
import { buildAccountKeyName, cliCatalog, currentAccountGroupName, managedCliKeyProfiles, providerBaseUrls, providerIds } from './catalog'

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

describe('buildAccountKeyName', () => {
  function bytes(text: string): number {
    return new TextEncoder().encode(text).length
  }

  it('joins the username and the group with a hyphen', () => {
    expect(buildAccountKeyName('yoyo', 'Claude-MAX')).toBe('yoyo-Claude-MAX')
    expect(buildAccountKeyName(' 张三 ', '图片模型')).toBe('张三-图片模型')
  })

  it('returns null without a username or a group, so the caller keeps its old name', () => {
    expect(buildAccountKeyName('', 'GPT')).toBeNull()
    expect(buildAccountKeyName('  ', 'GPT')).toBeNull()
    expect(buildAccountKeyName('\u0007', 'GPT')).toBeNull()
    expect(buildAccountKeyName('yoyo', ' ')).toBeNull()
  })

  it('drops control characters from the username', () => {
    expect(buildAccountKeyName('yo\nyo\u007f', 'GPT')).toBe('yoyo-GPT')
  })

  // new-api 拒收超过 50 字节的令牌名（rc.44 AddToken 的 len(token.Name) > 50）。
  it('shortens a long username to fit 50 UTF-8 bytes and keeps the whole group', () => {
    const name = buildAccountKeyName('二十个字的中文用户名二十个字的中文用户名', 'Claude-MAX')
    expect(name).toBe('二十个字的中文用户名二十个-Claude-MAX')
    expect(bytes(name ?? '')).toBeLessThanOrEqual(50)
    expect(buildAccountKeyName('a'.repeat(20), 'GPT')).toBe(`${'a'.repeat(20)}-GPT`)
  })

  it('never splits a character across the byte limit', () => {
    const name = buildAccountKeyName('😀'.repeat(20), 'GPT') ?? ''
    expect(name).toBe(`${'😀'.repeat(11)}-GPT`)
    expect(bytes(name)).toBeLessThanOrEqual(50)
    expect(name.endsWith('-GPT') && !name.includes('\uFFFD')).toBe(true)
  })

  it('cuts the whole name when the group alone would not fit', () => {
    const name = buildAccountKeyName('yoyo', 'g'.repeat(60)) ?? ''
    expect(name).toBe(`yoyo-${'g'.repeat(45)}`)
    expect(bytes(name)).toBe(50)
  })
})
