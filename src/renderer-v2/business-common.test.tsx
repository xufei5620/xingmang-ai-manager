import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ResultNotice } from './business-common'

describe('renderer-v2 result notice', () => {
  it('leads with the catalog wording and keeps the backend sentence for support', () => {
    const raw = 'Grok CLI 安装失败：EBUSY: resource busy or locked'
    const markup = renderToStaticMarkup(<ResultNotice error={raw} />)
    expect(markup).toContain('安装被杀毒软件拦住了')
    expect(markup).toContain('请检查隔离记录')
    expect(markup).toContain(raw)
  })

  it('leaves a failure the catalog cannot name exactly as the backend wrote it', () => {
    const raw = '请先准备 Node.js 运行环境，再安装命令行工具。'
    expect(renderToStaticMarkup(<ResultNotice error={raw} />)).toContain(raw)
  })

  it('still renders success on its own', () => {
    const markup = renderToStaticMarkup(<ResultNotice message="工具已卸载" />)
    expect(markup).toContain('工具已卸载')
    expect(markup).toContain('已完成')
  })
})
