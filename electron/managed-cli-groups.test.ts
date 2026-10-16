import { describe, expect, it } from 'vitest'
import { managedCliKeyProfiles, providerIds, sub2ApiManagedCliKeyProfiles } from './catalog'
import {
  activeSubscriptionGroupNames,
  loadAccountGroupHints,
  loadManagedCliGroups,
  markRecommendedChatGroup,
  normalizeGroupNames,
  resolveManagedCliGroup,
  resolveManagedCliGroups,
  resolveMappedGroup,
} from './managed-cli-groups'

function named(...names: string[]): { name: string }[] {
  return names.map((name) => ({ name }))
}

// xm 站 2026-10-16 删了「Claude-MAX订阅」「GPT-中转/订阅」这些老名字以后的样子。
const productionGroups = named(
  'default',
  'Claude-MAX',
  'GPT',
  'Gemini',
  'Grok',
  '图片模型',
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
      const group = sub2ApiManagedCliKeyProfiles[provider].group
      // 「Gemini」两套名单里一样，算不上别名。
      expect(resolveManagedCliGroup(provider, renamed)).toEqual({
        group,
        source: group === managedCliKeyProfiles[provider].group ? 'preferred' : 'alias',
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
    const shared = named('default', '默认分组', '图片模型', '生图分组', 'GPT-image2', '视频模型')
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

describe('subscription groups', () => {
  const sub2ApiGroups = [
    ...providerIds.map((provider) => ({ name: sub2ApiManagedCliKeyProfiles[provider].group, platform: provider === 'claude' ? 'anthropic' : provider === 'codex' ? 'openai' : provider })),
    { name: 'Claude 包月', platform: 'anthropic' },
    { name: 'GPT 包月', platform: 'openai' },
  ]

  it('moves a CLI into the subscription group that routes to its upstream', () => {
    expect(resolveManagedCliGroup('claude', sub2ApiGroups, 'solov-api', ['Claude 包月'])).toEqual({ group: 'Claude 包月', source: 'subscription' })
    // A subscription for one CLI leaves the others on their usual groups.
    expect(resolveManagedCliGroup('codex', sub2ApiGroups, 'solov-api', ['Claude 包月'])).toEqual({
      group: sub2ApiManagedCliKeyProfiles.codex.group, source: 'preferred',
    })
  })

  it('ignores a subscription group the backend no longer lets the account use', () => {
    const withoutSubscriptionGroup = sub2ApiGroups.filter((group) => group.name !== 'Claude 包月')
    expect(resolveManagedCliGroup('claude', withoutSubscriptionGroup, 'solov-api', ['Claude 包月'])).toEqual({
      group: sub2ApiManagedCliKeyProfiles.claude.group, source: 'preferred',
    })
  })

  it('tells two subscriptions on the same upstream apart only by name, and otherwise picks neither', () => {
    const groups = [...sub2ApiGroups, { name: 'MAX 包季', platform: 'anthropic' }, { name: 'Pro 包年', platform: 'anthropic' }]
    expect(resolveManagedCliGroup('claude', groups, 'solov-api', ['Claude 包月', 'MAX 包季'])).toEqual({ group: 'Claude 包月', source: 'subscription' })
    expect(resolveManagedCliGroup('claude', groups, 'solov-api', ['Pro 包年', 'MAX 包季']).source).toBe('preferred')
  })

  it('reads only live subscriptions that name a group', () => {
    const now = Date.parse('2026-09-25T00:00:00Z')
    expect(activeSubscriptionGroupNames({ activeSubscriptions: [
      { status: 'active', groupName: 'Claude 包月', endsAt: '2026-10-25T00:00:00Z' },
      { status: 'active', groupName: 'GPT 包月', endsAt: '2026-09-24T00:00:00Z' },
      { status: 'expired', groupName: 'Grok 包月' },
      { status: 'active' },
    ] }, now)).toEqual(['Claude 包月'])
  })
})

describe('loadManagedCliGroups', () => {
  it('uses the history account\'s active subscriptions when picking groups', async () => {
    const resolved = await loadManagedCliGroups({
      listUsableGroups: async () => [{ name: 'Claude 包月', platform: 'anthropic' }, ...named(...providerIds.map((p) => sub2ApiManagedCliKeyProfiles[p].group))],
      getActiveSiteId: () => 'solov-api',
      getSubscriptionSelf: async () => ({ activeSubscriptions: [{ status: 'active', groupName: 'Claude 包月' }] }),
    })
    expect(resolved?.claude).toEqual({ group: 'Claude 包月', source: 'subscription' })
  })

  it('reports null rather than "no subscription" when subscriptions cannot be read', async () => {
    const resolved = await loadManagedCliGroups({
      listUsableGroups: async () => named(...providerIds.map((p) => sub2ApiManagedCliKeyProfiles[p].group)),
      getActiveSiteId: () => 'solov-api',
      getSubscriptionSelf: async () => { throw new Error('连接服务器失败') },
    })
    expect(resolved).toBeNull()
  })

  it('never asks the xm account for subscriptions: they do not depend on the key group there', async () => {
    let asked = false
    const resolved = await loadManagedCliGroups({
      listUsableGroups: async () => productionGroups,
      getActiveSiteId: () => 'solov',
      getSubscriptionSelf: async () => { asked = true; return { activeSubscriptions: [] } },
    })
    expect(asked).toBe(false)
    expect(resolved?.claude.source).toBe('preferred')
  })

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

// xm 站的分组表长这样（10-14 服务端列出来的那份里挑的，名字是 10-16 删了老名字以后的）：同一家有好几个分组，
// 靠名字里的词认不出改了名的那个，只能靠发布者写的对照。
const xmGroups = named(
  'default',
  'Claude-MAX',
  'Claude AWS-B',
  'Claude-KIRO(高缓)',
  'GPT',
  'GPT-官方API直连',
  'Grok',
  'Grok-官方API直连',
  '图片模型',
  '视频模型',
)

function renamedXmGroups(): { name: string }[] {
  const renames: Record<string, string> = {
    'Claude-MAX': 'Claude 主力',
    'GPT': 'GPT 主力',
    'Grok': 'Grok 主力',
    '图片模型': '画图专线',
  }
  return xmGroups.map((group) => ({ name: renames[group.name] ?? group.name }))
}

const renameMap = {
  claude: ['Claude 主力', 'Claude-MAX'],
  codex: ['GPT 主力', 'GPT'],
  grok: ['Grok 主力', 'Grok'],
  image: ['画图专线', '图片模型'],
}

describe('published group map', () => {
  it('cannot find a renamed xm group without the map: every vendor has several groups', () => {
    const renamed = renamedXmGroups()
    for (const provider of ['claude', 'codex', 'grok'] as const) {
      expect(resolveManagedCliGroup(provider, renamed)).toEqual({ group: managedCliKeyProfiles[provider].group, source: 'fallback' })
    }
  })

  it('follows the map to the renamed group', () => {
    const resolved = resolveManagedCliGroups(renamedXmGroups(), 'solov', [], renameMap)
    expect(resolved.claude).toEqual({ group: 'Claude 主力', source: 'mapped' })
    expect(resolved.codex).toEqual({ group: 'GPT 主力', source: 'mapped' })
    expect(resolved.grok).toEqual({ group: 'Grok 主力', source: 'mapped' })
  })

  it('takes the first listed name the account can use, so the old name can stay listed as a fallback', () => {
    expect(resolveManagedCliGroup('claude', xmGroups, 'solov', [], renameMap)).toEqual({ group: 'Claude-MAX', source: 'mapped' })
    const transition = [...xmGroups, { name: 'Claude 主力' }]
    expect(resolveManagedCliGroup('claude', transition, 'solov', [], renameMap)).toEqual({ group: 'Claude 主力', source: 'mapped' })
  })

  it('never conjures a group the account cannot use', () => {
    expect(resolveManagedCliGroup('claude', xmGroups, 'solov', [], { claude: ['没开通的分组'] })).toEqual({
      group: 'Claude-MAX',
      source: 'preferred',
    })
    expect(resolveMappedGroup('image', xmGroups, { image: ['没开通的分组'] })).toBeNull()
  })

  it('leaves roles the map does not mention on the usual order', () => {
    const resolved = resolveManagedCliGroups(xmGroups, 'solov', [], { claude: ['Claude AWS-B'] })
    expect(resolved.claude).toEqual({ group: 'Claude AWS-B', source: 'mapped' })
    expect(resolved.codex).toEqual({ group: 'GPT', source: 'preferred' })
  })

  it('never applies the xm map to the history account', () => {
    const groups = named(...providerIds.map((p) => sub2ApiManagedCliKeyProfiles[p].group), 'GPT 主力')
    expect(resolveManagedCliGroup('codex', groups, 'solov-api', [], renameMap)).toEqual({
      group: sub2ApiManagedCliKeyProfiles.codex.group,
      source: 'preferred',
    })
  })

  it('reads the map alongside the group list', async () => {
    const resolved = await loadManagedCliGroups({
      listUsableGroups: async () => renamedXmGroups(),
      getActiveSiteId: () => 'solov',
      getAccountGroupHints: async () => renameMap,
    })
    expect(resolved?.codex).toEqual({ group: 'GPT 主力', source: 'mapped' })
  })

  it('still resolves the usual way when the map cannot be read', async () => {
    const resolved = await loadManagedCliGroups({
      listUsableGroups: async () => xmGroups,
      getActiveSiteId: () => 'solov',
      getAccountGroupHints: async () => { throw new Error('状态文件读不到') },
    })
    expect(resolved?.codex).toEqual({ group: 'GPT', source: 'preferred' })
  })

  it('does not even ask for the map on the history account', async () => {
    let asked = false
    expect(await loadAccountGroupHints({
      getActiveSiteId: () => 'solov-api',
      getAccountGroupHints: async () => { asked = true; return renameMap },
    })).toBeNull()
    expect(asked).toBe(false)
  })
})

describe('markRecommendedChatGroup', () => {
  it('marks the group the Codex key would use, renamed or not', () => {
    expect(markRecommendedChatGroup(xmGroups, 'solov', null).filter((group) => group.recommended).map((group) => group.name))
      .toEqual(['GPT'])
    expect(markRecommendedChatGroup(renamedXmGroups(), 'solov', renameMap).filter((group) => group.recommended).map((group) => group.name))
      .toEqual(['GPT 主力'])
  })

  it('marks nothing when it cannot tell, leaving the renderer to its own default', () => {
    expect(markRecommendedChatGroup(renamedXmGroups(), 'solov', null).some((group) => group.recommended)).toBe(false)
    const groups = named(...providerIds.map((p) => sub2ApiManagedCliKeyProfiles[p].group))
    expect(markRecommendedChatGroup(groups, 'solov-api', renameMap).some((group) => group.recommended)).toBe(false)
  })
})
