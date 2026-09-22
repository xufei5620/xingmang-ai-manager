import { describe, expect, it } from 'vitest'
import type { DiagnosticItem, DiagnosticsReport } from './diagnostics'
import {
  buildFeedbackSelfCheckLines,
  type FeedbackConnectionRecord,
} from './feedback-self-check'

const now = new Date('2026-09-22T12:00:00.000Z')

function item(overrides: Partial<DiagnosticItem> = {}): DiagnosticItem {
  return {
    code: 'DISK_SPACE',
    title: '磁盘空间',
    state: 'pass',
    summary: '软件数据盘剩余空间充足',
    durationMs: 3,
    ...overrides,
  }
}

function report(items: DiagnosticItem[], generatedAt = '2026-09-22T11:31:02.000Z'): DiagnosticsReport {
  return {
    version: 1,
    generatedAt,
    durationMs: 120,
    counts: { pass: 0, warn: 0, fail: 0, error: 0 },
    items,
  }
}

function connection(overrides: Partial<FeedbackConnectionRecord> = {}): FeedbackConnectionRecord {
  return {
    ok: true,
    layer: 'unknown',
    summary: '连接正常',
    checkedAt: '2026-09-22T11:35:00.000Z',
    ...overrides,
  }
}

describe('buildFeedbackSelfCheckLines', () => {
  it('says so in one line when nothing has been checked yet', () => {
    const lines = buildFeedbackSelfCheckLines({
      report: null,
      readConnection: () => null,
      now,
    })

    expect(lines).toEqual(['还没做过自检，可以在软件里打开「检查」页点一次「开始检查」，再导出一份报告。'])
  })

  it('writes the check time and one line per diagnostic item', () => {
    const lines = buildFeedbackSelfCheckLines({
      report: report([
        item(),
        item({ code: 'PROVIDER_ENVIRONMENT_OVERRIDE', title: '环境变量覆盖', state: 'warn', summary: '系统环境变量里设置了 ANTHROPIC_BASE_URL，可能会盖过当前账号写入的配置' }),
        item({ code: 'XINGMANG_NETWORK', title: '网络', state: 'fail', summary: '当前网络连不上服务' }),
        item({ code: 'RUNTIME_GIT', title: 'Git 环境', state: 'error', summary: '检查时发生错误' }),
      ]),
      readConnection: () => null,
      now,
    })

    expect(lines).toEqual([
      '检查时间: 2026-09-22T11:31:02.000Z',
      '磁盘空间: 正常，软件数据盘剩余空间充足',
      '环境变量覆盖: 需留意，系统环境变量里设置了 ANTHROPIC_BASE_URL，可能会盖过当前账号写入的配置',
      '网络: 待处理，当前网络连不上服务',
      'Git 环境: 待处理，检查时发生错误',
    ])
  })

  it('marks a result older than a day as stale', () => {
    const lines = buildFeedbackSelfCheckLines({
      report: report([item()], '2026-09-20T11:31:02.000Z'),
      readConnection: () => null,
      now,
    })

    expect(lines[0]).toBe('检查时间: 2026-09-20T11:31:02.000Z（较早）')
  })

  it('leaves an unparseable timestamp unmarked instead of guessing', () => {
    const lines = buildFeedbackSelfCheckLines({
      report: report([item()], 'not-a-timestamp'),
      readConnection: () => null,
      now,
    })

    expect(lines[0]).toBe('检查时间: not-a-timestamp')
  })

  it('lists every managed CLI once any connection check has run, naming the failing layer', () => {
    const records: Record<string, FeedbackConnectionRecord | null> = {
      claude: connection(),
      codex: connection({ ok: false, layer: 'credential', summary: '当前账号的密钥被拒绝' }),
      gemini: connection({ ok: false, layer: 'unconfigured', summary: '这个工具还没配置' }),
      grok: null,
    }
    const lines = buildFeedbackSelfCheckLines({
      report: null,
      readConnection: (provider) => records[provider] ?? null,
      now,
    })

    expect(lines).toEqual([
      '检查时间: 还没在「检查」页做过检查',
      'Claude Code 连接自检: 正常，连接正常（2026-09-22T11:35:00.000Z）',
      'Codex CLI 连接自检: 密钥有问题，当前账号的密钥被拒绝（2026-09-22T11:35:00.000Z）',
      'Grok CLI 连接自检: 未自检',
      // 「还没配」不是故障，跟结果页一样不按失败说。
      'Gemini CLI 连接自检: 未配置，这个工具还没配置（2026-09-22T11:35:00.000Z）',
    ])
  })

  it('keeps the section short when no connection check has run at all', () => {
    const lines = buildFeedbackSelfCheckLines({
      report: report([item()]),
      readConnection: () => null,
      now,
    })

    expect(lines.join('\n')).not.toContain('未自检')
  })

  it('runs every summary through the injected redaction', () => {
    const lines = buildFeedbackSelfCheckLines({
      report: report([item({ summary: '读到 sk-live-abcdef123456' })]),
      readConnection: (provider) => (provider === 'claude'
        ? connection({ ok: false, layer: 'credential', summary: '上游回了 sk-live-abcdef123456' })
        : null),
      now,
      redact: (value) => value.split('sk-live-abcdef123456').join('[REDACTED]'),
    })
    const text = lines.join('\n')

    expect(text).not.toContain('sk-live-abcdef123456')
    expect(text).toContain('磁盘空间: 正常，读到 [REDACTED]')
    expect(text).toContain('Claude Code 连接自检: 密钥有问题，上游回了 [REDACTED]')
  })

  it('drops one unreadable connection record instead of failing the section', () => {
    const lines = buildFeedbackSelfCheckLines({
      report: report([item()]),
      readConnection: (provider) => {
        if (provider === 'codex') throw new Error('结果表读不出来')
        return provider === 'claude' ? connection() : null
      },
      now,
    })

    expect(lines.join('\n')).toContain('Codex CLI 连接自检: 未自检')
    expect(lines.join('\n')).toContain('Claude Code 连接自检: 正常')
  })
})
