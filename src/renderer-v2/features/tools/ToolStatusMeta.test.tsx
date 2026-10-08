import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ToolStatusMeta, toolStatusView, type ToolRowActivity, type ToolRowStatus } from './ToolStatusMeta'

const probeFailed: ToolRowStatus = { installed: false, detectionFailed: true, detectionError: 'npm 目录不可读' }
const probeFailedWithoutReason: ToolRowStatus = { installed: false, detectionFailed: true, detectionError: null }
const installed: ToolRowStatus = { installed: true, detectionFailed: false, detectionError: null }
const missing: ToolRowStatus = { installed: false, detectionFailed: false, detectionError: null }

/** 「版本与状态」那一格：工具行和运行环境行共用。 */
function meta(
  status: ToolRowStatus | null | undefined,
  version: string | null = null,
  statusUnknown = false,
  activity?: ToolRowActivity,
): string {
  return renderToStaticMarkup(
    <ToolStatusMeta view={toolStatusView(status, statusUnknown, version, activity)} testId="state" reasonTestId="reason" />,
  )
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

  it('names the install source so a native or other-source install reads honestly', () => {
    expect(meta({ ...installed, installSource: 'native' }, '2.1.277')).toContain('已安装（官方安装器）')
    expect(meta({ ...installed, installSource: 'path' }, '2.1.277')).toContain('已安装（其他来源）')
    // npm 装的与来源未知的仍是朴素的「已安装」。
    expect(meta({ ...installed, installSource: 'npm' }, '2.1.277')).toContain('>已安装<')
    expect(meta(installed, '2.1.277')).toContain('>已安装<')
  })

  it('draws a tool that is genuinely absent as a dash and 未安装, not as 未找到版本', () => {
    const markup = meta(missing)
    expect(markup).toContain('—')
    expect(markup).toContain('未安装')
    expect(markup).not.toContain('未找到版本')
    expect(markup).toContain('xm-tone-neutral')
  })

  it('keeps 未找到版本 for an installed tool whose version was not read', () => {
    expect(meta(installed)).toContain('未找到版本')
  })

  it('writes an unread detection partition once as 暂未读到 and puts no pill on it', () => {
    const markup = meta(undefined, null, true)
    expect(markup).toContain('暂未读到')
    expect(markup).not.toContain('xm-pill')
    expect(markup).not.toContain('状态未读到')
    expect(markup).toContain('data-testid="state"')
  })

  it('draws a row that is installing as 安装中, whatever the last scan said', () => {
    const markup = meta(missing, null, false, 'installing')
    expect(markup).toContain('安装中')
    expect(markup).toContain('xm-tone-accent')
    expect(markup).not.toContain('未安装')
    // 重新安装时版本号还是装着的那一版。
    expect(meta(installed, '2.1.277', false, 'installing')).toContain('2.1.277')
  })

  it('draws a row whose install did not finish as a red 安装失败', () => {
    const markup = meta(missing, null, false, 'failed')
    expect(markup).toContain('安装失败')
    expect(markup).toContain('xm-tone-bad')
    expect(markup).not.toContain('未安装')
  })
})

describe('renderer-v2 maintenance tool status reason', () => {
  it('puts the probe failure reason on its own line after the pill', () => {
    const markup = meta(probeFailed)
    expect(markup).toContain('npm 目录不可读')
    expect(markup).toContain('data-testid="reason"')
    expect(markup.indexOf('检测失败')).toBeLessThan(markup.indexOf('npm 目录不可读'))
  })

  it('falls back to a sentence of its own when the probe sent no reason', () => {
    expect(meta(probeFailedWithoutReason)).toContain('检测没有完成，装没装无法确认')
  })

  it('shows why the update comparison failed once the tool itself was probed', () => {
    const markup = meta({ ...installed, updateCheck: 'failed', updateError: '已安装 CLI 的版本号无法解析，不能判断是否有更新' })
    expect(markup).toContain('已安装 CLI 的版本号无法解析，不能判断是否有更新')
  })

  it('prefers the probe failure over the update failure it necessarily caused', () => {
    const markup = meta({ ...probeFailed, updateCheck: 'failed', updateError: 'npm latest 查询超时' })
    expect(markup).toContain('npm 目录不可读')
    expect(markup).not.toContain('npm latest 查询超时')
  })

  it('adds no reason line when this round concluded', () => {
    const markup = meta({ ...installed, updateCheck: 'checked', updateError: null })
    expect(markup).not.toContain('data-testid="reason"')
  })
})

// 运行环境那两行此前把版本号缺失一律写成「尚未安装」,探针自己抛错时也照写,
// 与工具行修掉的是同一类误导(A4)。
describe('renderer-v2 maintenance runtime rows', () => {
  it('never writes a failed probe as 尚未安装 and says why instead', () => {
    const markup = meta({ installed: false, detectionFailed: true, detectionError: 'where.exe 没有返回' })
    expect(markup).toContain('检测失败')
    expect(markup).toContain('where.exe 没有返回')
    expect(markup).not.toContain('尚未安装')
    expect(markup).not.toContain('未安装')
  })

  it('still refuses 尚未安装 when the failed probe sent no reason', () => {
    const markup = meta({ installed: false, detectionFailed: true, detectionError: null })
    expect(markup).toContain('检测失败')
    expect(markup).toContain('检测没有完成，装没装无法确认')
    expect(markup).not.toContain('尚未安装')
  })

  it('keeps the probed version when the runtime is there', () => {
    const markup = meta({ installed: true, detectionFailed: false, detectionError: null }, 'v24.0.0')
    expect(markup).toContain('v24.0.0')
    expect(markup).toContain('已安装')
    expect(markup).not.toContain('data-testid="reason"')
  })

  it('still says 未安装 when the probe concluded the runtime is absent', () => {
    const markup = meta({ installed: false, detectionFailed: false, detectionError: null })
    expect(markup).toContain('未安装')
    expect(markup).toContain('—')
    expect(markup).not.toContain('检测失败')
  })

  it('reports an unread system partition as 暂未读到 rather than as a conclusion', () => {
    const markup = meta(undefined, null, true)
    expect(markup).toContain('暂未读到')
    expect(markup).not.toContain('尚未安装')
  })
})
