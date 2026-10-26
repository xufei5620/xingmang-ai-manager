import { describe, expect, it, vi } from 'vitest'
import { mcpNameTakenIn, parseHttpHeaders } from './extensions-common'
import type { V2Bridge } from '../../types'

type Snapshot = Awaited<ReturnType<V2Bridge['listProviderExtensions']>>

function snapshot(provider: Snapshot['provider'], items: Array<{ id: string; scope: 'user' | 'project'; kind?: 'mcp' | 'skill' }>): Snapshot {
  return {
    provider,
    checkedAt: '2026-10-26T00:00:00.000Z',
    capabilities: {
      mcp: { list: true, reason: null },
      skill: { list: true, reason: null },
      plugin: { list: true, reason: null },
    },
    warnings: [],
    items: items.map((item) => ({
      provider,
      kind: item.kind ?? 'mcp',
      id: item.id,
      name: item.id,
      description: '',
      installed: true,
      enabled: true,
      scope: item.scope,
      currentVersion: null,
      latestVersion: null,
      source: { kind: 'source-unknown', locator: null, reference: null },
      update: { state: 'unsupported', reason: '', checkedAt: null },
      operations: { install: false, uninstall: true, enable: false, disable: false, update: false },
    })),
  }
}

describe('parseHttpHeaders', () => {
  it('reads one "name: value" per line or a JSON object, trimming values', () => {
    expect(parseHttpHeaders('')).toEqual({})
    expect(parseHttpHeaders('Authorization: Bearer a:b\n\n  X-Region:cn  ')).toEqual({ Authorization: 'Bearer a:b', 'X-Region': 'cn' })
    expect(parseHttpHeaders('{"X-Api-Key": " k "}')).toEqual({ 'X-Api-Key': 'k' })
  })

  it('explains the format when a line has no name, an empty value or a bad name', () => {
    for (const text of ['Bearer abc', 'Authorization:', 'Bad Name: x', '-H: x', '{"X": 1}', '{oops']) {
      expect(() => parseHttpHeaders(text)).toThrow('请求头每行写一个，格式是「名称: 值」')
    }
  })
})

describe('mcpNameTakenIn', () => {
  it('lists the other tools that already have the name, so their own entry is never replaced', async () => {
    const listProviderExtensions = vi.fn(async (provider: Snapshot['provider']) => {
      if (provider === 'codex') return snapshot('codex', [{ id: 'github', scope: 'project' }])
      if (provider === 'grok') return snapshot('grok', [{ id: 'github', scope: 'project' }, { id: 'docs', scope: 'user', kind: 'skill' }])
      throw new Error('列表读不到')
    })
    const api: Pick<V2Bridge, 'listProviderExtensions'> = { listProviderExtensions }

    // Codex 不分层：项目里同名的会盖住全局那条。Grok 只看要装进去的那一层；读不到列表的 Claude Code 不拦。
    expect(await mcpNameTakenIn(api, ['claude', 'codex', 'grok'], 'github', 'user')).toEqual(['codex'])
    expect(await mcpNameTakenIn(api, ['codex', 'grok'], 'github', 'project')).toEqual(['codex', 'grok'])
    expect(await mcpNameTakenIn(api, ['grok'], 'docs', 'user')).toEqual([])
    expect(await mcpNameTakenIn(api, [], 'github', 'user')).toEqual([])
  })
})
