import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { externalClientOfficialDownloadUrls, type ExternalClientStatus } from './external-client-contract'
import {
  EXTERNAL_CLIENT_SNAPSHOT_CACHE_VERSION,
  createExternalClientSnapshotCache,
  parseExternalClientSnapshotCache,
  serializeExternalClientSnapshotCache,
} from './external-client-snapshot-cache'
import type { OptionalKeys, RequiredFields, SameShape } from './system-snapshot-cache'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function tempDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-external-client-cache-'))
  temporaryDirectories.push(directory)
  return directory
}

function client(tool: ExternalClientStatus['tool'], overrides: Partial<ExternalClientStatus> = {}): ExternalClientStatus {
  return {
    tool, installed: true, version: '1.2.3', path: `C:\\Users\\Tester\\AppData\\Local\\${tool}\\${tool}.exe`, installDirectory: `C:\\Users\\Tester\\AppData\\Local\\${tool}`,
    running: false, installSupported: true, launchSupported: true, detectionError: null, installHint: null,
    configured: true, model: 'fixture-model', configurationSource: 'xingmang', configurationError: null,
    ...overrides,
  }
}

function clients(): ExternalClientStatus[] {
  return [
    client('workbuddy', { running: true }),
    client('claudeDesktop', { configurationReady: true, officialDownloadUrl: externalClientOfficialDownloadUrls.claudeDesktop }),
    client('opencode', { installed: false, version: null, path: null, installDirectory: null, configured: false, model: null, configurationSource: 'missing', officialDownloadUrl: null }),
  ]
}

function document(clientsOnDisk: unknown, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: EXTERNAL_CLIENT_SNAPSHOT_CACHE_VERSION, savedAt: '2026-10-05T10:00:00.000Z', clients: clientsOnDisk, ...overrides })
}

