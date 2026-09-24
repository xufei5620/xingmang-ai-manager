import { describe, expect, it } from 'vitest'
import { managedCliKeyProfiles, providerIds, sub2ApiManagedCliKeyProfiles } from './catalog'
import {
  loadManagedCliGroups,
  normalizeGroupNames,
  resolveManagedCliGroup,
  resolveManagedCliGroups,
} from './managed-cli-groups'

function named(...names: string[]): { name: string }[] {
  return names.map((name) => ({ name }))
}

const productionGroups = named(
  'default',
  'Claude-MAX订阅',
  'GPT-中转/订阅',
  'Gemini-中转/订阅',
  'Grok-中转/订阅',
  '图片模型-中转/订阅',
)

describe('normalizeGroupNames', () => {
  it('trims, de-duplicates and drops unusable names', () => {
    const names = normalizeGroupNames([
      { name: '  Claude-MAX订阅  ' },
      { name: 'Claude-MAX订阅' },
      { name: '   ' },
      { name: 'x'.repeat(129) },
      { name: 'default' },
    ])
    expect(names).toEqual(['Claude-MAX订阅', 'default'])
  })

  it('drops names carrying control characters', () => {
    const names = normalizeGroupNames([{ name: 'Claude\u0000MAX' }, { name: 'Grok-中转/订阅' }, { name: 'a\u007fb' }])
    expect(names).toEqual(['Grok-中转/订阅'])
  })

  it('survives malformed server payloads', () => {
    const hostile = [{ name: 42 }, { name: null }, {}, { name: 'Grok-中转/订阅' }] as { name: string }[]
    expect(normalizeGroupNames(hostile)).toEqual(['Grok-中转/订阅'])
  })
})

