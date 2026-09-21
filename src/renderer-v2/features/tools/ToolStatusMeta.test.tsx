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
  return renderToStaticMarkup(<ToolStatusReason lead="Anthropic" status={status} statusUnknown={statusUnknown} testId="reason" />)
}

/** 「运行环境」那两行：同样的两个插槽，副标题的前半句换成这个运行环境派什么用场。 */
function runtimeRow(status: ToolRowStatus | null | undefined, version: string | null = null, statusUnknown = false): string {
  return renderToStaticMarkup(<>
    <ToolStatusReason lead="命令行工具需要的运行环境" status={status} statusUnknown={statusUnknown} testId="runtime-reason" />
    <ToolStatusMeta version={version} status={status} statusUnknown={statusUnknown} testId="runtime-state" />
  </>)
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

// 运行环境那两行此前把版本号缺失一律写成「尚未安装」,探针自己抛错时也照写,
// 与工具行修掉的是同一类误导(A4)。
describe('renderer-v2 maintenance runtime rows', () => {
  it('never writes a failed probe as 尚未安装 and says why instead', () => {
    const markup = runtimeRow({ installed: false, detectionFailed: true, detectionError: 'where.exe 没有返回' })
    expect(markup).toContain('检测失败')
    expect(markup).toContain('where.exe 没有返回')
    expect(markup).not.toContain('尚未安装')
    expect(markup).not.toContain('未安装')
  })

  it('still refuses 尚未安装 when the failed probe sent no reason', () => {
    const markup = runtimeRow({ installed: false, detectionFailed: true, detectionError: null })
    expect(markup).toContain('检测失败')
    expect(markup).toContain('检测没有完成，装没装无法确认')
    expect(markup).not.toContain('尚未安装')
  })

  it('keeps the probed version and the row description when the runtime is there', () => {
    const markup = runtimeRow({ installed: true, detectionFailed: false, detectionError: null }, 'v24.0.0')
    expect(markup).toContain('命令行工具需要的运行环境')
    expect(markup).toContain('v24.0.0')
    expect(markup).toContain('已安装')
    expect(markup).not.toContain('data-testid="runtime-reason"')
  })

  it('still says 未安装 when the probe concluded the runtime is absent', () => {
    const markup = runtimeRow({ installed: false, detectionFailed: false, detectionError: null })
    expect(markup).toContain('未安装')
    expect(markup).toContain('未找到版本')
    expect(markup).not.toContain('检测失败')
  })

  it('reports an unread system partition as 状态未读到 rather than as a conclusion', () => {
    const markup = runtimeRow(undefined, null, true)
    expect(markup).toContain('状态未读到')
    expect(markup).not.toContain('尚未安装')
  })
})