describe('external client snapshot cache', () => {
  it('round-trips the last scan, marks every row with when it was saved and never claims a client is still running', () => {
    const content = serializeExternalClientSnapshotCache(clients(), new Date('2026-10-05T10:00:05.000Z'))
    const parsed = parseExternalClientSnapshotCache(content!)

    expect(parsed).toEqual(clients().map((status) => ({ ...status, running: false, cachedAt: '2026-10-05T10:00:05.000Z' })))
  })

  it('keeps only a whole scan: one row for each of the three clients', () => {
    const [workbuddy, claudeDesktop] = clients()
    expect(serializeExternalClientSnapshotCache([workbuddy, claudeDesktop], new Date())).toBeNull()
    expect(serializeExternalClientSnapshotCache([workbuddy, claudeDesktop, workbuddy], new Date())).toBeNull()
    expect(parseExternalClientSnapshotCache(document([workbuddy, claudeDesktop]))).toBeNull()
    expect(parseExternalClientSnapshotCache(document([workbuddy, claudeDesktop, claudeDesktop]))).toBeNull()
  })

  it('keeps no command output secrets on disk and hands nothing it does not know back to the page', () => {
    const leaked = clients().map((status) => status.tool === 'workbuddy'
      ? { ...status, detectionError: 'Authorization: Bearer sk-live-secret-value failed', extra: 'not a status field' }
      : status)
    const content = serializeExternalClientSnapshotCache(leaked, new Date())!
    expect(content).not.toContain('sk-live-secret-value')
    expect(content).not.toContain('not a status field')

    const smuggled = JSON.parse(content) as { clients: Record<string, unknown>[] }
    smuggled.clients[0].injected = '<img src=x>'
    const parsed = parseExternalClientSnapshotCache(JSON.stringify(smuggled))
    expect(parsed?.[0]).not.toHaveProperty('injected')
  })

  it('ignores a file in another format version or with a broken row, including a download page off the allowlist', () => {
    const rows = clients()
    expect(parseExternalClientSnapshotCache(document(rows, { version: EXTERNAL_CLIENT_SNAPSHOT_CACHE_VERSION + 1 }))).toBeNull()
    expect(parseExternalClientSnapshotCache(document(rows, { savedAt: 'yesterday' }))).toBeNull()
    expect(parseExternalClientSnapshotCache('{not json')).toBeNull()
    expect(parseExternalClientSnapshotCache(document({ workbuddy: rows[0] }))).toBeNull()
    const broken: Array<[string, unknown]> = [
      ['tool', 'notepad'], ['installed', 'yes'], ['version', 3], ['running', undefined], ['detectionError', 404],
      ['configurationSource', 'elsewhere'], ['configurationReady', 'true'], ['model', ['a']],
      ['officialDownloadUrl', 'https://evil.example/download'], ['officialDownloadUrl', externalClientOfficialDownloadUrls.opencode],
    ]
    for (const [field, value] of broken) {
      const row: Record<string, unknown> = { ...rows[1], [field]: value }
      expect(parseExternalClientSnapshotCache(document([rows[0], row, rows[2]])), `${field}=${String(value)}`).toBeNull()
    }
    // A foreign download page from this process is simply not written down.
    const saved = serializeExternalClientSnapshotCache([{ ...rows[0], officialDownloadUrl: 'https://evil.example/download' }, rows[1], rows[2]], new Date())
    expect(saved).not.toContain('evil.example')
  })

  it('trips the shape pins when a required client field changes or an optional one is added', () => {
    // 真正的检查发生在 npm run typecheck：带 @ts-expect-error 的几行必须一直编译不过。
    const unchanged: SameShape<RequiredFields<ExternalClientStatus>, RequiredFields<ExternalClientStatus>> = true
    // @ts-expect-error a new required field is exactly what an older file would be missing
    const requiredAdded: SameShape<RequiredFields<ExternalClientStatus & { addedLater: string }>, RequiredFields<ExternalClientStatus>> = true
    // @ts-expect-error a retyped required field no longer matches what older files hold
    const retyped: SameShape<RequiredFields<Omit<ExternalClientStatus, 'installed'> & { installed: string }>, RequiredFields<ExternalClientStatus>> = true
    // @ts-expect-error a new optional field has to be sorted into what is saved first
    const optionalAdded: SameShape<OptionalKeys<ExternalClientStatus & { addedLater?: string }>, OptionalKeys<ExternalClientStatus>> = true
    expect([unchanged, requiredAdded, retyped, optionalAdded]).toEqual([true, true, true, true])
  })

  it('writes atomically to the data directory and reads it back once per process', async () => {
    const directory = tempDirectory()
    const filePath = path.join(directory, 'nested', 'external-client-snapshot.json')
    const writer = createExternalClientSnapshotCache({ filePath, now: () => new Date('2026-10-05T10:00:05.000Z') })
    await writer.save(clients())
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['external-client-snapshot.json'])
    // A partial list leaves the last whole one in place.
    await writer.save(clients().slice(0, 1))
    const reader = createExternalClientSnapshotCache({ filePath })
    const first = reader.load()
    expect(reader.load()).toBe(first)
    const loaded = await first
    expect(loaded?.map((status) => [status.tool, status.cachedAt])).toEqual([
      ['workbuddy', '2026-10-05T10:00:05.000Z'], ['claudeDesktop', '2026-10-05T10:00:05.000Z'], ['opencode', '2026-10-05T10:00:05.000Z'],
    ])
  })

  it('answers null with a warning instead of throwing when the file cannot be trusted', async () => {
    const directory = tempDirectory()
    const filePath = path.join(directory, 'external-client-snapshot.json')
    const warnings: string[] = []
    fs.writeFileSync(path.join(directory, 'elsewhere.json'), serializeExternalClientSnapshotCache(clients(), new Date())!)
    fs.linkSync(path.join(directory, 'elsewhere.json'), filePath)
    const cache = createExternalClientSnapshotCache({ filePath, onWarning: (code) => warnings.push(code) })
    await expect(cache.load()).resolves.toBeNull()
    expect(warnings).toEqual(['external-client-cache-read-failed'])
  })

  it('answers null when there is no file yet', async () => {
    const cache = createExternalClientSnapshotCache({ filePath: path.join(tempDirectory(), 'external-client-snapshot.json') })
    await expect(cache.load()).resolves.toBeNull()
  })
})
