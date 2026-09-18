import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { UpdateSnapshot } from '../types'
import { UpdatePage } from './UpdatePage'

const disabledSnapshot: UpdateSnapshot = {
  phase: 'disabled',
  currentVersion: '0.1.12',
  availableVersion: null,
  releaseName: null,
  releaseNotesText: null,
  checkedAt: null,
  progress: null,
  error: null,
  development: true,
}

describe('UpdatePage build-mode status', () => {
  it('distinguishes a local development package from the free distribution updater', () => {
    const markup = renderToStaticMarkup(
      <UpdatePage
        state={disabledSnapshot}
        busy={false}
        onCheck={vi.fn()}
        onDownload={vi.fn()}
        onInstall={vi.fn()}
      />,
    )

    expect(markup).toContain('本地开发包不检查更新')
    expect(markup).toContain('免费分发包会启用自动更新，需同步发布完整更新文件')
  })

  it('tells the user that an unsigned channel verifies no installer signature', () => {
    const signed: UpdateSnapshot = { ...disabledSnapshot, development: false, phase: 'available', availableVersion: '1.0.0' }
    const unsigned: UpdateSnapshot = { ...signed, unsignedChannel: true }

    expect(renderToStaticMarkup(<UpdatePage state={signed} busy={false} onCheck={vi.fn()} onDownload={vi.fn()} onInstall={vi.fn()} />))
      .not.toContain('updates-channel-unsigned')
    const markup = renderToStaticMarkup(<UpdatePage state={unsigned} busy={false} onCheck={vi.fn()} onDownload={vi.fn()} onInstall={vi.fn()} />)
    expect(markup).toContain('data-testid="updates-channel-unsigned"')
    expect(markup).toContain('安装包签名未校验')
    expect(markup).toContain('SHA-512')
  })

  it('offers distinct recheck and download retry paths only when retry is supported', () => {
    const state: UpdateSnapshot = { ...disabledSnapshot, development: false, phase: 'error', availableVersion: '1.0.0', error: { code: 'NETWORK', message: '下载失败' } }
    const markup = renderToStaticMarkup(<UpdatePage state={state} busy={false} onCheck={vi.fn()} onDownload={vi.fn()} onRetryDownload={vi.fn()} onInstall={vi.fn()} />)
    expect(markup).toContain('重新检查更新')
    expect(markup).toContain('重新下载')
    expect(markup).toContain('role="alert"')
  })

  it('never renders NaN or out-of-range download progress', () => {
    const state: UpdateSnapshot = { ...disabledSnapshot, development: false, phase: 'downloading', progress: { percent: Number.NaN, bytesPerSecond: 0, transferred: 0, total: 100 } }
    const markup = renderToStaticMarkup(<UpdatePage state={state} busy={false} onCheck={vi.fn()} onDownload={vi.fn()} onInstall={vi.fn()} />)
    expect(markup).not.toContain('NaN')
    expect(markup).toContain('正在准备下载')
  })
})