describe('resolveManagedCliGroup', () => {
  it('keeps the shipped name when the backend still offers it', () => {
    for (const provider of providerIds) {
      expect(resolveManagedCliGroup(provider, productionGroups)).toEqual({
        group: managedCliKeyProfiles[provider].group,
        source: 'preferred',
      })
    }
  })

  it('keeps each site on its own names', () => {
    const sub2ApiGroups = named(...providerIds.map((provider) => sub2ApiManagedCliKeyProfiles[provider].group))
    for (const provider of providerIds) {
      expect(resolveManagedCliGroup(provider, sub2ApiGroups, 'solov-api')).toEqual({
        group: sub2ApiManagedCliKeyProfiles[provider].group,
        source: 'preferred',
      })
    }
  })

  it('falls back to the other known name list before guessing', () => {
    const renamed = named('default', ...providerIds.map((provider) => sub2ApiManagedCliKeyProfiles[provider].group))
    for (const provider of providerIds) {
      expect(resolveManagedCliGroup(provider, renamed)).toEqual({
        group: sub2ApiManagedCliKeyProfiles[provider].group,
        source: 'alias',
      })
    }
  })

  it('recognises a renamed group by its vendor token', () => {
    const renamed = named('default', 'Claude 高级订阅', 'Codex 专用', 'Gemini 通道', 'Grok 通道')
    expect(resolveManagedCliGroup('claude', renamed)).toEqual({ group: 'Claude 高级订阅', source: 'detected' })
    expect(resolveManagedCliGroup('codex', renamed)).toEqual({ group: 'Codex 专用', source: 'detected' })
    expect(resolveManagedCliGroup('gemini', renamed)).toEqual({ group: 'Gemini 通道', source: 'detected' })
    expect(resolveManagedCliGroup('grok', renamed)).toEqual({ group: 'Grok 通道', source: 'detected' })
  })

  it('never claims a shared group for a CLI', () => {
    const shared = named('default', '默认分组', '图片模型-中转/订阅', '生图分组', 'GPT-image2', '视频模型-中转/订阅')
    for (const provider of providerIds) {
      expect(resolveManagedCliGroup(provider, shared)).toEqual({
        group: managedCliKeyProfiles[provider].group,
        source: 'fallback',
      })
    }
  })

  it('refuses to pick when two groups look equally plausible', () => {
    const ambiguous = named('default', 'Claude 订阅', 'Claude 按量')
    expect(resolveManagedCliGroup('claude', ambiguous)).toEqual({
      group: managedCliKeyProfiles.claude.group,
      source: 'fallback',
    })
  })

  it('refuses a name that reads as two vendors at once', () => {
    expect(resolveManagedCliGroup('claude', named('Claude 与 Gemini 合并通道'))).toEqual({
      group: managedCliKeyProfiles.claude.group,
      source: 'fallback',
    })
  })

  it('recognises a renamed group by the upstream the historical backend says it routes to', () => {
    const renamed = [
      { name: 'default', platform: 'openai' },
      { name: 'MAX 专线', platform: 'anthropic' },
      { name: 'Pro 通道', platform: 'openai' },
      { name: '谷歌通道', platform: 'Gemini' },
      { name: '图片模型', platform: 'openai' },
    ]
    expect(resolveManagedCliGroup('claude', renamed, 'solov-api')).toEqual({ group: 'MAX 专线', source: 'detected' })
    expect(resolveManagedCliGroup('codex', renamed, 'solov-api')).toEqual({ group: 'Pro 通道', source: 'detected' })
    expect(resolveManagedCliGroup('gemini', renamed, 'solov-api')).toEqual({ group: '谷歌通道', source: 'detected' })
    expect(resolveManagedCliGroup('grok', renamed, 'solov-api')).toEqual({
      group: sub2ApiManagedCliKeyProfiles.grok.group,
      source: 'fallback',
    })
  })

  it('uses the name only to tell apart several groups on the right upstream', () => {
    const tiers = [
      { name: 'Claude MAX 专线', platform: 'anthropic' },
      { name: '按量通道', platform: 'anthropic' },
      { name: 'Claude 兼容（Kimi）', platform: 'kimi' },
    ]
    expect(resolveManagedCliGroup('claude', tiers, 'solov-api')).toEqual({ group: 'Claude MAX 专线', source: 'detected' })
    const undecided = [{ name: 'MAX 专线', platform: 'anthropic' }, { name: '按量通道', platform: 'anthropic' }]
    expect(resolveManagedCliGroup('claude', undecided, 'solov-api')).toEqual({
      group: sub2ApiManagedCliKeyProfiles.claude.group,
      source: 'fallback',
    })
  })

  it('never takes a group routed to another CLI upstream, whatever its name says', () => {
    expect(resolveManagedCliGroup('claude', [{ name: 'Claude 风格 GPT 通道', platform: 'openai' }], 'solov-api')).toEqual({
      group: sub2ApiManagedCliKeyProfiles.claude.group,
      source: 'fallback',
    })
  })

  it('falls back when the backend returns nothing usable', () => {
    expect(resolveManagedCliGroup('codex', [])).toEqual({
      group: managedCliKeyProfiles.codex.group,
      source: 'fallback',
    })
  })
})

describe('resolveManagedCliGroups', () => {
  it('never hands two CLIs the same group', () => {
    const renamed = named('default', 'Claude 高级订阅', 'Codex 专用', 'Gemini 通道', 'Grok 通道', '生图分组')
    const resolved = resolveManagedCliGroups(renamed)
    const groups = providerIds.map((provider) => resolved[provider].group)
    expect(new Set(groups).size).toBe(groups.length)
  })

  it('covers every provider', () => {
    const resolved = resolveManagedCliGroups(productionGroups)
    expect(Object.keys(resolved).sort()).toEqual([...providerIds].sort())
  })
})

describe('loadManagedCliGroups', () => {
  it('resolves against the site the session is on', async () => {
    const resolved = await loadManagedCliGroups({
      listUsableGroups: async () => named(...providerIds.map((p) => sub2ApiManagedCliKeyProfiles[p].group)),
      getActiveSiteId: () => 'solov-api',
    })
    expect(resolved?.codex).toEqual({ group: sub2ApiManagedCliKeyProfiles.codex.group, source: 'preferred' })
  })

  it('reports null instead of failing when the backend is unreachable', async () => {
    const resolved = await loadManagedCliGroups({
      listUsableGroups: async () => { throw new Error('连接服务器失败') },
    })
    expect(resolved).toBeNull()
  })
})
