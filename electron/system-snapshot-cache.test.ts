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
  type OptionalKeys,
  type Pin,
  type RequiredFields,
  type SameShape,
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

  it('ignores a file written in another format version or with a broken shape, whichever app version wrote it', () => {
    const content = serializeSystemSnapshotCache(snapshot(), '0.2.9', new Date())!
    const document = JSON.parse(content) as Record<string, unknown>
    expect(parseSystemSnapshotCache(JSON.stringify({ ...document, version: SYSTEM_SNAPSHOT_CACHE_VERSION + 1 }), '0.2.9')).toBeNull()
    expect(parseSystemSnapshotCache(JSON.stringify({ ...document, version: SYSTEM_SNAPSHOT_CACHE_VERSION + 1 }), '0.3.0')).toBeNull()
    const withoutGrok = JSON.parse(content) as { snapshot: { clis: Record<string, unknown> } }
    delete withoutGrok.snapshot.clis.grok
    expect(parseSystemSnapshotCache(JSON.stringify(withoutGrok), '0.2.9')).toBeNull()
    expect(parseSystemSnapshotCache(JSON.stringify(withoutGrok), '0.3.0')).toBeNull()
    const badInstalled = JSON.parse(content) as { snapshot: { runtime: { node: { installed: unknown } } } }
    badInstalled.snapshot.runtime.node.installed = 'yes'
    expect(parseSystemSnapshotCache(JSON.stringify(badInstalled), '0.2.9')).toBeNull()
    expect(parseSystemSnapshotCache('{not json', '0.2.9')).toBeNull()
    expect(parseSystemSnapshotCache(JSON.stringify({ ...document, savedAt: 'yesterday' }), '0.2.9')).toBeNull()
  })

  it('reads a file another app version wrote, minus the verdicts that version drew from its own version list', () => {
    const advised = cli({
      version: '2.1.266',
      latestVersion: '2.1.288',
      updateAvailable: true,
      updateState: 'available',
      versionAdvice: { recommendedVersion: '2.1.270', blockedReason: '这一版有已知问题', onRecommended: false, pinned: true, rollbackAvailable: true, recommendedIsNewer: true },
      revertVersion: '2.1.260',
    })
    const content = serializeSystemSnapshotCache(snapshot({ clis: { ...snapshot().clis, claude: advised } }), '0.2.14', new Date('2026-10-02T10:00:05.000Z'))!
    const sameVersion = parseSystemSnapshotCache(content, '0.2.14')
    const nextVersion = parseSystemSnapshotCache(content, '0.2.15')
    expect(nextVersion?.cachedAt).toBe('2026-10-02T10:00:05.000Z')
    expect(nextVersion?.clis.claude).toMatchObject({ installed: true, version: '2.1.266', path: '/opt/cli', latestVersion: null, updateAvailable: false, updateState: 'unknown' })
    expect(nextVersion?.clis.claude.versionAdvice).toBeUndefined()
    expect(nextVersion?.clis.claude.revertVersion).toBeUndefined()
    expect(providerIds.filter((id) => nextVersion?.clis[id].updateAvailable !== false)).toEqual([])
    // 装没装、装在哪这些事实不分版本，照原样留下。
    expect({ ...nextVersion, clis: undefined }).toEqual({ ...sameVersion, clis: undefined })
    // 同一版本写的照旧原样用，和以前一样。
    expect(sameVersion?.clis.claude).toMatchObject({ latestVersion: '2.1.288', updateAvailable: true, updateState: 'available', revertVersion: '2.1.260', versionAdvice: { recommendedVersion: '2.1.270', rollbackAvailable: true } })
  })

  it('trips the shape pins when a required snapshot field changes or a CLI optional field goes unsorted', () => {
    // 真正的检查发生在 npm run typecheck：带 @ts-expect-error 的几行必须一直编译不过。
    const unchanged: SameShape<RequiredFields<ToolStatus>, RequiredFields<ToolStatus>> = true
    const optionalAdded: SameShape<RequiredFields<ToolStatus & { addedLater?: string }>, RequiredFields<ToolStatus>> = true
    // @ts-expect-error a new required field is exactly what an older file would be missing
    const requiredAdded: SameShape<RequiredFields<ToolStatus & { addedLater: string }>, RequiredFields<ToolStatus>> = true
    // @ts-expect-error a required field turned optional changes the shape too
    const madeOptional: SameShape<RequiredFields<Omit<ToolStatus, 'path'> & { path?: string | null }>, RequiredFields<ToolStatus>> = true
    // @ts-expect-error a retyped required field no longer matches what older files hold
    const retyped: SameShape<RequiredFields<Omit<ToolStatus, 'installed'> & { installed: string }>, RequiredFields<ToolStatus>> = true
    // @ts-expect-error a new optional field on a CLI status has to be sorted into facts or verdicts first
    const optionalUnsorted: SameShape<OptionalKeys<CliStatus & { addedLater?: string }>, OptionalKeys<CliStatus>> = true
    // @ts-expect-error a pin has to reject a shape that no longer matches
    type Mismatch = Pin<false>
    expect([unchanged, optionalAdded, requiredAdded, madeOptional, retyped, optionalUnsorted]).toEqual([true, true, true, true, true, true])
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

  it('still hands the home page the last scan on the first launch after an update', async () => {
    const filePath = path.join(tempDirectory(), 'system-snapshot.json')
    await createSystemSnapshotCache({ filePath, appVersion: '0.2.15', now: () => new Date('2026-10-04T09:00:00.000Z') }).save(snapshot())
    const updated = await createSystemSnapshotCache({ filePath, appVersion: '0.2.16' }).load()
    expect(updated?.cachedAt).toBe('2026-10-04T09:00:00.000Z')
    expect(updated?.clis.claude).toMatchObject({ installed: true, version: '1.0.0', updateAvailable: false })
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
