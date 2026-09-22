import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RuntimeRestartDialog } from './RuntimeRestartDialog'

describe('renderer-v2 runtime restart dialog', () => {
  it('offers a single restart button and says closing means restarting later', () => {
    const markup = renderToStaticMarkup(<RuntimeRestartDialog onClose={() => undefined} restart={async () => undefined} />)
    expect(markup).toContain('runtime-restart-dialog')
    expect(markup).toContain('重启电脑后就能用')
    expect(markup).toContain('runtime-restart-now')
    expect(markup).toContain('15 秒')
    expect(markup).toContain('关掉这个框')
    // 只有一颗按钮：不让小白在「稍后 / 现在」之间做选择。
    expect(markup).not.toContain('稍后重启')
  })
})
