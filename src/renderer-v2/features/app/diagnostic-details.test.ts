import { describe, expect, it } from 'vitest'
import { diagnosticDetailRows } from './diagnostic-details'
import { requestSettingsGroup, takeSettingsGroup } from './settings-group-intent'

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
})
