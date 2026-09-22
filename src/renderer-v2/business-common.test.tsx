import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ResultNotice } from './business-common'

describe('renderer-v2 result notice', () => {
  it('leads with the catalog wording and keeps the backend sentence for support', () => {
    const raw = 'Grok CLI 安装失败：EBUSY: resource busy or locked'
    const markup = renderToStaticMarkup(<ResultNotice error={raw} />)
    // EBUSY 是文件被占用，不是杀毒拦截：这一句要把用户送去关工具窗口。
    expect(markup).toContain('工具正在运行')
    expect(markup).toContain('先关掉正在使用这个工具的窗口')
    expect(markup).toContain(raw)
  })

  it('leaves a failure the catalog cannot name exactly as the backend wrote it', () => {
    const raw = '请先准备 Node.js 运行环境，再安装命令行工具。'
    expect(renderToStaticMarkup(<ResultNotice error={raw} />)).toContain(raw)
  })

  it('offers to reveal an exported file only when the page can act on it', () => {
    const exported = renderToStaticMarkup(
      <ResultNotice
        message="诊断报告已导出：C:\\Users\\a\\report.txt"
        revealPath="C:\\Users\\a\\report.txt"
        onReveal={async () => true}
      />,
    )
    expect(exported).toContain('打开所在位置')
    expect(exported).toContain('data-testid="result-notice-reveal"')
    // Spread from useOperation on a page that never wired onReveal: no dead button.
    expect(renderToStaticMarkup(
      <ResultNotice message="已导出" revealPath="C:\\report.txt" />,
    )).not.toContain('打开所在位置')
    expect(renderToStaticMarkup(
      <ResultNotice error="导出失败" revealPath="C:\\report.txt" onReveal={async () => true} />,
    )).not.toContain('打开所在位置')
  })

  it('still renders success on its own', () => {
    const markup = renderToStaticMarkup(<ResultNotice message="工具已卸载" />)
    expect(markup).toContain('工具已卸载')
    expect(markup).toContain('已完成')
  })
})
