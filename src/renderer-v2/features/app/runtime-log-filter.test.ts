import { describe, expect, it } from 'vitest'
import {
  filterRuntimeLogs,
  formatRuntimeLogEntry,
  hasRuntimeLogFilter,
  isCurrentBootEntry,
  readEntryProcessId,
  runtimeLogSourceOptions,
  runtimeLogWriteNotice,
  type RuntimeLogEntry,
  type RuntimeLogFilter,
} from './runtime-log-filter'

const startedAt = '2026-09-22T06:00:00.000Z'

function entry(overrides: Partial<RuntimeLogEntry> & { id: string }): RuntimeLogEntry {
  return {
    timestamp: overrides.id.split(':').slice(0, -2).join(':'),
    level: 'info',
    source: 'main',
    event: 'test',
    message: '消息',
    detail: null,
    ...overrides,
  }
}

function filter(overrides: Partial<RuntimeLogFilter> = {}): RuntimeLogFilter {
  return {
    level: 'all',
    source: 'all',
    query: '',
    onlyCurrentBoot: false,
    currentProcessId: 4242,
    startedAt,
    ...overrides,
  }
}

const previousRun = entry({ id: '2026-09-22T05:00:00.000Z:1111:7', source: 'updater', level: 'warn', message: '上次运行' })
const thisRun = entry({ id: '2026-09-22T06:00:01.000Z:4242:1', source: 'main', level: 'error', message: '本次启动' })
const recycledPid = entry({ id: '2026-09-22T05:30:00.000Z:4242:9', source: 'cli', message: 'pid 被复用' })
const entries = [previousRun, thisRun, recycledPid]

describe('readEntryProcessId', () => {
  // id 的时间段本身带冒号，按下标取会把 ISO 时间的分钟数当成 pid。
  const cases: Array<[string, number | null]> = [
    ['2026-09-22T06:00:01.000Z:4242:1', 4242],
    ['2026-09-22T06:00:01.000Z:7:12345', 7],
    ['没有来源信息', null],
    ['2026-09-22T06:00:01.000Z:4242', null],
  ]
  for (const [id, expected] of cases) {
    it(`reads ${expected} out of ${id}`, () => {
      expect(readEntryProcessId(id)).toBe(expected)
    })
  }
})

describe('isCurrentBootEntry', () => {
  it('keeps an entry written by this process after this run started', () => {
    expect(isCurrentBootEntry(thisRun, { currentProcessId: 4242, startedAt })).toBe(true)
  })

  it('drops an entry from another process', () => {
    expect(isCurrentBootEntry(previousRun, { currentProcessId: 4242, startedAt })).toBe(false)
  })

  it('drops an older entry that happens to carry a recycled pid', () => {
    expect(isCurrentBootEntry(recycledPid, { currentProcessId: 4242, startedAt })).toBe(false)
  })

  it('falls back to the pid alone when the boot time is unreadable', () => {
    expect(isCurrentBootEntry(recycledPid, { currentProcessId: 4242, startedAt: '' })).toBe(true)
  })

  it('drops an entry whose own timestamp is unreadable', () => {
    const broken = entry({ id: '2026-09-22T06:00:01.000Z:4242:2', timestamp: '不是时间' })
    expect(isCurrentBootEntry(broken, { currentProcessId: 4242, startedAt })).toBe(false)
  })
})

describe('filterRuntimeLogs', () => {
  const cases: Array<[string, Partial<RuntimeLogFilter>, string[]]> = [
    ['returns everything by default', {}, ['上次运行', '本次启动', 'pid 被复用']],
    ['narrows to a level', { level: 'error' }, ['本次启动']],
    ['narrows to a source', { source: 'cli' }, ['pid 被复用']],
    ['narrows to this run', { onlyCurrentBoot: true }, ['本次启动']],
    ['matches the query against message, source and event', { query: 'updater' }, ['上次运行']],
    ['ignores surrounding whitespace in the query', { query: '  本次  ' }, ['本次启动']],
    ['combines source and this run', { source: 'main', onlyCurrentBoot: true }, ['本次启动']],
    ['combines level and source into an empty result', { level: 'error', source: 'cli' }, []],
    ['combines this run with a query that excludes it', { onlyCurrentBoot: true, query: '上次' }, []],
  ]
  for (const [name, overrides, expected] of cases) {
    it(name, () => {
      expect(filterRuntimeLogs(entries, filter(overrides)).map((item) => item.message)).toEqual(expected)
    })
  }
})

describe('hasRuntimeLogFilter', () => {
  const cases: Array<[string, Partial<RuntimeLogFilter>, boolean]> = [
    ['reports nothing filtered by default', {}, false],
    ['counts a level', { level: 'warn' }, true],
    ['counts a source', { source: 'cli' }, true],
    ['counts the current-boot switch', { onlyCurrentBoot: true }, true],
    ['counts a query', { query: 'x' }, true],
    ['ignores a whitespace-only query', { query: '   ' }, false],
  ]
  for (const [name, overrides, expected] of cases) {
    it(name, () => {
      expect(hasRuntimeLogFilter(filter(overrides))).toBe(expected)
    })
  }
})

describe('runtimeLogSourceOptions', () => {
  it('puts 全部来源 first and de-duplicates the snapshot list', () => {
    expect(runtimeLogSourceOptions(['cli', 'main', 'cli'], 'all')).toEqual([
      { value: 'all', label: '全部来源' },
      { value: 'cli', label: 'cli' },
      { value: 'main', label: 'main' },
    ])
  })

  it('keeps a selected source the snapshot no longer lists', () => {
    expect(runtimeLogSourceOptions(['main'], 'updater').map((option) => option.value))
      .toEqual(['all', 'main', 'updater'])
  })

  it('survives a snapshot that has not loaded yet', () => {
    expect(runtimeLogSourceOptions(undefined, 'all')).toEqual([{ value: 'all', label: '全部来源' }])
  })
})

describe('formatRuntimeLogEntry', () => {
  it('matches the one-line shape of the feedback report', () => {
    expect(formatRuntimeLogEntry(thisRun)).toBe('[2026-09-22T06:00:01.000Z] [ERROR] [main/test] 本次启动')
  })

  it('appends the detail as JSON when there is one', () => {
    const detailed = entry({ id: '2026-09-22T06:00:02.000Z:4242:3', detail: { code: 'ENOENT' } })
    expect(formatRuntimeLogEntry(detailed)).toBe('[2026-09-22T06:00:02.000Z] [INFO] [main/test] 消息 {"code":"ENOENT"}')
  })
})

describe('runtimeLogWriteNotice', () => {
  it('stays silent while every entry reached the log file', () => {
    expect(runtimeLogWriteNotice(undefined)).toBeNull()
    expect(runtimeLogWriteNotice({ reason: '磁盘满了', lostEntries: 0, firstFailedAt: '2026-09-22T00:00:00.000Z' })).toBeNull()
  })

  it('says how many entries were lost, why, and that they are still shown here', () => {
    const notice = runtimeLogWriteNotice({
      reason: '日志所在的文件夹被搬到了别的位置',
      lostEntries: 12,
      firstFailedAt: '2026-09-22T00:00:00.000Z',
    })
    expect(notice?.title).toBe('日志没能保存下来')
    expect(notice?.body).toContain('12 条')
    expect(notice?.body).toContain('日志所在的文件夹被搬到了别的位置')
    expect(notice?.body).toContain('导出反馈报告时也会带上')
    // 面向小白：不出现路径里的技术名词。
    expect(notice?.body).not.toMatch(/AppData|junction|联接|符号链接/)
  })
})
