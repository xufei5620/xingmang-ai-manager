import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { redactHomeDirectory, RuntimeLogStore, summarizeRuntimeLogFile } from './runtime-log'
import { recordStartupFailure } from './startup-log'

const temporaryDirectories: string[] = []

function createStore(options: { maxFileBytes?: number; archiveCount?: number; environmentTimeoutMs?: number } = {}) {
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
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/** 记录接下来每一次以只读方式打开的日志文件，用来断言哪些文件被真的读了盘。 */
function trackLogFileReads(): string[] {
  const opened: string[] = []
  const open = fs.promises.open
  vi.spyOn(fs.promises, 'open').mockImplementation((file, flags, mode) => {
    if (flags === 'r') opened.push(path.basename(String(file)))
    return open(file, flags as never, mode as never)
  })
  return opened
}

async function fillRotatedLog(store: RuntimeLogStore, entries: number): Promise<void> {
  for (let index = 0; index < entries; index += 1) {
    store.log('info', `source-${index % 3}`, 'rotation', `entry-${index}-${'x'.repeat(70)}`)
  }
  await store.snapshot()
}

function writeArchive(store: RuntimeLogStore, index: number, message: string): void {
  fs.writeFileSync(`${store.filePath}.${index}`, `${JSON.stringify({
    id: `archive-${index}`, timestamp: '2026-09-21T00:00:00.000Z', level: 'info',
    source: `archive-${index}`, event: 'rotated', message, detail: null,
  })}\n`, 'utf8')
}

describe('summarizeRuntimeLogFile', () => {
  it('counts every line but only sanitizes the ones a snapshot can show', () => {
    const line = (index: number) => JSON.stringify({
      id: `id-${index}`, timestamp: '2026-09-22T00:00:00.000Z',
      level: index % 2 === 0 ? 'info' : 'warn',
      source: index % 2 === 0 ? 'main' : 'ipc', event: 'entry',
      message: `第 ${index} 条`, detail: { apiKey: 'private-key' },
    })
    const summary = summarizeRuntimeLogFile([
      line(1), 'not json at all', JSON.stringify({ level: 'info' }), line(2), '', line(3),
    ].join('\n'))

    expect(summary.total).toBe(3)
    expect(summary.counts).toEqual({ debug: 0, info: 1, warn: 2, error: 0 })
    expect([...summary.sources].sort()).toEqual(['ipc', 'main'])
    expect(summary.entries.map((entry) => entry.message)).toEqual(['第 1 条', '第 2 条', '第 3 条'])
    expect(summary.entries[0].detail).toEqual({ apiKey: '[REDACTED]' })
  })

  it('redacts a field named exactly key but not names that merely contain it', () => {
    const line = JSON.stringify({
      id: 'id-1', timestamp: '2026-09-22T00:00:00.000Z', level: 'info', source: 'main',
      event: 'entry', message: 'mcp env', detail: { key: 'plain-fake-value', keyboard: 'us', cacheKey: 'abc' },
    })

    expect(summarizeRuntimeLogFile(line).entries[0].detail)
      .toEqual({ key: '[REDACTED]', keyboard: 'us', cacheKey: 'abc' })
  })

  it('keeps only the tail a snapshot could ever return, without losing the counts', () => {
    const content = Array.from({ length: 4_100 }, (_, index) => JSON.stringify({
      id: `id-${index}`, timestamp: '2026-09-22T00:00:00.000Z', level: 'info',
      source: 'main', event: 'entry', message: `第 ${index} 条`, detail: null,
    })).join('\n')
    const summary = summarizeRuntimeLogFile(content)

    expect(summary.total).toBe(4_100)
    expect(summary.counts.info).toBe(4_100)
    // snapshot 最多回 2000 条，更早的留着也没人看。
    expect(summary.entries).toHaveLength(2_000)
    expect(summary.entries[0].message).toBe('第 2100 条')
    expect(summary.entries[1_999].message).toBe('第 4099 条')
  })
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

  it('stamps the snapshot with this run so the feedback page can isolate it', async () => {
    const store = createStore()
    store.log('info', 'main', 'boot', '本次启动')
    const snapshot = await store.snapshot()

    expect(snapshot.currentProcessId).toBe(process.pid)
    expect(Date.parse(snapshot.startedAt)).not.toBeNaN()
    // The page pairs the pid carried in each entry id with this stamp; an entry
    // written by this run has to satisfy both halves of that comparison.
    const written = snapshot.entries.find((entry) => entry.message === '本次启动')
    expect(written?.id.endsWith(`:${process.pid}:1`)).toBe(true)
    expect(Date.parse(written?.timestamp ?? '')).toBeGreaterThanOrEqual(Date.parse(snapshot.startedAt))
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

  it('puts the tool and configuration summary ahead of the log lines', async () => {
    const store = createStore()
    store.attachEnvironmentDescriber(async () => [
      'Claude Code: 已安装 2.1.277（应用托管）；配置：指向当前账号',
      'Codex CLI: 未安装；配置：未配置',
    ])
    store.log('info', 'fixture', 'entry', 'one log line')
    const report = await store.captureFeedbackReport()

    expect(report.text).toContain('工具与配置:')
    expect(report.text).toContain('Claude Code: 已安装 2.1.277（应用托管）；配置：指向当前账号')
    expect(report.text.indexOf('工具与配置:')).toBeLessThan(report.text.indexOf('运行日志:'))
  })

  it('redacts the home directory inside the tool summary too', async () => {
    const store = createStore()
    store.attachEnvironmentDescriber(async () => [`Grok CLI: 已安装，配置目录 ${os.homedir()}`])
    const report = await store.captureFeedbackReport()

    expect(report.text).not.toContain(os.homedir())
  })

  it('still produces a report when the environment read times out or throws', async () => {
    const stalled = createStore({ environmentTimeoutMs: 20 })
    stalled.attachEnvironmentDescriber(() => new Promise(() => undefined))
    const timedOut = await stalled.captureFeedbackReport()

    expect(timedOut.text).toContain('未能读取（读取超时）')
    expect(timedOut.text).toContain('运行日志:')

    const broken = createStore()
    broken.attachEnvironmentDescriber(async () => { throw new Error('系统服务还没起来') })
    const failed = await broken.captureFeedbackReport()

    expect(failed.text).toContain('工具与配置:')
    expect(failed.text).toContain('未能读取')
    expect(failed.text).not.toContain('系统服务还没起来')
  })

  it('omits the tool summary entirely when nothing is attached', async () => {
    const report = await createStore().captureFeedbackReport()

    expect(report.text).not.toContain('工具与配置:')
  })

  it('puts the self-check summary between the tool summary and the log lines', async () => {
    const store = createStore()
    store.attachEnvironmentDescriber(async () => ['Claude Code: 已安装 2.1.277（应用托管）；配置：指向当前账号'])
    store.attachSelfCheckDescriber(async () => [
      '检查时间: 2026-09-22T11:31:02.000Z',
      '磁盘空间: 正常，软件数据盘剩余空间充足',
    ])
    store.log('info', 'fixture', 'entry', 'one log line')
    const report = await store.captureFeedbackReport()

    expect(report.text).toContain('最近一次自检:')
    expect(report.text).toContain('磁盘空间: 正常，软件数据盘剩余空间充足')
    expect(report.text.indexOf('工具与配置:')).toBeLessThan(report.text.indexOf('最近一次自检:'))
    expect(report.text.indexOf('最近一次自检:')).toBeLessThan(report.text.indexOf('运行日志:'))
  })

  it('keeps the two summaries independent when one of them times out', async () => {
    const store = createStore({ environmentTimeoutMs: 20 })
    store.attachEnvironmentDescriber(() => new Promise(() => undefined))
    store.attachSelfCheckDescriber(async () => ['还没做过自检'])
    const report = await store.captureFeedbackReport()

    expect(report.text).toContain('未能读取（读取超时）')
    expect(report.text).toContain('还没做过自检')
  })

  it('redacts the home directory inside the self-check summary too', async () => {
    const store = createStore()
    store.attachSelfCheckDescriber(async () => [`磁盘空间: 正常，${os.homedir()} 所在盘剩余充足`])
    const report = await store.captureFeedbackReport()

    expect(report.text).toContain('最近一次自检:')
    expect(report.text).not.toContain(os.homedir())
  })

  it('leaves debug entries out of the feedback report but keeps them on disk', async () => {
    const store = createStore()
    store.log('info', 'account', 'login', 'login succeeded')
    for (let index = 0; index < 5; index += 1) store.log('debug', 'ipc', 'acceleration:get-state', `poll ${index}`)
    store.log('warn', 'config', 'write', 'config write retried')
    const report = await store.captureFeedbackReport(10)

    expect(report.text).toContain('login succeeded')
    expect(report.text).toContain('config write retried')
    expect(report.text).not.toContain('poll 0')
    expect(report.text).toContain('日志条数: 7（附最近 2 条，调试级 5 条未附）')
    expect(report.entries).toBe(7)
    const snapshot = await store.snapshot()
    expect(snapshot.entries.filter((entry) => entry.level === 'debug')).toHaveLength(5)
  })

  it('keeps the most recent non-debug entries even when debug noise came after them', async () => {
    const store = createStore()
    store.log('info', 'account', 'login', 'important early entry')
    for (let index = 0; index < 20; index += 1) store.log('debug', 'ipc', 'acceleration:get-state', `poll ${index}`)
    const report = await store.captureFeedbackReport(3)

    expect(report.text).toContain('important early entry')
  })

  it('puts the runtime environment before tools and self-check, with home paths redacted', async () => {
    const store = createStore()
    store.attachHostDescriber(async () => [`系统 Node.js: 已安装 v22.12.0，位置 ${path.join(os.homedir(), 'node', 'node.exe')}`])
    store.attachEnvironmentDescriber(async () => ['Claude Code: 已安装 2.1.277（应用托管）；配置：指向当前账号'])
    store.attachSelfCheckDescriber(async () => ['还没做过自检'])
    const report = await store.captureFeedbackReport()

    expect(report.text).toContain('运行环境:')
    expect(report.text).not.toContain(os.homedir())
    expect(report.text.indexOf('运行环境:')).toBeLessThan(report.text.indexOf('工具与配置:'))
    expect(report.text.indexOf('工具与配置:')).toBeLessThan(report.text.indexOf('最近一次自检:'))
  })

  it('labels the bundled Node so it is not mistaken for the system one', async () => {
    const report = await createStore().captureFeedbackReport()

    expect(report.text).toContain(`软件内置 Node: ${process.versions.node}`)
    expect(report.text).not.toMatch(/^Node\.js:/m)
    expect(report.text).not.toContain('运行环境:')
  })

  it('omits the self-check summary entirely when nothing is attached', async () => {
    const report = await createStore().captureFeedbackReport()

    expect(report.text).not.toContain('最近一次自检:')
  })

  it('drops the oldest log lines to fit the size budget and says how many it kept', async () => {
    const store = createStore()
    for (let index = 0; index < 40; index += 1) store.log('info', 'fixture', 'entry', `entry-${String(index).padStart(2, '0')} ${'x'.repeat(200)}`)
    const full = await store.captureFeedbackReport()
    const budget = full.text.length - 2_000
    const report = await store.captureFeedbackReport(600, budget)

    expect(report.text.length).toBeLessThanOrEqual(budget)
    expect(report.entries).toBe(40)
    const kept = Number(/只保留最近 (\d+) 条/.exec(report.text)?.[1])
    expect(kept).toBeGreaterThan(0)
    expect(kept).toBeLessThan(40)
    expect(report.text).toContain(`日志条数: 40（附最近 ${kept} 条）`)
    // The newest lines survive, the oldest go, and the survivors stay oldest-first.
    expect(report.text).toContain('entry-39')
    expect(report.text).not.toContain('entry-00')
    const survivors = [...report.text.matchAll(/entry-(\d{2})/g)].map((match) => Number(match[1]))
    expect(survivors).toHaveLength(kept)
    expect(survivors).toEqual([...survivors].sort((a, b) => a - b))
    expect(survivors.at(-1)).toBe(39)
  })

  it('leaves a report that already fits untouched', async () => {
    const store = createStore()
    store.log('info', 'fixture', 'entry', 'small entry')
    const unbounded = await store.captureFeedbackReport()
    const bounded = await store.captureFeedbackReport(600, unbounded.text.length)
    expect(bounded.text.replace(/生成时间: .*/, '')).toBe(unbounded.text.replace(/生成时间: .*/, ''))
    expect(bounded.text).not.toContain('日志已截断')
  })

  it('fails only when the part without logs is already over budget, and says what to do instead', async () => {
    const store = createStore()
    store.log('info', 'fixture', 'entry', 'small entry')
    await expect(store.captureFeedbackReport(600, 50)).rejects.toThrow('打开日志目录')
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
    const error = Object.assign(new Error('无法启动命令：npm'), {
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

  it('parses each rotated archive once and only re-reads the file that grew', async () => {
    // 文件上限放大，免得这条用例里的追加又触发一次轮转。
    const store = createStore({ maxFileBytes: 64 * 1024, archiveCount: 2 })
    writeArchive(store, 1, '较新的归档')
    writeArchive(store, 2, '最早的归档')
    store.log('info', 'test', 'active', '当前文件的一条')
    const first = await store.snapshot()
    expect(first.total).toBe(3)

    const opened = trackLogFileReads()
    await store.snapshot()
    // 三个文件都没变，全部命中缓存。
    expect(opened).toEqual([])

    store.log('info', 'test', 'appended', '新的一条')
    const grown = await store.snapshot()
    // 只有正在追加的那个文件变了，归档仍然不读。
    expect(opened).toEqual(['runtime.jsonl'])
    expect(grown.total).toBe(4)
    expect(grown.entries[0].message).toBe('新的一条')
  })

  it('re-reads an archive once its size and mtime change', async () => {
    const store = createStore({ maxFileBytes: 520, archiveCount: 2 })
    await fillRotatedLog(store, 12)

    const archive = `${store.filePath}.1`
    fs.writeFileSync(archive, `${JSON.stringify({
      id: 'replaced-archive', timestamp: '2026-09-22T00:00:00.000Z', level: 'error',
      source: 'replaced', event: 'swapped', message: '换过的归档', detail: null,
    })}\n`, 'utf8')

    const opened = trackLogFileReads()
    const snapshot = await store.snapshot()

    expect(opened).toContain('runtime.jsonl.1')
    expect(snapshot.entries.some((entry) => entry.message === '换过的归档')).toBe(true)
    expect(snapshot.sources).toContain('replaced')
  })

  it('returns exactly what an unwarmed store would return', async () => {
    const store = createStore({ maxFileBytes: 520, archiveCount: 2 })
    await fillRotatedLog(store, 24)
    const warmed = await store.snapshot()

    const cold = new RuntimeLogStore({
      directory: store.directory,
      appName: '星芒AI管理工具',
      appVersion: '1.0.0',
      packaged: false,
      maxFileBytes: 520,
      archiveCount: 2,
    })
    const fresh = await cold.snapshot()

    expect(warmed.entries).toEqual(fresh.entries)
    expect(warmed.total).toBe(fresh.total)
    expect(warmed.counts).toEqual(fresh.counts)
    expect(warmed.sources).toEqual(fresh.sources)
    expect(warmed.sizeBytes).toBe(fresh.sizeBytes)
    expect(warmed.truncated).toBe(fresh.truncated)
  })

  it('drops the cache when the log is cleared so a rebuilt file is read again', async () => {
    const store = createStore({ maxFileBytes: 520, archiveCount: 2 })
    await fillRotatedLog(store, 12)
    await store.clear()
    expect((await store.snapshot()).total).toBe(0)

    store.log('info', 'after-clear', 'entry', '清空之后的一条')
    const snapshot = await store.snapshot()

    expect(snapshot.total).toBe(1)
    expect(snapshot.entries[0].message).toBe('清空之后的一条')
    expect(snapshot.counts.info).toBe(1)
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
