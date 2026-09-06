import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { redactHomeDirectory, RuntimeLogStore } from './runtime-log'
import { recordStartupFailure } from './startup-log'

const temporaryDirectories: string[] = []

function createStore(options: { maxFileBytes?: number; archiveCount?: number } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-runtime-log-'))
  temporaryDirectories.push(directory)
  return new RuntimeLogStore({
    directory,
    appName: '星芒AI管理工具',
    appVersion: '1.0.0',
    packaged: false,
    ...options,
  })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('RuntimeLogStore', () => {
  it('redacts Windows home paths across casing, separators and JSON escaping', () => {
    const home = 'C:\\Users\\Peaker'
    const input = [
      'c:\\users\\peaker\\.codex\\config.toml',
      'C:/Users/Peaker/.claude/settings.json',
      'C:\\\\Users\\\\Peaker\\\\.gemini',
    ].join('\n')
    const redacted = redactHomeDirectory(input, home)

    expect(redacted.toLowerCase()).not.toContain('users')
    expect(redacted.match(/%USERPROFILE%/g)).toHaveLength(3)
  })

  it('adopts a pre-startup failure record so it reaches feedback and diagnostics', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-runtime-log-'))
    temporaryDirectories.push(directory)
    const startupLog = path.join(directory, 'startup-failure.log')
    recordStartupFailure(new Error('protocol registration exploded'), {
      phase: 'whenReady',
    }, { userDataDirectory: directory })
    // recordStartupFailure writes into <userData>/logs; the store reads its own
    // directory, which is that same logs directory in production.
    fs.renameSync(path.join(directory, 'logs', 'startup-failure.log'), startupLog)

    const store = new RuntimeLogStore({
      directory,
      appName: '星芒AI管理工具',
      appVersion: '1.0.0',
      packaged: false,
    })
    const snapshot = await store.snapshot()

    const adopted = snapshot.entries.find((entry) => entry.event === 'startup.failure.recovered')
    expect(adopted).toBeDefined()
    expect(JSON.stringify(adopted?.detail)).toContain('protocol registration exploded')
    // The feedback export is the other consumer support actually reads.
    expect(await store.feedbackReport()).toContain('protocol registration exploded')
    // Draining it prevents the same crash being re-reported on every launch.
    expect(fs.existsSync(startupLog)).toBe(false)
  })

  it('persists UTF-8 JSONL and redacts secrets recursively', async () => {
    const store = createStore()
    store.log('error', 'ipc', 'config.save', 'Authorization: Bearer private-token sk-private-key', {
      provider: 'codex',
      apiKey: 'plain-private-key',
      nested: { access_token: 'nested-private-token', result: 'failed' },
    })

    const snapshot = await store.snapshot()
    const serialized = JSON.stringify(snapshot)
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0]).toMatchObject({ level: 'error', source: 'ipc', event: 'config.save' })
    expect(serialized).not.toContain('private-token')
    expect(serialized).not.toContain('private-key')
    expect(serialized).toContain('[REDACTED]')
    expect(fs.readFileSync(store.filePath).subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
  })

  it('rotates bounded files and reads the retained entries newest first', async () => {
    const store = createStore({ maxFileBytes: 520, archiveCount: 2 })
    for (let index = 0; index < 12; index += 1) {
      store.log('info', 'test', 'rotation', `entry-${index}-${'x'.repeat(70)}`)
    }

    const snapshot = await store.snapshot()
    expect(snapshot.entries[0].message).toContain('entry-11-')
    expect(snapshot.total).toBeGreaterThan(1)
    expect(fs.existsSync(`${store.filePath}.1`)).toBe(true)
    expect(fs.existsSync(`${store.filePath}.2`)).toBe(true)
  })

  it('builds a sanitized feedback report and clears all retained logs', async () => {
    const store = createStore()
    store.exception('main', 'failure', new Error('token=private-value'))

    const report = await store.feedbackReport()
    expect(report).toContain('星芒AI管理工具 反馈与诊断')
    expect(report).not.toContain('private-value')
    await store.clear()
    expect((await store.snapshot()).entries).toEqual([])
  })

  it('re-sanitizes legacy on-disk entries before either UI snapshots or feedback exports', async () => {
    const store = createStore()
    fs.writeFileSync(store.filePath, `${JSON.stringify({
      id: 'legacy-entry', timestamp: '2026-09-07T00:00:00.000Z', level: 'error', source: 'legacy', event: 'old-client',
      message: 'Authorization: Bearer legacy-private-value',
      detail: { apiKey: 'legacy-private-key', nested: { refresh_token: 'legacy-cookie' } },
      legacyPassword: 'legacy-extra-field-secret',
    })}\n`, 'utf8')
    const serialized = JSON.stringify(await store.snapshot())
    const report = await store.captureFeedbackReport()
    for (const secret of ['legacy-private-value', 'legacy-private-key', 'legacy-cookie', 'legacy-extra-field-secret']) {
      expect(serialized).not.toContain(secret)
      expect(report.text).not.toContain(secret)
    }
    expect(report.entries).toBe(1)
    expect(report.text).toContain('[REDACTED]')
  })

  it('bounds nested or self-referential Error metadata instead of overflowing the stack', async () => {
    const store = createStore()
    const error = Object.assign(new Error('retry failed'), { credential: 'private-error-credential' }) as Error & { self?: Error }
    error.self = error
    expect(() => store.exception('main', 'cyclic-error', error)).not.toThrow()
    const report = await store.captureFeedbackReport()
    expect(report.text).toContain('retry failed')
    expect(report.text).toContain('[TRUNCATED]')
    expect(report.text).not.toContain('private-error-credential')
  })

  it('captures report text and its count together, independently of later appends or clears', async () => {
    const store = createStore()
    store.log('info', 'fixture', 'first', 'first fixed entry')
    const capture = await store.captureFeedbackReport()
    store.log('info', 'fixture', 'second', 'later appended entry')
    await store.clear()
    expect(capture.entries).toBe(1)
    expect(capture.text).toContain('日志条数: 1')
    expect(capture.text).toContain('first fixed entry')
    expect(capture.text).not.toContain('later appended entry')
    expect((await store.snapshot()).total).toBe(0)
  })

  it('keeps structured command metadata needed to diagnose process failures', async () => {
    const store = createStore()
    const error = Object.assign(new Error('Failed to start command: npm'), {
      code: 'SPAWN_FAILED',
      executable: 'D:\\nodejs\\npm',
      argv: ['install', '--global', '@google/gemini-cli@latest'],
      stderr: 'token=private-value',
      durationMs: 3,
    })
    store.exception('maintenance', 'cli.install.failed', error, { provider: 'gemini' })

    const entry = (await store.snapshot()).entries[0]
    expect(entry.detail).toMatchObject({
      provider: 'gemini',
      error: {
        code: 'SPAWN_FAILED',
        executable: 'D:\\nodejs\\npm',
        argv: ['install', '--global', '@google/gemini-cli@latest'],
        stderr: 'token=[REDACTED]',
        durationMs: 3,
      },
    })
  })

  it('refuses to append to a hard-linked log file and keeps the log page readable', async () => {
    const store = createStore()
    const victim = path.join(store.directory, 'victim.txt')
    fs.writeFileSync(victim, 'do-not-change', 'utf8')
    fs.linkSync(victim, store.filePath)

    store.log('error', 'test', 'unsafe-log', 'must not be appended')
    const snapshot = await store.snapshot()
    expect(snapshot.entries.some((entry) => entry.level === 'warn' && entry.event === 'read-failed')).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain('do-not-change')
    expect(fs.readFileSync(victim, 'utf8')).toBe('do-not-change')
  })

  it('truncates an oversized detail instead of instantly rotating the file', async () => {
    const store = createStore()
    store.log('info', 'test', 'oversized', 'huge detail', Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`key${index}`, 'y'.repeat(8_000)]),
    ))

    const snapshot = await store.snapshot()
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0].detail).toEqual({ truncated: '[TRUNCATED: detail too large]' })
    expect(snapshot.sizeBytes).toBeLessThan(256 * 1024)
  })
})
