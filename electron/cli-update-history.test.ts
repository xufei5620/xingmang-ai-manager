import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildCliUpdateRecord,
  cliRevertWindowMs,
  CliUpdateHistoryStore,
  parseCliUpdateHistory,
  resolveCliRevertVersion,
} from './cli-update-history'
import { cliVerifiedVersions } from './cli-verified-versions'

const temporaryDirectories: string[] = []

afterEach(() => {
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop()
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-cli-update-history-'))
  temporaryDirectories.push(directory)
  return path.join(fs.realpathSync(directory), 'cli-update-history')
}

const now = Date.UTC(2026, 8, 25, 12)

describe('buildCliUpdateRecord', () => {
  it('records an update that changed the installed version', () => {
    expect(buildCliUpdateRecord('2.1.277', '2.1.282', false, now)).toEqual({ from: '2.1.277', to: '2.1.282', at: now })
  })

  it('skips first installs, reinstalls and versions the user asked for', () => {
    expect(buildCliUpdateRecord(null, '2.1.282', false, now)).toBeNull()
    expect(buildCliUpdateRecord('2.1.282', '2.1.282', false, now)).toBeNull()
    expect(buildCliUpdateRecord('2.1.282', '2.1.277', true, now)).toBeNull()
  })

  it('refuses versions the install channel would not accept back', () => {
    expect(buildCliUpdateRecord('2.1.277 (Claude Code)', '2.1.282', false, now)).toBeNull()
    expect(buildCliUpdateRecord('2.1.277', '../2.1.282', false, now)).toBeNull()
  })
})

describe('resolveCliRevertVersion', () => {
  const record = { from: '2.1.277', to: '2.1.282', at: now }

  it('offers the previous version while the updated one is still installed', () => {
    expect(resolveCliRevertVersion('claude', record, '2.1.282', now + 60_000)).toBe('2.1.277')
  })

  it('stops once the user moved to another version', () => {
    expect(resolveCliRevertVersion('claude', record, '2.1.277', now)).toBeNull()
    expect(resolveCliRevertVersion('claude', record, '2.1.290', now)).toBeNull()
    expect(resolveCliRevertVersion('claude', record, null, now)).toBeNull()
  })

  it('stops after the revert window', () => {
    expect(resolveCliRevertVersion('claude', record, '2.1.282', now + cliRevertWindowMs)).toBe('2.1.277')
    expect(resolveCliRevertVersion('claude', record, '2.1.282', now + cliRevertWindowMs + 1)).toBeNull()
    // 时钟被往回拨过时不当成「刚更新」。
    expect(resolveCliRevertVersion('claude', record, '2.1.282', now - 1)).toBeNull()
  })

  it('never offers to go back to a version with a known problem', () => {
    const blocked = cliVerifiedVersions.claude.blocked.find((range) => !range.sites)
    if (!blocked) throw new Error('cliVerifiedVersions.claude 需要至少一条不分站点的不兼容区间')
    expect(resolveCliRevertVersion('claude', { from: blocked.introduced, to: '9.9.9', at: now }, '9.9.9', now)).toBeNull()
  })

  it('does not apply to Grok CLI', () => {
    expect(resolveCliRevertVersion('grok', { from: '1.0.39', to: '1.0.40', at: now }, '1.0.40', now)).toBeNull()
  })
})

describe('parseCliUpdateHistory', () => {
  it('treats a missing or unreadable file as no history', () => {
    expect(parseCliUpdateHistory(null)).toEqual({})
    expect(parseCliUpdateHistory('{')).toEqual({})
    expect(parseCliUpdateHistory(JSON.stringify({ version: 2, tools: {} }))).toEqual({})
  })

  it('drops unknown tools and malformed entries but keeps the rest', () => {
    expect(parseCliUpdateHistory(JSON.stringify({
      version: 1,
      tools: {
        claude: { from: '2.1.277', to: '2.1.282', at: now },
        codex: { from: '0.156.1', to: 'latest', at: now },
        other: { from: '1.0.0', to: '1.0.1', at: now },
      },
    }))).toEqual({ claude: { from: '2.1.277', to: '2.1.282', at: now } })
  })
})

describe('CliUpdateHistoryStore', () => {
  it('keeps only the latest update per tool', async () => {
    const store = new CliUpdateHistoryStore(temporaryDirectory())
    expect(store.read()).toEqual({})

    await store.record('claude', { from: '2.1.270', to: '2.1.277', at: now })
    await store.record('codex', { from: '0.155.1', to: '0.156.1', at: now })
    await store.record('claude', { from: '2.1.277', to: '2.1.282', at: now + 1 })

    expect(store.read()).toEqual({
      claude: { from: '2.1.277', to: '2.1.282', at: now + 1 },
      codex: { from: '0.155.1', to: '0.156.1', at: now },
    })
  })

  it('drops expired entries when it writes', async () => {
    const store = new CliUpdateHistoryStore(temporaryDirectory())
    await store.record('codex', { from: '0.155.1', to: '0.156.1', at: now })

    await store.record('claude', { from: '2.1.277', to: '2.1.282', at: now + cliRevertWindowMs + 1 })

    expect(Object.keys(store.read())).toEqual(['claude'])
  })
})
