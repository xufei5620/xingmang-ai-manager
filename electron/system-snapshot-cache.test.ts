import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { providerIds } from './catalog'
import {
  SYSTEM_SNAPSHOT_CACHE_VERSION,
  buildCachedSystemSnapshot,
  createSystemSnapshotCache,
  parseSystemSnapshotCache,
  serializeSystemSnapshotCache,
} from './system-snapshot-cache'
import type { CliStatus, SystemSnapshot, ToolStatus } from './system-service'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function tempDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-snapshot-cache-'))
  temporaryDirectories.push(directory)
  return directory
}

function tool(overrides: Partial<ToolStatus> = {}): ToolStatus {
  return { installed: true, version: '22.1.0', path: '/usr/bin/node', installDirectory: '/usr/bin', ...overrides }
}

function cli(overrides: Partial<CliStatus> = {}): CliStatus {
  return {
    ...tool({ version: '1.0.0', path: '/opt/cli', installDirectory: '/opt' }),
    latestVersion: '1.0.1',
    updateAvailable: true,
    uninstall: { supported: true },
    ...overrides,
  } as CliStatus
}

function snapshot(overrides: Partial<SystemSnapshot> = {}): SystemSnapshot {
  return {
    checkedAt: '2026-09-22T10:00:00.000Z',
    network: { publicIp: '203.0.113.9', countryCode: 'CN', region: 'mainland-china', checkedAt: '2026-09-22T10:00:00.000Z', error: null },
    runtime: { node: tool(), npm: tool({ version: '10.0.0' }), python: tool({ installed: false, version: null, path: null, installDirectory: null }), git: tool({ version: '2.45.0' }) },
    clis: Object.fromEntries(providerIds.map((id) => [id, cli()])) as SystemSnapshot['clis'],
    desktopApps: { codex: { ...tool({ installed: false, version: null, path: null, installDirectory: null }), appVersion: null, mirrorVersion: null, mirrorUpdateAvailable: null, mirrorError: null, running: false } },
    officialChatGpt: { email: 'someone@example.com' } as unknown as SystemSnapshot['officialChatGpt'],
    ...overrides,
  }
}

describe('system snapshot cache', () => {
  it('round-trips the last scan and marks it with when it was saved', () => {
    const content = serializeSystemSnapshotCache(snapshot(), '0.2.9', new Date('2026-09-22T10:00:05.000Z'))
    expect(content).not.toBeNull()
    const parsed = parseSystemSnapshotCache(content!, '0.2.9')
    expect(parsed?.cachedAt).toBe('2026-09-22T10:00:05.000Z')
    expect(parsed?.clis.claude).toMatchObject({ installed: true, version: '1.0.0', updateAvailable: true })
    expect(parsed?.runtime.python.installed).toBe(false)
  })

  it('keeps nothing secret or personal on disk: no ChatGPT account, no public IP, and command output is redacted', () => {
    const leaky = snapshot({
      clis: { ...snapshot().clis, codex: cli({ detectionFailed: true, detectionError: 'failed: Authorization: Bearer sk-live-abcdefghijkl api_key=hunter2secret' }) },
    })
    const content = serializeSystemSnapshotCache(leaky, '0.2.9', new Date())!
    expect(content).not.toContain('sk-live-abcdefghijkl')
    expect(content).not.toContain('hunter2secret')
    expect(content).not.toContain('someone@example.com')
    expect(content).not.toContain('203.0.113.9')
    expect(content).not.toMatch(/"apiKey"/i)
    expect(buildCachedSystemSnapshot(leaky).officialChatGpt).toBeUndefined()
  })

  it('ignores a file written by another app version, another format version, or with a broken shape', () => {
    const content = serializeSystemSnapshotCache(snapshot(), '0.2.9', new Date())!
    expect(parseSystemSnapshotCache(content, '0.3.0')).toBeNull()
    const document = JSON.parse(content) as Record<string, unknown>
    expect(parseSystemSnapshotCache(JSON.stringify({ ...document, version: SYSTEM_SNAPSHOT_CACHE_VERSION + 1 }), '0.2.9')).toBeNull()
    const withoutGrok = JSON.parse(content) as { snapshot: { clis: Record<string, unknown> } }
    delete withoutGrok.snapshot.clis.grok
    expect(parseSystemSnapshotCache(JSON.stringify(withoutGrok), '0.2.9')).toBeNull()
    const badInstalled = JSON.parse(content) as { snapshot: { runtime: { node: { installed: unknown } } } }
    badInstalled.snapshot.runtime.node.installed = 'yes'
    expect(parseSystemSnapshotCache(JSON.stringify(badInstalled), '0.2.9')).toBeNull()
    expect(parseSystemSnapshotCache('{not json', '0.2.9')).toBeNull()
    expect(parseSystemSnapshotCache(JSON.stringify({ ...document, savedAt: 'yesterday' }), '0.2.9')).toBeNull()
  })

  it('writes atomically to the data directory and reads it back once per process', async () => {
    const directory = tempDirectory()
    const filePath = path.join(directory, 'nested', 'system-snapshot.json')
    const writer = createSystemSnapshotCache({ filePath, appVersion: '0.2.9', now: () => new Date('2026-09-22T10:00:05.000Z') })
    await writer.save(snapshot())
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['system-snapshot.json'])
    const reader = createSystemSnapshotCache({ filePath, appVersion: '0.2.9' })
    const first = reader.load()
    expect(reader.load()).toBe(first)
    await expect(first).resolves.toMatchObject({ cachedAt: '2026-09-22T10:00:05.000Z' })
  })

  it('answers null with a warning instead of throwing when the file cannot be trusted', async () => {
    const directory = tempDirectory()
    const filePath = path.join(directory, 'system-snapshot.json')
    const warnings: string[] = []
    fs.writeFileSync(path.join(directory, 'elsewhere.json'), serializeSystemSnapshotCache(snapshot(), '0.2.9', new Date())!)
    fs.linkSync(path.join(directory, 'elsewhere.json'), filePath)
    const cache = createSystemSnapshotCache({ filePath, appVersion: '0.2.9', onWarning: (code) => warnings.push(code) })
    await expect(cache.load()).resolves.toBeNull()
    expect(warnings).toEqual(['snapshot-cache-read-failed'])
  })

  it('answers null when there is no file yet', async () => {
    const cache = createSystemSnapshotCache({ filePath: path.join(tempDirectory(), 'system-snapshot.json'), appVersion: '0.2.9' })
    await expect(cache.load()).resolves.toBeNull()
  })
})
