import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { RestartReminder, RuntimeRestartDialog } from './RuntimeRestartDialog'
import { markRestartPending, readRestartPending, resetRestartPending } from './restart-reminder'

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

describe('renderer-v2 restart reminder', () => {
  afterEach(() => resetRestartPending())
  it('stays hidden until a runtime install has asked for a restart', () => {
    expect(renderToStaticMarkup(<RestartReminder restart={async () => undefined} />)).toBe('')
  })
  it('keeps a restart-now reminder on screen after the dialog is closed', () => {
    markRestartPending()
    expect(readRestartPending()).toBe(true)
    const markup = renderToStaticMarkup(<RestartReminder restart={async () => undefined} />)
    expect(markup).toContain('还差重启一次电脑')
    expect(markup).toContain('restart-reminder-now')
    expect(markup).not.toContain('runtime-restart-dialog')
  })
})
