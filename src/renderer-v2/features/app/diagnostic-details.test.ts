import { describe, expect, it } from 'vitest'
import { diagnosticDetailRows } from './diagnostic-details'
import { hasPendingSettingsGroup, requestSettingsGroup, takeSettingsGroup } from './settings-group-intent'

describe('diagnostic detail rows', () => {
  it('translates field names and yes/no values instead of showing raw keys', () => {
    expect(diagnosticDetailRows({ elevated: false, required: false, canElevate: true })).toEqual([
      { key: 'elevated', label: '以管理员身份运行', value: '否' },
      { key: 'canElevate', label: '这个账号能临时获得管理员权限', value: '是' },
    ])
    expect(diagnosticDetailRows({ relocated: 1, folder1: '用户文件夹', to1: 'D 盘' })).toEqual([
      { key: 'relocated', label: '被搬走的文件夹数', value: '1' },
      { key: 'folder1', label: '文件夹 1', value: '用户文件夹' },
      { key: 'to1', label: '现在的位置 1', value: 'D 盘' },
    ])
  })

  it('keeps site addresses, status codes and internal codes off the screen', () => {
    const rows = diagnosticDetailRows({
      endpoint: 'https://xm.solov.cc/api/status',
      baseUrl: 'https://xm.solov.cc',
      status: 200,
      reason: 'intercepted',
      executionMode: 'trusted-only',
      probeFailure: 'timeout',
      timedOut: true,
      model: 'see https://xm.solov.cc/v1',
      somethingNew: 'raw',
    })
    expect(rows).toEqual([])
  })

  // 「电脑里另外设过的工具地址或密钥」正常时，那几个英文名只进导出报告（yoyo 11-06「体检改」）；
  // 代理那一行按变量名记的端口同样不上屏。
  it('keeps the environment variable names off the screen when there is nothing to do about them', () => {
    expect(diagnosticDetailRows({ reportOnlyVariables: 'OPENAI_API_KEY（Codex CLI）' })).toEqual([])
    expect(diagnosticDetailRows({ HTTP_PROXY: '本机 7890 端口（开着）', HTTPS_PROXY: '本机 7890 端口（开着）' })).toEqual([])
  })

  // D78 定的是不提示客户：配置不是 UTF-8 的那个标记只进导出报告，旁边那行位置照常显示。
  it('keeps the not-UTF-8 config marker off the screen', () => {
    expect(diagnosticDetailRows({ file1: '~/.claude/settings.json', file1NotUtf8: true })).toEqual([
      { key: 'file1', label: '文件 1', value: '~/.claude/settings.json' },
    ])
  })

  it('shows a readable reason but drops unknown answers', () => {
    expect(diagnosticDetailRows({ reason: '单项检查超过 8000ms', canElevate: null })).toEqual([
      { key: 'reason', label: '原因', value: '单项检查超过 8000ms' },
    ])
    expect(diagnosticDetailRows(undefined)).toEqual([])
  })
})

describe('settings group intent', () => {
  it('hands the requested group over once', () => {
    expect(takeSettingsGroup()).toBeNull()
    requestSettingsGroup('network')
    expect(takeSettingsGroup()).toBe('network')
    expect(takeSettingsGroup()).toBeNull()
  })

  it('reports a pending group without consuming it', () => {
    expect(hasPendingSettingsGroup()).toBe(false)
    requestSettingsGroup('privacy')
    expect(hasPendingSettingsGroup()).toBe(true)
    expect(hasPendingSettingsGroup()).toBe(true)
    expect(takeSettingsGroup()).toBe('privacy')
    expect(hasPendingSettingsGroup()).toBe(false)
  })
})
