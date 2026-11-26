import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { RestartReminder, RuntimeRestartDialog } from './RuntimeRestartDialog'
import { markRestartPending, readRestartPending, resetRestartPending } from './restart-reminder'

describe('renderer-v2 runtime restart dialog', () => {
  it('offers a single restart button and says closing means restarting later', () => {
    const markup = renderToStaticMarkup(<RuntimeRestartDialog onClose={() => undefined} restart={async () => ({})} />)
    expect(markup).toContain('runtime-restart-dialog')
    expect(markup).toContain('重启电脑后生效')
    expect(markup).toContain('runtime-restart-now')
    expect(markup).toContain('15 秒')
    expect(markup).toContain('可关闭此窗口')
    // 只有一颗按钮：不让小白在「稍后 / 现在」之间做选择。
    expect(markup).not.toContain('稍后重启')
  })

  it('tells a Codex Desktop customer to come back and open Codex again, without the Node.js wording', () => {
    const markup = renderToStaticMarkup(<RuntimeRestartDialog reason="codexDesktop" onClose={() => undefined} restart={async () => ({})} />)
    expect(markup).toContain('>重启电脑<')
    expect(markup).toContain('点击「立即重启」后，电脑将在约 15 秒后重启，请先保存未保存的文件。重启后请打开星芒，再次点击 Codex 桌面端的「打开」。')
    expect(markup).toContain('runtime-restart-now')
    expect(markup).not.toContain('Node.js')
  })
})

describe('renderer-v2 restart reminder', () => {
  afterEach(() => resetRestartPending())
  it('stays hidden until a runtime install has asked for a restart', () => {
    expect(renderToStaticMarkup(<RestartReminder restart={async () => ({})} />)).toBe('')
  })
  it('keeps a restart-now reminder on screen after the dialog is closed', () => {
    markRestartPending()
    expect(readRestartPending()).toBe(true)
    const markup = renderToStaticMarkup(<RestartReminder restart={async () => ({})} />)
    expect(markup).toContain('需要重启电脑')
    expect(markup).toContain('restart-reminder-now')
    expect(markup).not.toContain('runtime-restart-dialog')
  })
})
