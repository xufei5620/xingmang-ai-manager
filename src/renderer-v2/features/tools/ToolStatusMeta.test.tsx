import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ToolStatusMeta, ToolStatusReason, type ToolRowStatus } from './ToolStatusMeta'

const probeFailed: ToolRowStatus = { installed: false, detectionFailed: true, detectionError: 'npm 目录不可读' }
const probeFailedWithoutReason: ToolRowStatus = { installed: false, detectionFailed: true, detectionError: null }
const installed: ToolRowStatus = { installed: true, detectionFailed: false, detectionError: null }
const missing: ToolRowStatus = { installed: false, detectionFailed: false, detectionError: null }

function meta(status: ToolRowStatus | null | undefined, version: string | null = null, statusUnknown = false): string {
  return renderToStaticMarkup(<ToolStatusMeta status={status} version={version} statusUnknown={statusUnknown} testId="state" />)
}

function reason(status: ToolRowStatus | null | undefined, statusUnknown = false): string {
  return renderToStaticMarkup(<ToolStatusReason vendor="Anthropic" status={status} statusUnknown={statusUnknown} testId="reason" />)
}

describe('renderer-v2 maintenance tool status pill', () => {
  it('draws a failed probe as 检测失败 in the bad tone, never as 未安装', () => {
    const markup = meta(probeFailed)
    expect(markup).toContain('检测失败')
    expect(markup).not.toContain('未安装')
    expect(markup).toContain('xm-tone-bad')
  })

  it('says the version was not read rather than not found when nothing was probed', () => {
    expect(meta(probeFailed)).toContain('版本未读到')
    expect(meta(probeFailedWithoutReason)).toContain('版本未读到')
  })

  it('draws an installed tool as 已安装 and keeps the probed version', () => {
    const markup = meta(installed, '2.1.277')
    expect(markup).toContain('2.1.277')
    expect(markup).toContain('已安装')
    expect(markup).toContain('xm-tone-ok')
  })

  it('draws a tool that is genuinely absent as 未安装', () => {
    const markup = meta(missing)
    expect(markup).toContain('未安装')
    expect(markup).toContain('未找到版本')
    expect(markup).toContain('xm-tone-neutral')
  })

  it('draws an unread detection partition as 状态未读到', () => {
    const markup = meta(undefined, null, true)
    expect(markup).toContain('状态未读到')
    expect(markup).toContain('xm-tone-warn')
  })
})

describe('renderer-v2 maintenance tool status reason', () => {
  it('puts the probe failure reason next to the vendor', () => {
    const markup = reason(probeFailed)
    expect(markup).toContain('Anthropic')
    expect(markup).toContain('npm 目录不可读')
    expect(markup).toContain('data-testid="reason"')
  })

  it('falls back to a sentence of its own when the probe sent no reason', () => {
    expect(reason(probeFailedWithoutReason)).toContain('检测没有完成，装没装无法确认')
  })

  it('shows why the update comparison failed once the tool itself was probed', () => {
    const markup = reason({ ...installed, updateCheck: 'failed', updateError: '已安装 CLI 的版本号无法解析，不能判断是否有更新' })
    expect(markup).toContain('已安装 CLI 的版本号无法解析，不能判断是否有更新')
  })

  it('prefers the probe failure over the update failure it necessarily caused', () => {
    const markup = reason({ ...probeFailed, updateCheck: 'failed', updateError: 'npm latest 查询超时' })
    expect(markup).toContain('npm 目录不可读')
    expect(markup).not.toContain('npm latest 查询超时')
  })

  it('shows the vendor alone when this round concluded', () => {
    const markup = reason({ ...installed, updateCheck: 'checked', updateError: null })
    expect(markup).toContain('Anthropic')
    expect(markup).not.toContain('·')
  })
})
